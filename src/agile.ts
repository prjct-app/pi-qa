import type { TestRecord } from './schema.ts';

const DEVELOPER_KINDS = new Set(['unit', 'static', 'build']);

const isGating = (test: TestRecord, required: ReadonlySet<string>): boolean =>
  !test.skipped
  && test.expectedSource !== 'inferred'
  && !DEVELOPER_KINDS.has(test.kind ?? '')
  && test.contractItemIds.some(id => required.has(id));

const prefer = (next: TestRecord, current: TestRecord): boolean =>
  next.exitCode === 0 && current.exitCode !== 0;

/**
 * One public-interface case per required item. A passing case wins over a failed extra probe.
 * Developer checks and inferred cases never decide the verdict.
 */
export function decisiveCases(tests: readonly TestRecord[], requiredIds: readonly string[]): TestRecord[] {
  const required = new Set(requiredIds);
  const chosen = new Map<string, TestRecord>();
  for (const test of tests) {
    if (!isGating(test, required)) continue;
    const key = test.contractItemIds.filter(id => required.has(id)).sort().join('|');
    const current = chosen.get(key);
    if (!current || prefer(test, current)) chosen.set(key, test);
  }
  return [...chosen.values()];
}
