import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateExisting, runQa } from '../src/orchestrate.ts';
import { defaultSettings } from '../src/settings.ts';
import { fakeJev, fakeRunner, memoryStore, trackingRunner } from './fixtures/fakes.ts';
import { gitRepo, writeWorktree } from './fixtures/git-repo.ts';
import type { ReviewerReport, TesterReport } from '../src/schema.ts';

const settings = defaultSettings();

const home = async () => mkdtemp(join(tmpdir(), 'pi-qa-home-'));

const subtractDiff = async () => {
  const dir = await gitRepo();
  await writeWorktree(dir, 'src.js', 'export const add = (a, b) => a - b;\n');
  return dir;
};

test('launches exactly one QA agent against the snapshot', async () => {
  const dir = await subtractDiff();
  const dest = await home();
  const tracked = trackingRunner();
  try {
    const record = await runQa({
      cwd: dir, intent: { userRequest: { text: 'Keep add() adding', ref: 'session:user' } },
      model: { provider: 'fixture', id: 'offline' }, store: memoryStore('k'.repeat(20)),
      settings, runner: tracked.runner, jevFactory: fakeJev({ criterion: 'supports', relevant: true }),
      home: dest, env: {},
    });
    assert.deepEqual(tracked.launched, ['tester']);
    assert.equal(record.agents.reviewer.status, 'completed');
    assert.equal(record.agents.tester.status, 'completed');
    assert.equal(record.snapshot.paths.some(path => path.path === 'src.js'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test('green but irrelevant tests yield NOT_VERIFIED', async () => {
  const dir = await subtractDiff();
  const dest = await home();
  const tester: TesterReport = { tests: [{ id: 't1', command: 'true', cwd: '.', exitCode: 0, observed: 'ok', assertion: 'true exits 0', contractItemIds: ['U1'] }], notes: '' };
  try {
    const record = await runQa({
      cwd: dir, intent: { userRequest: { text: 'Keep add() adding', ref: 'session:user' } },
      model: { provider: 'fixture', id: 'offline' }, store: memoryStore('k'.repeat(20)),
      settings, runner: fakeRunner({ tester }), jevFactory: fakeJev({ criterion: 'supports', relevant: false }),
      home: dest, env: {},
    });
    assert.equal(record.verdict, 'NOT_VERIFIED');
    assert.match(record.explanation, /not assert|insufficient|Jev|intent|evidence|Green exits/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test('a required behavior contradicted by test evidence is FAIL', async () => {
  const dir = await subtractDiff();
  const dest = await home();
  const reviewer: ReviewerReport = {
    findings: [{
      id: 'f1', severity: 'blocking', file: 'src.js', startLine: 1, endLine: 1,
      excerpt: 'a - b', behavior: 'add', claim: 'add subtracts', evidence: 'operator changed', contractItemIds: ['U1'],
    }],
    notes: '', blockers: ['f1'],
  };
  const tester: TesterReport = { tests: [{ id: 't1', command: 'true', cwd: '.', exitCode: 0, observed: 'ok', assertion: 'process lives', contractItemIds: ['U1'] }], notes: '' };
  try {
    const record = await runQa({
      cwd: dir, intent: { userRequest: { text: 'Keep add() adding', ref: 'session:user' } },
      model: { provider: 'fixture', id: 'offline' }, store: memoryStore('k'.repeat(20)),
      settings, runner: fakeRunner({ reviewer, tester }),
      jevFactory: fakeJev({ finding: 'supports', criterion: 'contradicts', relevant: true }),
      home: dest, env: {},
    });
    assert.equal(record.verdict, 'FAIL');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test('no ticket is allowed and does not by itself cause PASS', async () => {
  const dir = await subtractDiff();
  const dest = await home();
  try {
    const record = await runQa({
      cwd: dir, intent: {},
      model: { provider: 'fixture', id: 'offline' }, store: memoryStore('k'.repeat(20)),
      settings, runner: fakeRunner({}), jevFactory: fakeJev({ criterion: 'supports', relevant: true }),
      home: dest, env: {},
    });
    assert.ok(record.contract.items.every(item => item.source === 'inferred_from_diff' || item.required === false) || record.verdict !== 'PASS');
    assert.notEqual(record.verdict, 'PASS');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test('a changing diff marks the run STALE', async () => {
  const dir = await subtractDiff();
  const dest = await home();
  try {
    const record = await runQa({
      cwd: dir, intent: { userRequest: { text: 'Keep add() adding', ref: 'session:user' } },
      model: { provider: 'fixture', id: 'offline' }, store: memoryStore('k'.repeat(20)),
      settings,
      runner: async input => {
        await writeWorktree(dir, 'src.js', 'export const add = (a, b) => a + b + 1;\n');
        return fakeRunner({})(input);
      },
      jevFactory: fakeJev({ criterion: 'supports', relevant: true }),
      home: dest, env: {},
    });
    assert.equal(record.verdict, 'STALE');
    assert.equal(record.stale, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test('QA agent failure is NOT_VERIFIED', async () => {
  const dir = await subtractDiff();
  const dest = await home();
  const reviewer: ReviewerReport = { findings: [], notes: 'looks fine', blockers: [] };
  try {
    const record = await runQa({
      cwd: dir, intent: { userRequest: { text: 'Keep add() adding', ref: 'session:user' } },
      model: { provider: 'fixture', id: 'offline' }, store: memoryStore('k'.repeat(20)),
      settings, runner: fakeRunner({ reviewer, fail: 'tester' }),
      jevFactory: fakeJev({ criterion: 'supports', relevant: true }),
      home: dest, env: {},
    });
    assert.equal(record.agents.reviewer.status, 'completed');
    assert.equal(record.agents.tester.status, 'failed');
    assert.equal(record.verdict, 'NOT_VERIFIED');
    assert.deepEqual(record.agents.reviewer.report, { findings: [], notes: '', blockers: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test('missing semantic evaluator preserves test evidence without exposing Jev in UX', async () => {
  const dir = await subtractDiff();
  const dest = await home();
  try {
    const record = await runQa({
      cwd: dir, intent: { userRequest: { text: 'Keep add() adding', ref: 'session:user' } },
      model: { provider: 'fixture', id: 'offline' }, store: memoryStore(),
      settings, runner: fakeRunner({}), jevFactory: fakeJev({ criterion: 'supports', relevant: true }),
      home: dest, env: {},
    });
    assert.equal(record.jev.configured, false);
    assert.equal(record.verdict, 'NOT_VERIFIED');
    assert.match(record.explanation, /global evaluator credential is not configured/i);
    assert.match(record.nextVerification, /\/qa setup once/);
    assert.equal(record.agents.reviewer.status, 'completed');
    assert.equal(record.agents.tester.status, 'completed');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test('cancellation returns an incomplete result, not PASS', async () => {
  const dir = await subtractDiff();
  const dest = await home();
  const controller = new AbortController();
  try {
    const record = await runQa({
      cwd: dir, intent: { userRequest: { text: 'Keep add() adding', ref: 'session:user' } },
      model: { provider: 'fixture', id: 'offline' }, store: memoryStore('k'.repeat(20)),
      settings,
      runner: async input => {
        controller.abort();
        return fakeRunner({})(input);
      },
      jevFactory: fakeJev({ criterion: 'supports', relevant: true }),
      home: dest, env: {}, signal: controller.signal,
    });
    assert.notEqual(record.verdict, 'PASS');
    assert.ok(record.agents.reviewer.status === 'canceled' || record.agents.tester.status === 'canceled' || record.verdict === 'NOT_VERIFIED');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test('evaluate reuses the snapshot after a key is added without rerunning agents', async () => {
  const dir = await subtractDiff();
  const dest = await home();
  const launched: string[] = [];
  try {
    const first = await runQa({
      cwd: dir, intent: { userRequest: { text: 'Keep add() adding', ref: 'session:user' } },
      model: { provider: 'fixture', id: 'offline' }, store: memoryStore(),
      settings,
      runner: async input => {
        launched.push(input.role);
        return fakeRunner({
          tester: { tests: [{ id: 't1', command: 'node -e "assert.equal(1-1,0)"', cwd: '.', exitCode: 0, observed: 'ok', assertion: 'subtract', contractItemIds: ['U1'] }], notes: '' },
        })(input);
      },
      home: dest, env: {},
    });
    assert.equal(first.verdict, 'NOT_VERIFIED');
    const second = await evaluateExisting(first.runId, {
      cwd: dir, intent: { userRequest: { text: 'Keep add() adding', ref: 'session:user' } },
      model: { provider: 'fixture', id: 'offline' }, store: memoryStore('k'.repeat(20)),
      settings, jevFactory: fakeJev({ criterion: 'supports', relevant: true }),
      home: dest, env: {},
    });
    assert.equal(launched.length, 1);
    assert.equal(second.snapshot.fingerprint, first.snapshot.fingerprint);
    assert.equal(second.jev.configured, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test('evaluate compares against the captured checkout, not the new session cwd', async () => {
  const dir = await subtractDiff();
  const other = await gitRepo();
  const dest = await home();
  try {
    const first = await runQa({
      cwd: dir, intent: { userRequest: { text: 'Keep add() adding', ref: 'session:user' } },
      model: { provider: 'fixture', id: 'offline' }, store: memoryStore('k'.repeat(20)),
      settings, runner: fakeRunner({}), jevFactory: fakeJev({ criterion: 'supports', relevant: true }),
      home: dest, env: {},
    });
    const second = await evaluateExisting(first.runId, {
      cwd: other, intent: { userRequest: { text: 'Keep add() adding', ref: 'session:user' } },
      model: { provider: 'fixture', id: 'offline' }, store: memoryStore('k'.repeat(20)),
      settings, jevFactory: fakeJev({ criterion: 'supports', relevant: true }), home: dest, env: {},
    });
    assert.notEqual(second.verdict, 'STALE');
    assert.equal(second.snapshot.cwd, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test('the user checkout is not modified by QA workspace overlay', async () => {
  const dir = await subtractDiff();
  const dest = await home();
  const before = await readFile(join(dir, 'src.js'), 'utf8');
  try {
    await runQa({
      cwd: dir, intent: {}, model: { provider: 'fixture', id: 'offline' }, store: memoryStore(),
      settings, runner: fakeRunner({}), home: dest, env: {},
    });
    assert.equal(await readFile(join(dir, 'src.js'), 'utf8'), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test('re-evaluating a stale snapshot preserves the original audited report', async () => {
  const dir = await subtractDiff();
  const dest = await home();
  try {
    const first = await runQa({
      cwd: dir, intent: { userRequest: { text: 'Keep add() adding', ref: 'session:user' } },
      model: { provider: 'fixture', id: 'offline' }, store: memoryStore('k'.repeat(20)),
      settings, runner: fakeRunner({}), jevFactory: fakeJev({ criterion: 'supports', relevant: true }),
      home: dest, env: {},
    });
    assert.notEqual(first.verdict, 'STALE');
    await writeWorktree(dir, 'src.js', 'export const add = (a, b) => a * b;\n');
    const again = await evaluateExisting(first.runId, {
      cwd: dir, intent: { userRequest: { text: 'Keep add() adding', ref: 'session:user' } },
      model: { provider: 'fixture', id: 'offline' }, store: memoryStore('k'.repeat(20)),
      settings, jevFactory: fakeJev({ criterion: 'supports', relevant: true }), home: dest, env: {},
    });
    assert.equal(again.verdict, 'STALE');
    const original = JSON.parse(await readFile(join(dest, 'pi-qa', 'runs', first.runId, 'report.json'), 'utf8')) as { verdict: string };
    const evaluation = JSON.parse(await readFile(join(dest, 'pi-qa', 'runs', first.runId, 'report-eval.json'), 'utf8')) as { verdict: string };
    assert.equal(original.verdict, first.verdict);
    assert.equal(evaluation.verdict, 'STALE');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test('untracked files appear in the persisted report', async () => {
  const dir = await gitRepo();
  const dest = await home();
  try {
    await writeFile(join(dir, 'scratch.ts'), 'export const scratch = true;\n');
    const record = await runQa({
      cwd: dir, intent: {}, model: { provider: 'fixture', id: 'offline' }, store: memoryStore(),
      settings, runner: fakeRunner({}), home: dest, env: {},
    });
    assert.ok(record.snapshot.untracked.includes('scratch.ts'));
    const runDir = join(dest, 'pi-qa', 'runs', record.runId);
    const saved = JSON.parse(await readFile(join(runDir, 'report.json'), 'utf8'));
    assert.ok(saved.snapshot.untracked.includes('scratch.ts'));
    assert.match(await readFile(join(runDir, 'artifacts', 'report.md'), 'utf8'), /# QA/);
    const exportedTests = await readFile(join(runDir, 'artifacts', 'test-results.json'), 'utf8');
    assert.doesNotThrow(() => JSON.parse(exportedTests));
    assert.match(await readFile(join(runDir, 'artifacts', 'junit.xml'), 'utf8'), /<testsuite/);
    assert.match(await readFile(join(runDir, 'artifacts', 'ticket-comment.md'), 'utf8'), /## QA/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});
