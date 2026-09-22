import { randomUUID } from 'node:crypto';
import { createAgentSession, createBashTool, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import {
  AGENT_ROLES,
  checkReviewerReport,
  reviewerProblems,
  testerProblems,
  checkTesterReport,
  emptyReviewer,
  emptyTester,
  REVIEWER_REPORT_TOOL,
  TESTER_REPORT_TOOL,
  type AgentOutcome,
  type AgentRole,
  type EvaluationContract,
  type ExecutionReceipt,
  type Snapshot,
} from './schema.ts';
import { reviewerParams, reviewerPrompt, testerParams, testerPrompt } from './agents.ts';
import { agentHome, type QaSettings } from './settings.ts';
import { clip, plain, sha256Hex } from './text.ts';
import { createQaBrowser } from './browser.ts';

export type RunnerInput = {
  role: AgentRole;
  snapshot: Snapshot;
  contract: EvaluationContract;
  workspace: string;
  artifactsDir: string;
  model: { provider: string; id: string };
  agentDir?: string;
  timeoutMs: number;
  signal: AbortSignal;
  settings: QaSettings;
  extensionPaths?: string[];
  briefing?: string;
  onProgress?: (message: string) => void;
};

export type QaRunner = (input: RunnerInput) => Promise<AgentOutcome>;

const READ_ONLY = ['read', 'grep', 'find', 'ls'] as const;

/** Dedicated in-process Pi SDK runner. Does not use pi-subagents agent_delegate. */
export const sdkRunner: QaRunner = async input => {
  const started = Date.now();
  const reportSlot: { report?: unknown; error?: string } = {};
  const browser = input.role === 'tester' ? createQaBrowser(input.artifactsDir) : undefined;
  const bashReceipts: ExecutionReceipt[] = [];
  const bash = input.role === 'tester' ? auditedBash(input.workspace, bashReceipts) : undefined;
  const settings = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: input.workspace,
    agentDir: input.agentDir ?? agentHome(),
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: input.extensionPaths ?? [],
    systemPromptOverride: () => input.role === 'reviewer'
      ? reviewerPrompt(input.snapshot, input.contract, input.settings)
      : testerPrompt(input.snapshot, input.contract, input.settings, input.briefing),
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: input.workspace,
    agentDir: input.agentDir ?? agentHome(),
    thinkingLevel: 'off',
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(input.workspace),
    settingsManager: settings,
    tools: input.role === 'reviewer'
      ? [...READ_ONLY, REVIEWER_REPORT_TOOL]
      : [...READ_ONLY, 'bash', TESTER_REPORT_TOOL],
    customTools: [reportTool(input.role, reportSlot), ...(bash ? [bash] : []), ...(browser ? [browser.tool] : [])],
  });
  const unsubscribe = session.subscribe(event => {
    if (event.type === 'tool_execution_start') input.onProgress?.(toolActivity(event.toolName, event.args));
    if (event.type === 'tool_execution_end') input.onProgress?.(`${event.toolName === TESTER_REPORT_TOOL ? 'Test cases finalized' : `${event.toolName} completed`}${event.isError ? ' with an error' : ''}.`);
  });
  const model = session.modelRuntime.getModel(input.model.provider, input.model.id);
  if (!model) throw new Error(`Child model ${input.model.provider}/${input.model.id} is unavailable. The QA agents use the parent Pi authentication.`);
  await session.setModel(model);
  const timer = AbortSignal.timeout(input.timeoutMs);
  const signal = AbortSignal.any([input.signal, timer]);
  const onAbort = () => { void session.abort(); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await session.prompt('Evaluate the snapshot against the contract and submit your report.');
    if (!reportSlot.report && !signal.aborted) {
      await session.prompt('Submit the structured report tool now. Do not continue investigating.');
    }
  } catch (error) {
    reportSlot.error = error instanceof Error ? error.message : String(error);
  } finally {
    signal.removeEventListener('abort', onAbort);
    await browser?.close();
    unsubscribe();
    session.dispose();
  }
  const latencyMs = Date.now() - started;
  const executions = input.role === 'tester' ? [...bashReceipts, ...browser?.receipts ?? []] : undefined;
  if (input.signal.aborted) return { role: input.role, status: 'canceled', error: 'Canceled.', executions, latencyMs };
  if (timer.aborted) return { role: input.role, status: 'timeout', error: 'Agent timed out.', executions, latencyMs };
  if (input.role === 'reviewer' && checkReviewerReport(reportSlot.report)) {
    return { role: 'reviewer', status: 'completed', report: reportSlot.report, latencyMs };
  }
  if (input.role === 'tester' && checkTesterReport(reportSlot.report)) {
    const artifacts = [...reportSlot.report.artifacts ?? [], ...browser?.artifacts ?? []].filter((artifact, index, all) => all.findIndex(candidate => candidate.hash === artifact.hash) === index);
    return { role: 'tester', status: 'completed', report: { ...reportSlot.report, artifacts }, executions, latencyMs };
  }
  return {
    role: input.role,
    status: 'failed',
    error: reportSlot.error ?? 'Agent finished without a valid structured report.',
    report: input.role === 'reviewer' ? emptyReviewer() : emptyTester(),
    executions,
    latencyMs,
  };
};

export async function runBothAgents(input: Omit<RunnerInput, 'role' | 'workspace'> & { workspace?: string; workspaces?: Record<AgentRole, string>; runner?: QaRunner; onOutcome?: (outcome: AgentOutcome) => void }): Promise<{ reviewer: AgentOutcome; tester: AgentOutcome }> {
  const runner = input.runner ?? sdkRunner;
  // AGENT_ROLES is a fixed [reviewer, tester] tuple, so exactly these two agents always launch.
  const launch = async (role: AgentRole): Promise<AgentOutcome> => {
    try {
      const workspace = input.workspaces?.[role] ?? input.workspace;
      if (!workspace) throw new Error(`No isolated workspace was provided for ${role}.`);
      const result = await runner({ ...input, role, workspace });
      input.onOutcome?.(result);
      return result;
    } catch (error) {
      const failed: AgentOutcome = { role, status: 'failed', error: clip(String(error), 500), latencyMs: 0 };
      input.onOutcome?.(failed);
      return failed;
    }
  };
  const settled = await Promise.all(AGENT_ROLES.map(launch));
  return { reviewer: settled[0]!, tester: settled[1]! };
}

const toolActivity = (toolName: string, args: Record<string, unknown>): string => {
  if (toolName === TESTER_REPORT_TOOL) return 'Finalizing test cases…';
  if (toolName === 'bash') return `Running command: ${redact(clip(plain(args.command ?? ''), 140))}`;
  if (toolName === 'read') return `Reading ${clip(plain(args.path ?? 'file'), 120)}…`;
  if (toolName === 'qa_browser') return `Browser: ${clip(plain(args.action ?? 'interaction'), 60)}…`;
  return `Using ${toolName}…`;
};

const redact = (value: string): string => value.replace(/((?:api[_-]?key|token|secret|password)\s*=\s*)\S+/gi, '$1[redacted]');

const auditedBash = (cwd: string, receipts: ExecutionReceipt[]) => {
  const base = createBashTool(cwd);
  const execute: typeof base.execute = async (...args) => {
    const [toolCallId, params, signal] = args;
    const id = `bash-${toolCallId}-${randomUUID()}`;
    const startedAt = new Date().toISOString();
    try {
      const result = await base.execute(...args);
      const output = toolText(result.content);
      receipts.push(receipt({ id, tool: 'bash', command: params.command, cwd, startedAt, status: 'completed', exitCode: 0, output }));
      return { ...result, content: [...result.content, { type: 'text' as const, text: `QA execution receipt: ${id}` }] };
    } catch (error) {
      const output = error instanceof Error ? error.message : String(error);
      const matched = /Command exited with code (-?\d+)/.exec(output);
      receipts.push(receipt({ id, tool: 'bash', command: params.command, cwd, startedAt, status: signal?.aborted ? 'canceled' : 'failed', exitCode: matched ? Number(matched[1]) : null, output }));
      throw new Error(`${output}\nQA execution receipt: ${id}`);
    }
  };
  return { ...base, execute };
};

const receipt = (input: Omit<ExecutionReceipt, 'finishedAt' | 'outputHash' | 'outputExcerpt'> & { output: string }): ExecutionReceipt => ({
  id: input.id,
  tool: input.tool,
  command: input.command,
  cwd: input.cwd,
  startedAt: input.startedAt,
  finishedAt: new Date().toISOString(),
  status: input.status,
  exitCode: input.exitCode,
  outputHash: sha256Hex(input.output),
  outputExcerpt: clip(plain(input.output), 4_000),
  artifactHashes: input.artifactHashes,
});

const toolText = (content: Array<{ type: string; text?: string }>): string => content.map(item => item.type === 'text' ? item.text ?? '' : '').join('\n');

export const reportTool = (role: AgentRole, slot: { report?: unknown; error?: string }) => ({
  name: role === 'reviewer' ? REVIEWER_REPORT_TOOL : TESTER_REPORT_TOOL,
  label: role === 'reviewer' ? 'Reviewer report' : 'Tester report',
  description: 'Submit the structured QA report for this agent. Call once when finished.',
  parameters: role === 'reviewer' ? reviewerParams : testerParams,
  execute: async (_toolCallId: string, params: unknown) => {
    // Validated here so the agent fixes its own report while it still has the
    // evidence; a thrown error reaches it as the tool result instead of ending the run.
    const valid = role === 'reviewer' ? checkReviewerReport(params) : checkTesterReport(params);
    if (!valid) {
      const problems = (role === 'reviewer' ? reviewerProblems(params) : testerProblems(params)).slice(0, 8);
      slot.error = `Agent report failed schema validation: ${problems.join('; ')}`;
      throw new Error(`Report not recorded. Fix and call ${role === 'reviewer' ? REVIEWER_REPORT_TOOL : TESTER_REPORT_TOOL} again: ${problems.join('; ')}`);
    }
    slot.report = params;
    slot.error = undefined;
    return { content: [{ type: 'text' as const, text: 'Report recorded.' }], details: {}, terminate: true };
  },
});
