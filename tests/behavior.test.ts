import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { behaviorGap, qaSurface } from '../src/behavior.ts';
import { auditedBash, bashStatus } from '../src/audited-bash.ts';
import { deterministicChecks } from '../src/evidence.ts';
import { testerPrompt } from '../src/agents.ts';
import { emptyContract, emptyReviewer, type AgentOutcome, type ExecutionReceipt, type TestRecord } from '../src/schema.ts';
import { captureSnapshot } from '../src/snapshot.ts';
import { defaultSettings } from '../src/settings.ts';
import { gitRepo, writeWorktree } from './fixtures/git-repo.ts';

const executed = (tool: 'bash' | 'qa_browser', command: string): ExecutionReceipt => ({
  id: 'host-1', tool, command, cwd: '/qa', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z', status: 'completed', exitCode: 0, outputHash: 'a'.repeat(64), outputExcerpt: 'Visible result: saved',
});
const scenario = (kind: TestRecord['kind']): TestRecord => ({ id: 's1', kind, command: 'exercise product', cwd: '/qa', exitCode: 0, expected: 'user can save', expectedSource: 'ticket', observed: 'saved', assertion: 'record saved', contractItemIds: ['U1'], executionIds: ['host-1'] });

async function fixture(action: (dir: string) => Promise<void>): Promise<void> {
  const dir = await gitRepo();
  try { await action(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('application surface recognizes web, endpoints and public commands', async () => fixture(async dir => {
  await writeWorktree(dir, 'package.json', JSON.stringify({ dependencies: { next: '16' } }));
  assert.equal(await qaSurface(dir, 'run QA', []), 'browser');
  await writeWorktree(dir, 'package.json', JSON.stringify({ dependencies: { express: '5' } }));
  assert.equal(await qaSurface(dir, 'run QA', []), 'api');
  await writeWorktree(dir, 'package.json', '{}');
  await writeWorktree(dir, 'pyproject.toml', '[project]\ndependencies = ["fastapi"]\n');
  assert.equal(await qaSurface(dir, 'run QA', []), 'api');
  await writeWorktree(dir, 'pyproject.toml', '');
  assert.equal(await qaSurface(dir, 'check https://example.test/login', []), 'browser');
  assert.equal(await qaSurface(dir, 'test the CLI', []), 'command');
}));

test('web QA requires browser observations; green developer checks and relabeled bash cannot replace them', async () => fixture(async dir => {
  const { snapshot } = await captureSnapshot(dir, { settings: defaultSettings() });
  for (const [kind, receipt] of [
    ['unit', executed('bash', 'npm test')],
    ['ui', executed('bash', 'npm test')],
    ['ui', executed('qa_browser', '{"action":"tools"}')],
    ['ui', { ...executed('qa_browser', '{"action":"open"}'), status: 'failed', exitCode: 1 }],
  ] as const) {
    const report = { tests: [scenario(kind)], notes: '' };
    const tester: AgentOutcome = { role: 'tester', status: 'completed', report, executions: [receipt], latencyMs: 1 };
    const checks = deterministicChecks(snapshot, emptyReviewer(), report, [receipt]);
    assert.match(behaviorGap({ ...snapshot, qaSurface: 'browser' }, tester, report, checks) ?? '', /not exercised in the browser/);
  }
  const receipt = executed('qa_browser', '{"action":"click","selector":"button"}');
  const report = { tests: [scenario('ui')], notes: '' };
  const tester: AgentOutcome = { role: 'tester', status: 'completed', report, executions: [receipt], latencyMs: 1 };
  assert.equal(behaviorGap({ ...snapshot, qaSurface: 'browser' }, tester, report, deterministicChecks(snapshot, emptyReviewer(), report, [receipt])), undefined);
}));

test('backend QA requires endpoint scenarios rather than code/static checks', async () => fixture(async dir => {
  const { snapshot } = await captureSnapshot(dir, { settings: defaultSettings() });
  const receipt = executed('bash', 'curl http://127.0.0.1:8000/items');
  for (const kind of ['static', 'unit', 'api'] as const) {
    const report = { tests: [scenario(kind)], notes: '' };
    const tester: AgentOutcome = { role: 'tester', status: 'completed', report, executions: [receipt], latencyMs: 1 };
    const gap = behaviorGap({ ...snapshot, qaSurface: 'api' }, tester, report, deterministicChecks(snapshot, emptyReviewer(), report, [receipt]));
    assert.equal(gap === undefined, kind === 'api');
  }
  const suite = executed('bash', 'npm test');
  const report = { tests: [scenario('api')], notes: '' };
  const tester: AgentOutcome = { role: 'tester', status: 'completed', report, executions: [suite], latencyMs: 1 };
  assert.match(behaviorGap({ ...snapshot, qaSurface: 'api' }, tester, report, deterministicChecks(snapshot, emptyReviewer(), report, [suite])) ?? '', /endpoints were not exercised/);
}));

test('QA instructions are English and require application usage, endpoint regressions and precise blockers', async () => fixture(async dir => {
  const { snapshot } = await captureSnapshot(dir, { settings: defaultSettings() });
  const prompt = testerPrompt({ ...snapshot, qaSurface: 'browser', combinedPatch: 'PRIVATE_IMPLEMENTATION_NOT_A_QA_PROCEDURE' }, emptyContract(), defaultSettings());
  assert.doesNotMatch(prompt, /PRIVATE_IMPLEMENTATION_NOT_A_QA_PROCEDURE/);
  assert.match(prompt, /product QA, not a developer or code reviewer/);
  assert.match(prompt, /using qa_browser is mandatory/);
  assert.match(prompt, /send real HTTP requests/);
  assert.match(prompt, /affected regression flows/);
  assert.match(prompt, /Do not fall back to code review/);
  assert.match(prompt, /Write your test plan, observations and report in English/);
  assert.match(prompt, /do not call a separate model or service to translate/);
}));

test('host-returned nonzero bash result is recorded as failure, not exit zero', () => {
  assert.deepEqual(bashStatus({ structuredContent: { exit_code: 7 }, isError: true }), { exitCode: 7, failed: true });
  assert.deepEqual(bashStatus({ structuredContent: { exit_code: 7 } }), { exitCode: 7, failed: true });
  assert.deepEqual(bashStatus({ isError: true }), { exitCode: null, failed: true });
  assert.deepEqual(bashStatus({ structuredContent: { exit_code: 0 } }), { exitCode: 0, failed: false });
});

test('audited bash records actual successful and failing public commands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qa-bash-'));
  const receipts: ExecutionReceipt[] = [];
  try {
    const tool = auditedBash(dir, receipts);
    await tool.execute('success', { command: 'printf "ready"' });
    await tool.execute('failure', { command: 'printf "rejected"; exit 7' }).catch(() => undefined);
    assert.deepEqual(receipts.map(item => [item.status, item.exitCode]), [['completed', 0], ['failed', 7]]);
    assert.match(receipts[0]?.outputExcerpt ?? '', /ready/);
    assert.match(receipts[1]?.outputExcerpt ?? '', /rejected/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
