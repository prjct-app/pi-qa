import { writeFile } from 'node:fs/promises';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { deriveContract, fingerprintText, sanitizeContract, ticketStale, type IntentContext } from './contract.ts';
import { evaluateEvidence } from './evaluate.ts';
import type { EvaluatorClient } from './evaluator.ts';
import { createSdkEvaluator } from './sdk-evaluator.ts';
import { formatReport } from './report.ts';
import { sdkRunner, type QaRunner, type ThinkingLevel } from './runner.ts';
import type { EvaluationContract, QaRunRecord, ReviewerReport, TesterReport } from './schema.ts';
import { checkContract, emptyReviewer, emptyTester } from './schema.ts';
import { captureSnapshot, currentFingerprint, type CapturedSnapshot } from './snapshot.ts';
import { prepareRunDir, readLatest, readRun, writeEval, writeLatest, writeRun } from './store.ts';
import { agentHome, loadSettings, prjctHome, type QaSettings } from './settings.ts';
import { decideVerdict } from './verdict.ts';
import { materializeWorkspace } from './workspace.ts';
import type { GitExec } from './git.ts';
import { checkReviewerReport, checkTesterReport } from './schema.ts';
import { recommendedActions } from './actions.ts';
import { readTicketSource } from './tickets.ts';
import { qaSurface } from './behavior.ts';
import { writeArtifacts } from './export.ts';
import type { QaProgressEvent } from './progress.ts';

export type OrchestrateInput = {
  cwd: string;
  intent: IntentContext;
  pendingContract?: unknown;
  base?: string;
  model: { provider: string; id: string };
  thinkingLevel?: ThinkingLevel;
  modelRegistry?: Pick<ModelRegistry, 'find' | 'streamSimple'>;
  agentDir?: string;
  settings?: QaSettings;
  runner?: QaRunner;
  evaluator?: EvaluatorClient;
  git?: GitExec;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  home?: string;
  extensionPaths?: string[];
  now?: () => string;
  /** Stable run id supplied by the command layer so status shows the real id from the first moment. */
  runId?: string;
  scope?: 'change' | 'target';
  filesystemTarget?: boolean;
  targetPaths?: string[];
  onProgress?: (event: QaProgressEvent) => void;
  /** Notifies the command layer once the QA agent is in flight (or the run resolved without it). */
  onActive?: (update: { runId: string; done: Promise<unknown> }) => void;
};

export async function runQa(input: OrchestrateInput): Promise<QaRunRecord> {
  const started = Date.now();
  const settings = input.settings ?? loadSettings(input.agentDir ?? agentHome());
  input.onProgress?.({ kind: 'stage', stage: 'capturing', message: input.scope === 'target' ? 'Capturing available evidence for the QA target…' : 'Capturing the current change…' });
  const evidence = await captureSnapshot(input.cwd, { git: input.git, settings, base: input.base, now: input.now, runId: input.runId, scope: input.scope, filesystemTarget: input.filesystemTarget, targetPaths: input.targetPaths });
  const surface = await qaSurface(input.cwd, input.intent.userRequest?.text ?? '', evidence.snapshot.paths);
  const captured = { ...evidence, snapshot: { ...evidence.snapshot, qaSurface: surface } };
  input.onProgress?.({ kind: 'snapshot', fingerprint: captured.snapshot.fingerprint, paths: captured.snapshot.paths.length });
  const { contract, problems } = buildContract(input.pendingContract, input.intent, captured);
  const runDir = await prepareRunDir(captured.snapshot.runId, input.home ?? prjctHome());
  await persistSnapshot(runDir, captured, contract);
  if (captured.snapshot.resolutionError) {
    input.onActive?.({ runId: captured.snapshot.runId, done: Promise.resolve() });
    return finish({
      input, captured, contract, settings, started, runDir,
      contractProblems: problems,
      reviewer: { role: 'reviewer', status: 'failed', error: captured.snapshot.resolutionError, latencyMs: 0 },
      tester: { role: 'tester', status: 'failed', error: captured.snapshot.resolutionError, latencyMs: 0 },
      reviewerReport: emptyReviewer(), testerReport: emptyTester(),
      stale: false,
    });
  }
  input.onProgress?.({ kind: 'stage', stage: 'materializing', message: 'Preparing the isolated QA workspace…' });
  const qaWorkspace = await materializeWorkspace(captured, join(runDir, 'qa'), { git: input.git });
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  input.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    input.onProgress?.({ kind: 'stage', stage: 'agents', message: 'QA is designing and executing test cases…' });
    input.onProgress?.({ kind: 'agent', role: 'tester', status: 'running' });
    const qaPromise = (input.runner ?? sdkRunner)({
      role: 'tester', snapshot: captured.snapshot, contract, workspace: qaWorkspace.path,
      artifactsDir: join(runDir, 'artifacts', 'browser'), model: input.model, thinkingLevel: input.thinkingLevel, agentDir: input.agentDir,
      timeoutMs: settings.timeoutMs, signal: controller.signal, settings, extensionPaths: input.extensionPaths,
      briefing: environmentBriefing(input.intent, qaWorkspace.notes),
      onProgress: message => input.onProgress?.({ kind: 'stage', stage: 'agents', message }),
    });
    input.onActive?.({ runId: captured.snapshot.runId, done: qaPromise.then(() => undefined, () => undefined) });
    const tester = await qaPromise;
    input.onProgress?.({ kind: 'agent', role: 'tester', status: tester.status, latencyMs: tester.latencyMs, error: tester.error });
    input.onProgress?.({ kind: 'stage', stage: 'staleness', message: 'Checking that the evaluated target is still current…' });
    const fingerprint = await currentFingerprint(input.cwd, { git: input.git, settings, base: input.base, scope: captured.snapshot.scope, filesystemTarget: Boolean(captured.snapshot.targetPaths), targetPaths: captured.snapshot.targetPaths });
    const stale = fingerprint !== captured.snapshot.fingerprint || await selectedTicketStale(contract, input.cwd);
    return finish({
      input, captured, contract, settings, started, runDir, stale,
      contractProblems: problems,
      workspaceNotes: qaWorkspace.notes.map(note => `QA workspace: ${note}`),
      reviewer: { role: 'reviewer', status: 'completed', report: emptyReviewer(), latencyMs: 0 },
      tester,
      reviewerReport: emptyReviewer(),
      testerReport: asTester(tester.report),
    });
  } finally {
    input.signal?.removeEventListener('abort', onAbort);
    await qaWorkspace.cleanup();
  }
}

export async function evaluateExisting(runId: string, input: Omit<OrchestrateInput, 'pendingContract'>): Promise<QaRunRecord> {
  input.onProgress?.({ kind: 'stage', stage: 'capturing', message: 'Loading the preserved QA evidence…' });
  const settings = input.settings ?? loadSettings(input.agentDir ?? agentHome());
  const record = await readRun(join((input.home ?? prjctHome()), 'pi-qa', 'runs', runId));
  // Re-evaluate the checkout captured by the run, not whichever cwd the new Pi session happens to use.
  const fingerprint = await currentFingerprint(record.snapshot.cwd, { git: input.git, settings, base: record.snapshot.base ?? undefined, scope: record.snapshot.scope, filesystemTarget: Boolean(record.snapshot.targetPaths), targetPaths: record.snapshot.targetPaths });
  const stale = fingerprint !== record.snapshot.fingerprint || await selectedTicketStale(record.contract, record.snapshot.cwd);
  if (stale) {
    const next = {
      ...record,
      verdict: 'STALE' as const,
      stale: true,
      explanation: 'The snapshot changed. Evaluation of the previous run does not apply.',
      nextVerification: 'Run /qa again.',
      recommendedActions: recommendedActions({ verdict: 'STALE', contract: record.contract, evaluatorAvailable: record.evaluator.available, nextVerification: 'Run /qa again.' }),
    };
    await writeEval(join((input.home ?? prjctHome()), 'pi-qa', 'runs', runId), next);
    input.onProgress?.({ kind: 'complete', record: next });
    return next;
  }
  return finish({
    input, settings, started: Date.now(),
    captured: { snapshot: { ...record.snapshot, qaSurface: record.snapshot.qaSurface ?? await qaSurface(record.snapshot.cwd, record.contract.description, record.snapshot.paths) }, blobs: new Map() },
    contract: record.contract,
    contractProblems: record.contractProblems,
    runDir: join((input.home ?? prjctHome()), 'pi-qa', 'runs', runId),
    reviewer: record.agents.reviewer,
    tester: record.agents.tester,
    reviewerReport: asReviewer(record.agents.reviewer.report),
    testerReport: asTester(record.agents.tester.report),
    stale: false,
  });
}

export { formatReport };

const selectedTicketStale = async (contract: EvaluationContract, cwd: string): Promise<boolean> => {
  if (!contract.ticketRef || !contract.ticketFingerprint) return false;
  const text = await readTicketSource(cwd, contract.ticketRef).catch(() => undefined);
  return text === undefined || ticketStale(contract, fingerprintText(text));
};

const buildContract = (pending: unknown, intent: IntentContext, captured: CapturedSnapshot): { contract: EvaluationContract; problems: string[] } => {
  if (pending) {
    if (checkContract(pending) && pending.ticketRef && pending.ticketRef !== intent.ticket?.ref) {
      return {
        contract: deriveContract(intent, captured.snapshot.paths.map(path => path.path), intent.userRequest?.english ?? intent.userRequest?.text),
        problems: ['Pending contract references a different ticket and was ignored.'],
      };
    }
    const sanitized = sanitizeContract(pending, intent);
    if (sanitized.contract.items.length) return sanitized;
    return { contract: deriveContract(intent, captured.snapshot.paths.map(path => path.path), intent.userRequest?.english ?? intent.userRequest?.text), problems: sanitized.problems };
  }
  return { contract: deriveContract(intent, captured.snapshot.paths.map(path => path.path), intent.userRequest?.english ?? intent.userRequest?.text), problems: [] };
};

const persistSnapshot = async (runDir: string, captured: CapturedSnapshot, contract: EvaluationContract): Promise<void> => {
  await writeFile(join(runDir, 'snapshot.json'), `${JSON.stringify(captured.snapshot, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(runDir, 'contract.json'), `${JSON.stringify(contract, null, 2)}\n`, { mode: 0o600 });
};

const finish = async (args: {
  input: OrchestrateInput;
  captured: CapturedSnapshot;
  contract: EvaluationContract;
  settings: QaSettings;
  started: number;
  runDir: string;
  reviewer: QaRunRecord['agents']['reviewer'];
  tester: QaRunRecord['agents']['tester'];
  reviewerReport: ReviewerReport;
  testerReport: TesterReport;
  stale: boolean;
  contractProblems?: string[];
  workspaceNotes?: string[];
}): Promise<QaRunRecord> => {
  args.input.onProgress?.({ kind: 'stage', stage: 'evaluator', message: 'Evaluating all test cases in one batch…' });
  args.input.onProgress?.({ kind: 'evaluator', status: 'running', message: 'Evaluating all test cases in one batch…' });
  const client = args.input.evaluator ?? createSdkEvaluator({ model: args.input.model, thinkingLevel: args.input.thinkingLevel, timeoutMs: args.settings.evaluationTimeoutMs, registry: args.input.modelRegistry });
  const evaluatorStarted = Date.now();
  const evaluated = await evaluateEvidence({
    snapshot: args.captured.snapshot,
    blobs: args.captured.blobs,
    contract: args.contract,
    reviewer: args.reviewerReport,
    tester: args.testerReport,
    executions: args.tester.executions,
    client,
    settings: args.settings,
    signal: args.input.signal,
  });
  const decisions = [...evaluated.testEvaluator, ...evaluated.criteria.flatMap(item => item.evaluator)];
  const evaluatorAvailable = Boolean(client) && decisions.length > 0 && decisions.every(decision => decision.label !== 'unavailable' && decision.label !== 'timeout');
  args.input.onProgress?.({ kind: 'evaluator', status: evaluatorAvailable ? 'completed' : 'unavailable', message: evaluatorAvailable ? 'Test-case evaluation complete.' : evaluated.evaluator.error ?? 'Test-case evaluation unavailable.' });
  const decided = decideVerdict({
    contract: args.contract,
    snapshot: args.captured.snapshot,
    checks: evaluated.checks,
    criteria: evaluated.criteria,
    reviewer: args.reviewer,
    tester: args.tester,
    reviewerReport: args.reviewerReport,
    testerReport: args.testerReport,
    findingEvaluator: [],
    findingImpactEvaluator: [],
    testEvaluator: evaluated.testEvaluator,
    testFailureEvaluator: [],
    stale: args.stale,
    evaluatorAvailable,
    evaluatorConfigured: Boolean(client),
    evaluatorError: evaluated.evaluator.error,
    snapshotError: args.captured.snapshot.resolutionError,
  });
  const record: QaRunRecord = {
    runId: args.captured.snapshot.runId,
    startedAt: args.captured.snapshot.capturedAt,
    finishedAt: new Date().toISOString(),
    verdict: decided.verdict,
    explanation: decided.explanation,
    nextVerification: decided.nextVerification,
    snapshot: args.captured.snapshot,
    contract: args.contract,
    agents: { reviewer: args.reviewer, tester: args.tester },
    checks: evaluated.checks,
    criteria: evaluated.criteria,
    evaluator: {
      configured: Boolean(client),
      modelPin: client?.modelPin ?? `${args.input.model.provider}/${args.input.model.id}`,
      modelActual: evaluated.evaluator.modelActual,
      available: evaluatorAvailable,
      error: evaluated.evaluator.error,
      inputTokens: evaluated.evaluator.inputTokens,
      outputTokens: evaluated.evaluator.outputTokens,
      latencyMs: Date.now() - evaluatorStarted,
    },
    unresolvedRisks: [...decided.unresolvedRisks, ...args.workspaceNotes ?? []],
    contractProblems: args.contractProblems?.length ? args.contractProblems : undefined,
    recommendedActions: recommendedActions({ verdict: decided.verdict, contract: args.contract, evaluatorAvailable, nextVerification: decided.nextVerification }),
    findingEvaluator: [],
    findingImpactEvaluator: [],
    testEvaluator: evaluated.testEvaluator,
    testFailureEvaluator: [],
    stale: args.stale,
    latencyMs: Date.now() - args.started,
  };
  args.input.onProgress?.({ kind: 'stage', stage: 'persisting', message: 'Saving the auditable QA record and artifacts…' });
  const exported = await writeArtifacts(record, join(args.runDir, 'artifacts'));
  const completeRecord: QaRunRecord = { ...record, exports: exported };
  await writeRun(args.runDir, completeRecord);
  await writeLatest(completeRecord.runId, args.input.home ?? prjctHome());
  args.input.onProgress?.({ kind: 'complete', record: completeRecord });
  return completeRecord;
};

export { readLatest };

const environmentBriefing = (intent: IntentContext, workspaceNotes: string[]): string => [
  !intent.userRequest && intent.memory ? `Project memory (${intent.memory.ref}):\n${intent.memory.text}` : '',
  intent.plan ? `Current plan (${intent.plan.ref}):\n${intent.plan.text}` : '',
  intent.ticket ? `Ticket (${intent.ticket.ref}):\n${intent.ticket.text}` : '',
  workspaceNotes.length ? `Workspace preparation:\n${workspaceNotes.join('\n')}` : '',
].filter(Boolean).join('\n\n');

const asReviewer = (value: unknown): ReviewerReport => checkReviewerReport(value) ? value : emptyReviewer();
const asTester = (value: unknown): TesterReport => checkTesterReport(value) ? value : emptyTester();
