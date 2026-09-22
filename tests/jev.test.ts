import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateEvidence } from '../src/evaluate.ts';
import { defaultSettings } from '../src/settings.ts';
import { fakeJev } from './fixtures/fakes.ts';
import type { EvaluationContract, ExecutionReceipt, Snapshot, TesterReport } from '../src/schema.ts';

const snapshot = (): Snapshot => ({
  runId: 'run', capturedAt: '2026-01-01T00:00:00.0Z', cwd: '/tmp', branch: 'main', head: 'abc', base: 'def', baseKind: 'worktree', fingerprint: 'f'.repeat(64), dirty: true,
  paths: [{ path: 'src.js', status: 'M', kind: 'text', hash: 'h1' }], stagedPatch: '', unstagedPatch: '', combinedPatch: '@@\n+change\n', untracked: [], unsupported: [],
});

const contract = (): EvaluationContract => ({
  description: 'Verify extension',
  items: [
    { id: 'U1', text: 'extension loads', source: 'user_request', sourceRef: 'command:/qa', required: true, observe: 'load test' },
    { id: 'U2', text: 'status responds', source: 'user_request', sourceRef: 'command:/qa', required: true, observe: 'command test' },
  ],
  invariants: [], regressionRisks: [], definitionOfReady: [], definitionOfDone: [],
});

const tester = (): TesterReport => ({
  tests: [
    { id: 't1', command: 'npm test', cwd: '.', exitCode: 0, expected: 'extension loads', expectedSource: 'existing_test', observed: 'pass', assertion: 'load', contractItemIds: ['U1'], executionIds: ['r1'] },
    { id: 't2', command: 'pi /qa status', cwd: '.', exitCode: 0, expected: 'status responds', expectedSource: 'user', observed: 'response', assertion: 'status', contractItemIds: ['U2'], executionIds: ['r2'] },
  ], notes: '',
});

const receipts = (): ExecutionReceipt[] => tester().tests.map((item, index) => ({
  id: item.executionIds![0]!, tool: 'bash', command: item.command, cwd: '/tmp', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z',
  status: 'completed', exitCode: 0, outputHash: String(index + 1).repeat(64), outputExcerpt: item.observed,
}));

const input = () => ({
  snapshot: snapshot(), blobs: new Map(), contract: contract(), reviewer: { findings: [], notes: '', blockers: [] }, tester: tester(), executions: receipts(), settings: defaultSettings(),
});

test('all test cases and requirements are evaluated in one Jev request', async () => {
  const calls: unknown[] = [];
  const base = fakeJev({ test: 'supports', criterion: 'supports' })('k'.repeat(20), defaultSettings());
  const client = { ...base, systemOne: (async request => { calls.push(request); return base.systemOne(request); }) as typeof base.systemOne };
  const result = await evaluateEvidence({ ...input(), client });
  assert.equal(calls.length, 1);
  const request = calls[0] as { questions: Record<string, unknown>; state: { testCases: unknown[]; requirements: unknown[] } };
  assert.deepEqual(Object.keys(request.questions), ['test_0', 'test_1', 'criterion_0', 'criterion_1']);
  assert.equal(request.state.testCases.length, 2);
  assert.equal(request.state.requirements.length, 2);
  assert.equal(result.testJev.length, 2);
  assert.ok(result.criteria.every(item => item.label === 'supports'));
  assert.deepEqual(result.jev, { modelActual: 'jev-1.13.0', error: undefined, inputTokens: 12, outputTokens: 3 });
});

test('one Jev timeout blocks the whole batch without retry fan-out', async () => {
  const calls = { count: 0 };
  const base = fakeJev({ timeout: true })('k'.repeat(20), defaultSettings());
  const client = { ...base, systemOne: (async request => { calls.count += 1; return base.systemOne(request); }) as typeof base.systemOne };
  const result = await evaluateEvidence({ ...input(), client });
  assert.equal(calls.count, 1);
  assert.ok(result.testJev.every(decision => decision.label === 'timeout'));
  assert.ok(result.criteria.every(item => item.label === 'insufficient_evidence'));
});

test('low-confidence batch answers never become PASS support', async () => {
  const client = fakeJev({ test: 'supports', criterion: 'supports', confidence: 0.4 })('k'.repeat(20), defaultSettings());
  const result = await evaluateEvidence({ ...input(), client });
  assert.ok(result.testJev.every(decision => decision.label === 'low_confidence'));
  assert.ok(result.criteria.every(item => item.label === 'insufficient_evidence'));
});

test('missing Jev client produces no request and no evaluator PASS', async () => {
  const result = await evaluateEvidence(input());
  assert.ok(result.testJev.every(decision => decision.label === 'unavailable'));
  assert.ok(result.criteria.every(item => item.label === 'insufficient_evidence'));
  assert.equal(result.jev.inputTokens, 0);
});
