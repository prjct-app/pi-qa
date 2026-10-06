import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideVerdict } from '../src/verdict.ts';
import { emptyContract, emptyReviewer, emptyTester, type AgentOutcome, type CriterionEvaluation } from '../src/schema.ts';

const done = (role: 'reviewer' | 'tester'): AgentOutcome => ({ role, status: 'completed', latencyMs: 1 });

const criterion = (over: Partial<CriterionEvaluation> = {}): CriterionEvaluation => ({
  id: 'U1', text: 'Keep add() adding', source: 'user_request', required: true, label: 'supports', reason: 'ok', evaluator: [], tests: ['t1'], findings: [], ...over,
});
const testDecision = (subjectId: string, label: 'supports' | 'contradicts' | 'insufficient_evidence') => ({
  subjectId, question: 'test', label, confidence: 0.9, model: 'fixture/active-model', inputTokens: 0, outputTokens: 0,
} as const);

test('green tests that do not assert a required behavior are NOT_VERIFIED', () => {
  const result = decideVerdict({
    contract: emptyContract(),
    criteria: [criterion({ tests: [], label: 'supports', reason: 'review only' })],
    reviewer: done('reviewer'),
    tester: done('tester'),
    reviewerReport: emptyReviewer(),
    testerReport: { tests: [{ id: 't1', command: 'true', cwd: '.', exitCode: 0, observed: 'ok', assertion: 'unrelated', contractItemIds: [] }], notes: '' },
    findingEvaluator: [],
    stale: false,
    evaluatorAvailable: true,
  });
  assert.equal(result.verdict, 'NOT_VERIFIED');
});

test('reviewer findings do not affect the QA verdict', () => {
  const result = decideVerdict({
    contract: emptyContract(),
    criteria: [criterion()],
    reviewer: done('reviewer'),
    tester: done('tester'),
    reviewerReport: {
      findings: [{
        id: 'f1', severity: 'blocking', file: 'src.js', startLine: 1, endLine: 1,
        excerpt: 'return a - b', behavior: 'subtract', claim: 'off-by-one', evidence: 'line 1', contractItemIds: ['U1'],
      }],
      notes: '', blockers: ['f1'],
    },
    testerReport: { tests: [{ id: 't1', command: 'true', cwd: '.', exitCode: 0, observed: 'ok', assertion: 'add works', contractItemIds: ['U1'] }], notes: '' },
    findingEvaluator: [{ subjectId: 'f1', question: 'finding', label: 'supports', confidence: 0.9, model: 'fixture/active-model', inputTokens: 1, outputTokens: 1 }],
    findingImpactEvaluator: [{ subjectId: 'f1', question: 'impact', label: 'supports', confidence: 0.9, model: 'fixture/active-model', inputTokens: 1, outputTokens: 1 }],
    testEvaluator: [testDecision('t1', 'supports')],
    stale: false,
    evaluatorAvailable: true,
  });
  assert.equal(result.verdict, 'PASS');
});

test('reviewer impact uncertainty does not affect test-case QA', () => {
  const finding = {
    id: 'f1', severity: 'blocking' as const, file: 'src.js', startLine: 1, endLine: 1,
    excerpt: 'return a - b', behavior: 'addition', claim: 'may break addition', evidence: 'line 1', contractItemIds: ['U1'],
  };
  const result = decideVerdict({
    contract: emptyContract(),
    criteria: [criterion()],
    reviewer: done('reviewer'),
    tester: done('tester'),
    reviewerReport: { findings: [finding], notes: '', blockers: ['f1'] },
    testerReport: { tests: [{ id: 't1', command: 'true', cwd: '.', exitCode: 0, observed: 'ok', assertion: 'add works', contractItemIds: ['U1'] }], notes: '' },
    findingEvaluator: [{ subjectId: 'f1', question: 'finding', label: 'supports', confidence: 0.9, model: 'fixture/active-model', inputTokens: 1, outputTokens: 1 }],
    findingImpactEvaluator: [{ subjectId: 'f1', question: 'impact', label: 'insufficient_evidence', confidence: 0.4, model: 'fixture/active-model', inputTokens: 1, outputTokens: 1 }],
    testEvaluator: [testDecision('t1', 'supports')],
    stale: false,
    evaluatorAvailable: true,
  });
  assert.equal(result.verdict, 'PASS');
});

test('missing target plus unavailable Evaluator requires a fresh targeted run, not evaluate', () => {
  const result = decideVerdict({
    contract: emptyContract(),
    snapshot: { scope: 'target', paths: [] } as any,
    criteria: [criterion({ tests: [], label: 'insufficient_evidence' })],
    reviewer: done('reviewer'),
    tester: done('tester'),
    reviewerReport: emptyReviewer(),
    testerReport: { tests: [{ id: 'skip', command: 'inspect', cwd: '.', exitCode: -1, observed: 'no target', assertion: 'target exists', contractItemIds: ['U1'], skipped: true }], notes: '' },
    findingEvaluator: [],
    stale: false,
    evaluatorAvailable: false,
  });
  assert.equal(result.verdict, 'NOT_VERIFIED');
  assert.match(result.nextVerification, /--target/);
  assert.match(result.nextVerification, /Do not evaluate this snapshot/i);
});

test('failed QA agent never yields PASS', () => {
  const result = decideVerdict({
    contract: emptyContract(),
    criteria: [criterion()],
    reviewer: done('reviewer'),
    tester: { role: 'tester', status: 'failed', error: 'boom', latencyMs: 1 },
    reviewerReport: emptyReviewer(),
    testerReport: emptyTester(),
    findingEvaluator: [],
    stale: false,
    evaluatorAvailable: true,
  });
  assert.equal(result.verdict, 'NOT_VERIFIED');
  assert.match(result.explanation, /QA agent failed/i);
});

test('a changing diff is STALE', () => {
  const result = decideVerdict({
    contract: emptyContract(),
    criteria: [criterion()],
    reviewer: done('reviewer'),
    tester: done('tester'),
    reviewerReport: emptyReviewer(),
    testerReport: emptyTester(),
    findingEvaluator: [],
    stale: true,
    evaluatorAvailable: true,
  });
  assert.equal(result.verdict, 'STALE');
});

test('a failed test case is FAIL only with verified definition and execution', () => {
  const base = {
    contract: emptyContract(), criteria: [criterion()], reviewer: done('reviewer'), tester: done('tester'), reviewerReport: emptyReviewer(),
    testerReport: { tests: [{ id: 't2', command: 'node broken.test.js', cwd: '.', exitCode: 1, expected: 'test exits zero', expectedSource: 'existing_test' as const, observed: 'assertion failed', assertion: 'subtract returns product', contractItemIds: ['U1'] }], notes: '' },
    findingEvaluator: [], stale: false, evaluatorAvailable: true,
  };
  const uncertain = decideVerdict({ ...base, testEvaluator: [] });
  assert.equal(uncertain.verdict, 'NOT_VERIFIED');
  const substantiated = decideVerdict({
    ...base,
    testEvaluator: [testDecision('t2', 'contradicts')],
    checks: [
      { subjectId: 't2', kind: 'test-definition' as const, ok: true, detail: 'defined' },
      { subjectId: 't2', kind: 'test-provenance' as const, ok: true, detail: 'verified' },
    ],
  });
  assert.equal(substantiated.verdict, 'FAIL');
});

test('PASS requires supported required explicit criteria, relevant tests, and passed test cases', () => {
  const result = decideVerdict({
    contract: emptyContract(),
    criteria: [criterion()],
    reviewer: done('reviewer'),
    tester: done('tester'),
    reviewerReport: emptyReviewer(),
    testerReport: { tests: [{ id: 't1', command: 'node test.js', cwd: '.', exitCode: 0, observed: 'ok', assertion: 'subtract', contractItemIds: ['U1'] }], notes: '' },
    findingEvaluator: [],
    testEvaluator: [testDecision('t1', 'supports')],
    stale: false,
    evaluatorAvailable: true,
  });
  assert.equal(result.verdict, 'PASS');
});
