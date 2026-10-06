import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { qaLivePanelSpec, qaPanelSpec } from '../src/panel.ts';
import { createQaLiveModel } from '../src/progress.ts';
import { qaPrompt } from '../src/export.ts';
import { runQa } from '../src/orchestrate.ts';
import { defaultSettings } from '../src/settings.ts';
import { fakeEvaluator, fakeRunner } from './fixtures/fakes.ts';
import { gitRepo, writeWorktree } from './fixtures/git-repo.ts';

test('pi-tui-kit panel shows only test cases and evidence', async () => {
  const dir = await gitRepo();
  const home = await mkdtemp(join(tmpdir(), 'pi-qa-panel-'));
  await writeWorktree(dir, 'src.js', 'export const add = (a, b) => a - b;\n');
  try {
    const record = await runQa({
      cwd: dir,
      intent: { userRequest: { text: 'Keep add() adding', ref: 'session:user' } },
      model: { provider: 'fixture', id: 'offline' },
      settings: defaultSettings(),
      runner: fakeRunner({ tester: { tests: [{ id: 'unit', command: 'npm test', cwd: '.', exitCode: 0, observed: 'pass', assertion: 'addition', contractItemIds: ['U1'] }], notes: '' } }),
      evaluator: fakeEvaluator({ criterion: 'supports', relevant: true }),
      home,
      env: {},
    });
    const items = qaPanelSpec(record).items();
    assert.deepEqual(items.map(item => item.id), ['test:unit']);
    assert.equal(items[0]?.meta, 'BLOCKED');
    const stale = qaPanelSpec({ ...record, verdict: 'STALE', stale: true });
    assert.deepEqual(stale.items().map(item => item.id), ['test:unit']);
    const prompt = qaPrompt(record);
    assert.match(prompt, /Focus only on the non-passing test cases/);
    assert.match(prompt, /BLOCKED · unit/);
    assert.doesNotMatch(prompt, /## Criteria|key fingerprint=|apiKey|TYPESAFE_API_KEY|typesafe-test-key/);
    const passRecord = {
      ...record,
      checks: record.checks.map(check => check.subjectId === 'unit' && (check.kind === 'test-definition' || check.kind === 'test-provenance') ? { ...check, ok: true } : check),
      testEvaluator: [{ subjectId: 'unit', question: 'test', label: 'supports', confidence: 0.99, model: 'fixture/active-model', inputTokens: 0, outputTokens: 0 }],
    } as typeof record;
    const passPrompt = qaPrompt(passRecord);
    assert.match(passPrompt, /no non-passing test cases/);
    assert.doesNotMatch(passPrompt, /BLOCKED · unit|Host output/);

    const live = createQaLiveModel(record.runId, 'Smoke checkout');
    const livePanel = qaLivePanelSpec(live);
    assert.deepEqual(livePanel.items().map(item => item.id), ['cases']);
    const changes = { count: 0 };
    const unsubscribe = livePanel.subscribe?.(() => { changes.count += 1; });
    live.update({ kind: 'agent', role: 'tester', status: 'running' });
    assert.equal(livePanel.items()[0]?.meta, 'PLANNING');
    live.update({ kind: 'complete', record });
    assert.deepEqual(livePanel.items().map(item => item.id), ['test:unit']);
    assert.ok(changes.count >= 2);
    unsubscribe?.();
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
