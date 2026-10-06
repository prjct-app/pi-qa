import type { QaRunRecord, TestRecord } from './schema.ts';

export type TestOutcome = 'PASS' | 'FAIL' | 'BLOCKED';

export const testOutcome = (record: QaRunRecord, test: TestRecord): TestOutcome => {
  if (test.skipped) return 'BLOCKED';
  const defined = record.checks.some(check => check.subjectId === test.id && check.kind === 'test-definition' && check.ok);
  const provenance = record.checks.some(check => check.subjectId === test.id && check.kind === 'test-provenance' && check.ok);
  if (!defined || !provenance) return 'BLOCKED';
  const decision = record.testEvaluator?.find(value => value.subjectId === test.id && value.question === 'test');
  if (decision?.label === 'supports') return 'PASS';
  if (decision?.label === 'contradicts') return 'FAIL';
  return 'BLOCKED';
};
