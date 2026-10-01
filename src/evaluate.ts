import { deterministicChecks, testHasVerifiedExecution } from './evidence.ts';
import { evaluateQaBatch, type JevClient, type JsonState, type QaBatchSubject } from './jev.ts';
import type { CriterionEvaluation, EvaluationContract, ExecutionReceipt, JevDecision, ReviewerReport, Snapshot, TesterReport } from './schema.ts';
import type { QaSettings } from './settings.ts';
import { clip } from './text.ts';
import { behavioralTest } from './behavior.ts';
import type { SnapshotBlobs } from './snapshot.ts';

export async function evaluateEvidence(input: {
  snapshot: Snapshot;
  blobs: SnapshotBlobs;
  contract: EvaluationContract;
  reviewer: ReviewerReport;
  tester: TesterReport;
  executions?: ExecutionReceipt[];
  client?: JevClient;
  settings: QaSettings;
  signal?: AbortSignal;
}): Promise<{
  criteria: CriterionEvaluation[];
  findingJev: JevDecision[];
  findingImpactJev: JevDecision[];
  testJev: JevDecision[];
  testFailureJev: JevDecision[];
  checks: ReturnType<typeof deterministicChecks>;
  jev: { modelActual?: string; error?: string; inputTokens: number; outputTokens: number };
}> {
  const checks = deterministicChecks(input.snapshot, { findings: [], notes: '', blockers: [] }, input.tester, input.executions);
  const tests = input.tester.tests.filter(test => !test.skipped && testHasVerifiedExecution(test, checks));
  const testSubjects: QaBatchSubject[] = tests.map((test, index) => ({
    key: `test_${index}`,
    subjectId: test.id,
    question: 'test',
    prompt: `Does the host-recorded evidence support, contradict, or fail to establish the expected behavior for test case ${test.id}?`,
  }));
  const criterionSubjects: QaBatchSubject[] = input.contract.items.map((item, index) => ({
    key: `criterion_${index}`,
    subjectId: item.id,
    question: 'criterion',
    prompt: `Do the executed black-box scenarios support, contradict, or fail to establish behavior ${item.id}? Code review, unit tests, lint and builds alone do not establish application behavior. For a web flow require browser observations; for an API require real endpoint requests and responses.`,
  }));
  const subjects = [...testSubjects, ...criterionSubjects];
  const state = batchState(input.contract, tests, input.executions, input.settings);
  const batch = input.client
    ? await evaluateQaBatch(input.client, state, subjects, input.settings, input.signal)
    : {
        decisions: subjects.map(subject => unavailable(subject.subjectId, subject.question, input.settings.jevModel)),
        error: undefined,
        inputTokens: 0,
        outputTokens: 0,
      };
  const testJev = batch.decisions.filter(decision => decision.question === 'test');
  const criteria = input.contract.items.map(item => criterionResult(item, tests, batch.decisions));
  return {
    criteria,
    findingJev: [],
    findingImpactJev: [],
    testJev,
    testFailureJev: [],
    checks,
    jev: {
      modelActual: 'modelActual' in batch ? batch.modelActual : undefined,
      error: batch.error,
      inputTokens: batch.inputTokens,
      outputTokens: batch.outputTokens,
    },
  };
}

const batchState = (contract: EvaluationContract, tests: TesterReport['tests'], executions: ExecutionReceipt[] | undefined, settings: QaSettings): JsonState => ({
  mission: contract.description,
  qaRole: 'Behavioral QA, not code review. Developer checks are supporting evidence only. Require using the running application: browser journeys for web, real HTTP requests and regression scenarios for endpoints, public commands for CLI tooling. A tool output alone does not prove the claimed effect.',
  requirements: contract.items.map(item => ({ id: item.id, behavior: clip(item.text, settings.excerptChars), source: item.source, required: item.required, observe: clip(item.observe, settings.excerptChars) })),
  testCases: tests.map(test => ({
    id: test.id,
    kind: test.kind ?? 'other',
    expected: clip(test.expected ?? '', settings.excerptChars),
    expectedSource: test.expectedSource ?? 'unspecified',
    assertion: clip(test.assertion, settings.excerptChars),
    procedure: clip(test.command, 500),
    observedClaim: clip(test.observed, settings.excerptChars),
    reportedExitCode: test.exitCode,
    requirementIds: test.contractItemIds.join(','),
    hostExecutions: receiptsFor(test.executionIds, executions).map(receipt => ({
      tool: receipt.tool,
      command: clip(receipt.command, 500),
      status: receipt.status,
      exitCode: receipt.exitCode,
      output: clip(receipt.outputExcerpt, settings.excerptChars),
      outputHash: receipt.outputHash,
      artifactHashes: receipt.artifactHashes?.join(',') ?? '',
    })),
  })),
});

const criterionResult = (
  item: EvaluationContract['items'][number],
  tests: TesterReport['tests'],
  decisions: JevDecision[],
): CriterionEvaluation => {
  const linked = tests.filter(test => behavioralTest(test) && test.contractItemIds.includes(item.id));
  const decision = decisions.find(value => value.question === 'criterion' && value.subjectId === item.id);
  const label = decision?.label === 'supports' || decision?.label === 'contradicts' || decision?.label === 'insufficient_evidence'
    ? decision.label
    : 'insufficient_evidence';
  return {
    id: item.id,
    text: item.text,
    source: item.source,
    required: item.required,
    label,
    reason: reasonOf(decision),
    jev: decision ? [decision] : [],
    tests: linked.map(test => test.id),
    findings: [],
  };
};

const reasonOf = (decision: JevDecision | undefined): string => {
  if (!decision) return 'No evaluator decision was produced.';
  if (decision.label === 'timeout') return 'Evaluation timed out.';
  if (decision.label === 'low_confidence') return `Evaluator confidence ${decision.confidence} is below threshold.`;
  if (decision.label === 'unavailable') return decision.error ? `Evaluation unavailable: ${decision.error}` : 'Evaluation unavailable.';
  if (decision.label === 'supports') return 'Evaluated test evidence supports the expected behavior.';
  if (decision.label === 'contradicts') return 'Evaluated test evidence contradicts the expected behavior.';
  return 'Evaluated test evidence is insufficient.';
};

const unavailable = (subjectId: string, question: string, model: string): JevDecision => ({
  subjectId, question, label: 'unavailable', confidence: 0, model, inputTokens: 0, outputTokens: 0,
});

const receiptsFor = (ids: string[] | undefined, executions: ExecutionReceipt[] | undefined): ExecutionReceipt[] =>
  (ids ?? []).map(id => executions?.find(receipt => receipt.id === id)).filter((receipt): receipt is ExecutionReceipt => Boolean(receipt));
