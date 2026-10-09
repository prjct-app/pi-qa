import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrateStoredRun } from '../src/store.ts';

test('historical QA reports keep their evidence without an obsolete setup action', () => {
  const decision = { subjectId: 'T1', label: 'supports', model: 'historical-model' };
  const original = { verdict: 'PASS', jev: { available: true, modelPin: 'historical-model', keyFingerprint: 'old' },
    criteria: [{ id: 'U1', text: 'Original criterion', jev: [decision] }], testJev: [decision],
    recommendedActions: [{ kind: 'setup_jev' }, { kind: 'export' }] };
  const migrated = migrateStoredRun(original);
  assert.equal(migrated.verdict, 'PASS');
  assert.equal(migrated.evaluator.modelPin, 'historical-model');
  assert.deepEqual(migrated.testEvaluator, [decision]);
  assert.deepEqual(migrated.criteria[0]?.evaluator, [decision]);
  assert.deepEqual(migrated.recommendedActions, [{ kind: 'export' }]);
  assert.equal('jev' in migrated, false);
  assert.equal('keyFingerprint' in migrated.evaluator, false);
  assert.deepEqual(migrateStoredRun(migrated), migrated);
  assert.ok(original.jev.keyFingerprint, 'the stored historical record is not mutated');
});
