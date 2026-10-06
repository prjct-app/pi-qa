import type { AgentOutcome, CriterionEvaluation, DeterministicCheck, EvaluationContract, EvaluatorDecision, QaVerdict, ReviewerReport, Snapshot, TesterReport } from './schema.ts';
import { behaviorGap } from './behavior.ts';

export type VerdictInput = {
  contract: EvaluationContract;
  snapshot?: Snapshot;
  checks?: DeterministicCheck[];
  criteria: CriterionEvaluation[];
  reviewer: AgentOutcome;
  tester: AgentOutcome;
  reviewerReport: ReviewerReport;
  testerReport: TesterReport;
  findingEvaluator: EvaluatorDecision[];
  findingImpactEvaluator?: EvaluatorDecision[];
  testEvaluator?: EvaluatorDecision[];
  testFailureEvaluator?: EvaluatorDecision[];
  stale: boolean;
  evaluatorAvailable: boolean;
  evaluatorConfigured?: boolean;
  evaluatorError?: string;
  snapshotError?: string;
};

export function decideVerdict(input: VerdictInput): { verdict: QaVerdict; explanation: string; nextVerification: string; unresolvedRisks: string[] } {
  if (input.stale) {
    return result('STALE', 'The worktree or ticket changed after the snapshot was captured. This result does not apply to the current diff.', 'Run /qa again on the current snapshot.', ['Snapshot is stale.']);
  }
  if (input.snapshotError) {
    return result('NOT_VERIFIED', input.snapshotError, 'Provide a local --base <ref> or make a change to evaluate.', [input.snapshotError]);
  }
  const failedChecks = substantiatedProductFailures(input);
  const contradicted = input.criteria.filter(item => item.required && item.source !== 'inferred_from_diff' && item.label === 'contradicts');
  if (failedChecks.length || contradicted.length) {
    const reasons = [
      ...failedChecks.map(id => `Test case ${id} demonstrates the required behavior failed.`),
      ...contradicted.map(item => `Required behavior ${item.id} is contradicted.`),
    ];
    return result('FAIL', reasons.join(' '), nextFail(input), reasons);
  }
  if (input.tester.status !== 'completed') {
    return result('NOT_VERIFIED', `QA agent ${input.tester.status}. Partial test evidence was kept.`, 'Re-run /qa, or inspect the preserved test cases.', [`QA agent ${input.tester.status}`]);
  }
  const required = input.criteria.filter(item => item.required && item.source !== 'inferred_from_diff');
  if (!input.evaluatorAvailable) {
    if (input.evaluatorConfigured === false) {
      return result('NOT_VERIFIED', 'QA completed, but the selected Pi model is unavailable.', 'Select an available model in Pi, then /qa evaluate this run.', ['Pi model unavailable']);
    }
    if (input.evaluatorError) {
      return result('NOT_VERIFIED', `QA completed, but evaluation failed: ${input.evaluatorError}`, 'Restore the selected Pi model connection, then /qa evaluate this run.', ['Evaluator unavailable']);
    }
    const missingTarget = input.snapshot?.scope === 'target' && input.snapshot.paths.length === 0;
    const unverifiedExecution = input.testerReport.tests.some(test => test.skipped
      || !(input.checks ?? []).some(check => check.subjectId === test.id && check.kind === 'test-provenance' && check.ok)
      || !(input.checks ?? []).some(check => check.subjectId === test.id && check.kind === 'test-definition' && check.ok));
    if (missingTarget || unverifiedExecution) {
      return result(
        'NOT_VERIFIED',
        'The captured test evidence is incomplete. Re-evaluating this snapshot cannot establish the requested behavior.',
        missingTarget
          ? 'Provide an explicit target with /qa --target <path> (or a URL in the mission), restore the selected Pi model, then run fresh /qa. Do not evaluate this snapshot.'
          : 'Resolve the skipped or unverified test capability, restore the selected Pi model, then run fresh /qa. Do not evaluate this snapshot.',
        [missingTarget ? 'No target captured' : 'Test case blocked'],
      );
    }
    return result('NOT_VERIFIED', 'Deterministic evidence did not fully establish the requested behavior; semantic evaluation is unavailable.', 'Add or clarify the blocked test case, then run /qa again.', ['Semantic evaluation unavailable']);
  }
  const unresolvedChecks = input.testerReport.tests.filter(test =>
    !test.skipped && test.exitCode !== 0 && !failedChecks.includes(test.id),
  );
  if (unresolvedChecks.length) {
    const first = unresolvedChecks[0]!;
    return result(
      'NOT_VERIFIED',
      `Failed or blocked checks were not established as product defects: ${unresolvedChecks.map(test => test.id).join(', ')}.`,
      first.reproduction ?? `Diagnose ${first.id}, reproduce it once, and gather evidence that separates product behavior from test/environment failure.`,
      unresolvedChecks.map(test => `${test.id}: ${test.observed}`),
    );
  }
  if (required.length === 0) {
    return result('NOT_VERIFIED', 'No required explicit criteria. Inferred items are not proof of unstated intent.', 'State the intended behavior, or attach a ticket, then re-run /qa.', ['No explicit required criteria']);
  }
  const weak = required.filter(item => item.label !== 'supports');
  if (weak.length) {
    return result('NOT_VERIFIED', `Required criteria without sufficient supporting evidence: ${weak.map(item => item.id).join(', ')}.`, nextWeak(weak), weak.map(item => `${item.id}: ${item.reason}`));
  }
  const unasserted = required.filter(item => !item.tests.length);
  if (unasserted.length) {
    return result('NOT_VERIFIED', `Tests did not assert required behavior: ${unasserted.map(item => item.id).join(', ')}. Green exits are not enough.`, `Add a check that asserts ${unasserted[0]!.id}.`, unasserted.map(item => `${item.id} was not asserted`));
  }
  const unsupportedCases = input.testerReport.tests.filter(test => !test.skipped && !(input.testEvaluator ?? []).some(decision => decision.subjectId === test.id && decision.question === 'test' && decision.label === 'supports'));
  if (unsupportedCases.length) {
    return result('NOT_VERIFIED', `Evaluator did not support test case(s): ${unsupportedCases.map(test => test.id).join(', ')}.`, `Clarify or rerun ${unsupportedCases[0]!.id}.`, unsupportedCases.map(test => `${test.id}: evaluator did not support expected behavior`));
  }
  const gap = behaviorGap(input.snapshot, input.tester, input.testerReport, input.checks ?? []);
  if (gap) return result('NOT_VERIFIED', gap, 'Run fresh /qa and exercise the application through its public interface. Do not substitute developer checks.', [gap]);
  return result('PASS', 'All required behaviors have supporting test evidence and the required test cases passed.', 'No further verification required for this snapshot.', []);
}

const substantiatedProductFailures = (input: VerdictInput): string[] =>
  input.testerReport.tests.filter(test =>
    !test.skipped
    && (input.checks ?? []).some(check => check.subjectId === test.id && check.kind === 'test-provenance' && check.ok)
    && (input.checks ?? []).some(check => check.subjectId === test.id && check.kind === 'test-definition' && check.ok)
    && (input.testEvaluator ?? []).some(decision => decision.subjectId === test.id && decision.question === 'test' && decision.label === 'contradicts'),
  ).map(test => test.id);

const nextFail = (input: VerdictInput): string => {
  const test = input.testerReport.tests.find(item => !item.skipped && item.exitCode !== 0);
  if (test) return `Fix the failure of \`${test.command}\` and re-run /qa.`;
  return 'Resolve the contradicted criterion and re-run /qa.';
};

const nextWeak = (weak: CriterionEvaluation[]): string =>
  `Produce a check that actually asserts ${weak[0]!.id}: ${weak[0]!.text}`;

const result = (verdict: QaVerdict, explanation: string, nextVerification: string, unresolvedRisks: string[]) =>
  ({ verdict, explanation, nextVerification, unresolvedRisks });
