import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deterministicChecks, testHasVerifiedExecution } from '../src/evidence.ts';
import type { ExecutionReceipt, Snapshot, TesterReport } from '../src/schema.ts';

const snapshot = { paths: [], combinedPatch: '', stagedPatch: '', unstagedPatch: '' } as unknown as Snapshot;
const reviewer = { findings: [], notes: '', blockers: [] };
const report = (executionIds?: string[]): TesterReport => ({
  tests: [{ id: 't1', command: 'npm test', cwd: '.', exitCode: 0, observed: 'all pass', assertion: 'suite passes', contractItemIds: ['U1'], executionIds }],
  notes: '',
});
const receipt: ExecutionReceipt = {
  id: 'host-1', tool: 'bash', command: 'npm test', cwd: '/tmp/workspace', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z',
  status: 'completed', exitCode: 0, outputHash: 'a'.repeat(64), outputExcerpt: 'all pass',
};

test('agent-reported command and exit code are not execution evidence without a host receipt', () => {
  const checks = deterministicChecks(snapshot, reviewer, report(), []);
  assert.equal(checks.find(check => check.kind === 'test-provenance')?.ok, false);
  assert.equal(checks.find(check => check.kind === 'test-ran')?.ok, false);
  assert.equal(checks.find(check => check.kind === 'test-exit')?.ok, false);
});

test('matching immutable host receipt verifies execution provenance', () => {
  const checks = deterministicChecks(snapshot, reviewer, report(['host-1']), [receipt]);
  assert.equal(checks.find(check => check.kind === 'test-provenance')?.ok, true);
  assert.equal(checks.find(check => check.kind === 'test-ran')?.ok, true);
  assert.equal(checks.find(check => check.kind === 'test-exit')?.ok, true);
});

test('executed case without sourced expected behavior is blocked', () => {
  const checks = deterministicChecks(snapshot, reviewer, report(['host-1']), [receipt]);
  assert.equal(checks.find(check => check.kind === 'test-definition')?.ok, false);
  assert.equal(testHasVerifiedExecution(report(['host-1']).tests[0]!, checks), false);
  const defined = { ...report(['host-1']), tests: [{ ...report(['host-1']).tests[0]!, expected: 'suite exits zero', expectedSource: 'existing_test' as const }] };
  const definedChecks = deterministicChecks(snapshot, reviewer, defined, [receipt]);
  assert.equal(definedChecks.find(check => check.kind === 'test-definition')?.ok, true);
  assert.equal(testHasVerifiedExecution(defined.tests[0]!, definedChecks), true);
});

test('host receipt identity and exit are strict while the agent procedure may summarize multiple commands', () => {
  const unknown = deterministicChecks(snapshot, reviewer, report(['forged']), [receipt]);
  const mixed = deterministicChecks(snapshot, reviewer, report(['host-1', 'forged']), [receipt]);
  const wrongCommand = deterministicChecks(snapshot, reviewer, { ...report(['host-1']), tests: [{ ...report(['host-1']).tests[0]!, command: 'npm run build' }] }, [receipt]);
  const wrongExit = deterministicChecks(snapshot, reviewer, { ...report(['host-1']), tests: [{ ...report(['host-1']).tests[0]!, exitCode: 1 }] }, [receipt]);
  assert.equal(unknown.find(check => check.kind === 'test-provenance')?.ok, false);
  assert.equal(mixed.find(check => check.kind === 'test-provenance')?.ok, true);
  assert.match(mixed.find(check => check.kind === 'test-provenance')?.detail ?? '', /Ignored unknown receipt/);
  assert.equal(wrongCommand.find(check => check.kind === 'test-provenance')?.ok, true);
  assert.equal(wrongExit.find(check => check.kind === 'test-provenance')?.ok, false);
});
