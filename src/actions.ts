import type { EvaluationContract, QaRecommendedAction, QaVerdict } from './schema.ts';

export const recommendedActions = (input: {
  verdict: QaVerdict;
  contract: EvaluationContract;
  evaluatorAvailable: boolean;
  nextVerification: string;
}): QaRecommendedAction[] => {
  const copy = action('copy_prompt', 'Copy non-passing cases', 'Copy a compact agent handoff containing only FAIL/BLOCKED cases and their host evidence.', false);
  if (input.verdict === 'STALE') return [action('rerun', 'Run QA again', 'The captured target changed.', true), copy];
  const exportAction = action('export', 'Export report and test results', 'Preserve the auditable report, JSON evidence, and JUnit results.', false);
  const ticket = input.contract.ticketRef ? [action('comment_ticket', `Comment ${input.contract.ticketRef}`, 'Share the verdict, checks, and next action on the source ticket.', input.verdict === 'PASS')] : [];
  if (input.verdict === 'PASS') return [...ticket, copy, exportAction, action('rerun', 'Run again', 'Repeat QA against a fresh target when needed.', false)];
  if (input.verdict === 'FAIL') return [
    action('create_defect', 'Prepare defect', 'Generate a reproducible defect with impact, evidence, and expected behavior.', true),
    ...ticket,
    copy,
    exportAction,
    action('rerun', 'Re-run after fix', 'Capture a new target and verify the correction.', false),
  ];
  return [
    action('request_input', 'Resolve missing verification', input.nextVerification, true),
    ...ticket,
    copy,
    exportAction,
    action('rerun', 'Retry QA', 'Run again after resolving the blocker.', false),
  ];
};

const action = (kind: QaRecommendedAction['kind'], label: string, reason: string, primary: boolean): QaRecommendedAction => ({
  id: kind,
  kind,
  label,
  reason,
  primary,
});
