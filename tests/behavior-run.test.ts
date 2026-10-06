import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { featureBranch, gitRepo, writeWorktree } from './fixtures/git-repo.ts';
import { fakeEvaluator } from './fixtures/fakes.ts';
import { auditedBash } from '../src/audited-bash.ts';
import { runQa, evaluateExisting } from '../src/orchestrate.ts';
import { loadIntent } from '../src/context.ts';
import { harness } from './harness.ts';
import { git } from '../src/git.ts';
import type { ExecutionReceipt, TesterReport } from '../src/schema.ts';

const mission = { userRequest: { text: 'Users can list items and invalid input is rejected.', ref: 'user' } };

async function fixture(action: (dir: string, home: string) => Promise<void>): Promise<void> {
  const dir = await gitRepo();
  const home = await mkdtemp(join(tmpdir(), 'qa-behavior-home-'));
  try { await action(dir, home); } finally { await rm(dir, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); }
}

test('even an all-supporting evaluator cannot PASS web QA with only a green developer suite', async () => fixture(async (dir, home) => {
  await writeWorktree(dir, 'package.json', JSON.stringify({ dependencies: { next: '16' } }));
  const result = await runQa({
    cwd: dir, home, intent: mission, env: {}, evaluator: fakeEvaluator({ criterion: 'supports', test: 'supports' }),
    model: { provider: 'fixture', id: 'offline' }, signal: new AbortController().signal,
    runner: async input => {
      const receipts: ExecutionReceipt[] = [];
      await auditedBash(input.workspace, receipts).execute('test-suite', { command: 'printf "all tests passed"' });
      const report: TesterReport = { tests: [{ id: 'suite', kind: 'ui', command: 'suite', cwd: input.workspace, exitCode: 0, expected: mission.userRequest.text, expectedSource: 'user', observed: 'all tests passed', assertion: 'user scenarios', contractItemIds: ['U1'], executionIds: receipts.map(item => item.id) }], notes: '' };
      return { role: 'tester', status: 'completed', report, executions: receipts, latencyMs: 1 };
    },
  });
  assert.equal(result.snapshot.qaSurface, 'browser');
  assert.equal(result.verdict, 'NOT_VERIFIED');
  assert.match(result.explanation, /not exercised in the browser/);
}));

test('endpoint and invalid-input regression evidence comes from real requests, without code review', async () => fixture(async (dir, home) => {
  await writeWorktree(dir, 'package.json', JSON.stringify({ dependencies: { express: '5' } }));
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.statusCode = req.url === '/items' ? 200 : 400;
    res.end(req.url === '/items' ? '{"items":["one"]}' : '{"error":"invalid input"}');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const result = await runQa({
      cwd: dir, home, intent: mission, env: {}, evaluator: fakeEvaluator({ criterion: 'supports', test: 'supports' }),
      model: { provider: 'fixture', id: 'offline' }, signal: new AbortController().signal,
      runner: async input => {
        const receipts: ExecutionReceipt[] = [];
        const driver = `Promise.all(['/items','/invalid'].map(async path => { const r = await fetch('${url}' + path); console.log(r.status, await r.text()); if ((path === '/items' && r.status !== 200) || (path === '/invalid' && r.status !== 400)) process.exitCode = 1; }))`;
        const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(driver)}`;
        await auditedBash(input.workspace, receipts).execute('requests', { command });
        const report: TesterReport = { tests: [{ id: 'endpoint-regression', kind: 'api', command, cwd: input.workspace, exitCode: 0, expected: mission.userRequest.text, expectedSource: 'user', observed: receipts[0]?.outputExcerpt ?? '', assertion: 'GET items returns 200 and invalid request returns 400', contractItemIds: ['U1'], executionIds: receipts.map(item => item.id) }], notes: '' };
        return { role: 'tester', status: 'completed', report, executions: receipts, latencyMs: 1 };
      },
    });
    assert.equal(result.verdict, 'PASS');
    assert.equal(result.snapshot.qaSurface, 'api');
    assert.match(result.agents.tester.executions?.[0]?.outputExcerpt ?? '', /200.*one/);
    assert.match(result.agents.tester.executions?.[0]?.outputExcerpt ?? '', /400.*invalid input/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}));

test('QA keeps the requested branch and invalidates a changed sibling ticket', async () => fixture(async (dir, home) => {
  await featureBranch(dir, 'feature/PRJ-T315-contract-check');
  const ticketDir = join(dir, '..', `qa-ticket-docs-${Date.now()}`);
  const ref = `../${ticketDir.split('/').at(-1)}/PRJ-T315.md`;
  try {
    await writeWorktree(ticketDir, 'PRJ-T315.md', '# PRJ-T315\n## Acceptance Criteria\n- Public command accepts valid input\n');
    const host = harness(dir);
    const intent = await loadIntent({ sessionManager: host.sessionManager, getSystemPrompt: () => '' }, dir, ref);
    const result = await runQa({ cwd: dir, home, intent, env: {}, model: { provider: 'fixture', id: 'offline' }, signal: new AbortController().signal, runner: async () => ({ role: 'tester', status: 'completed', report: { tests: [], notes: 'blocked' }, latencyMs: 1 }) });
    assert.equal(result.contract.ticketRef, ref);
    assert.equal(result.snapshot.branch, 'feature/PRJ-T315-contract-check');
    assert.equal((await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(), result.snapshot.branch);
    await writeWorktree(ticketDir, 'PRJ-T315.md', '# PRJ-T315\n## Acceptance Criteria\n- Changed outcome\n');
    const reevaluated = await evaluateExisting(result.runId, { cwd: home, home, intent, env: {}, model: { provider: 'fixture', id: 'offline' }, signal: new AbortController().signal });
    assert.equal(reevaluated.verdict, 'STALE');
  } finally { await rm(ticketDir, { recursive: true, force: true }); }
}));
