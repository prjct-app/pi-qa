import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastUserText, loadIntent, projectMemory } from '../src/context.ts';
import { currentTaskText } from '../src/task-context.ts';
import { loadTicket } from '../src/tickets.ts';
import { harness } from './harness.ts';
import { featureBranch, gitRepo, writeWorktree } from './fixtures/git-repo.ts';
import { git } from '../src/git.ts';

const message = (role: string, text: string) => ({ type: 'message', message: { role, content: text } });
const ticket = '# PRJ-T315\n## Acceptance Criteria\n- Contract compiles\n## Definition of Ready\n- Toolchain available\n## Definition of Done\n- Breaking changes are tested\n';

async function fixture(action: (dir: string) => Promise<void>): Promise<void> {
  const dir = await gitRepo();
  try { await action(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('retains the latest actual user request after assistant and tool messages', () => {
  assert.equal(lastUserText([message('user', 'test login'), message('assistant', 'done'), message('toolResult', 'ok')]), 'test login');
  assert.equal(lastUserText([message('user', 'old task'), message('assistant', 'done'), message('user', 'new task')]), 'new task');
});

test('extracts bounded project memory from the Pi system prompt', () => {
  assert.equal(projectMemory('before <project_memory>Recent release constraint</project_memory> after'), 'Recent release constraint');
  assert.equal(projectMemory('no memory'), undefined);
});

test('current task ignores older exchanges and tool output with unrelated ticket IDs', () => {
  const entries = [message('user', 'old PRJ-T001'), message('assistant', 'done'), message('user', 'work on PRJ-T315'), message('toolResult', 'PRJ-T001 PRJ-T002'), message('assistant', 'PRJ-T315 is ready')];
  assert.doesNotMatch(currentTaskText(entries), /PRJ-T001|PRJ-T002/);
  assert.match(currentTaskText(entries), /PRJ-T315/);
});

test('generic testing follow-up can recover the immediately preceding task exchange', () => {
  assert.match(currentTaskText([message('user', 'implement PRJ-T315'), message('assistant', 'PRJ-T315 ready'), message('user', 'realiza las pruebas')]), /PRJ-T315/);
});

test('QA retains the original mission and corrections across generic follow-ups', async () => fixture(async dir => {
  const host = harness(dir);
  for (const content of ['Implement retry for GET only; never retry POST.', 'Correction: preserve Retry-After.', 'continúa', 'realiza las pruebas']) {
    host.sessionManager.appendMessage({ role: 'user', content, timestamp: Date.now() });
  }
  const loaded = await loadIntent({ sessionManager: host.sessionManager, getSystemPrompt: () => '' }, dir);
  assert.match(loaded.userRequest?.text ?? '', /GET only; never retry POST/);
  assert.match(loaded.userRequest?.text ?? '', /preserve Retry-After/);
  assert.match(loaded.userRequest?.text ?? '', /realiza las pruebas/);
}));

test('typed answer tool carries the current task reference, not unrelated tool results', () => {
  const text = currentTaskText([message('user', 'what task was worked on?'), { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'answer', arguments: { answer: 'PRJ-T315', refs: [{ path: '../docs/project/work/tasks/PRJ-T315.md' }] } }] } }]);
  assert.match(text, /PRJ-T315/);
});

test('generic QA resolves the current feature branch; an explicit different target takes priority', async () => fixture(async dir => {
  await writeWorktree(dir, 'docs/PRJ-T315.md', ticket);
  await featureBranch(dir, 'feature/PRJ-T315-contract-check');
  const host = harness(dir);
  const context = { sessionManager: host.sessionManager, getSystemPrompt: () => '' };
  assert.equal((await loadIntent(context, dir, 'realiza las pruebas')).ticket?.ref, 'docs/PRJ-T315.md');
  assert.equal((await loadIntent(context, dir, 'test the login URL')).ticket, undefined);
  assert.equal((await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(), 'feature/PRJ-T315-contract-check');
}));

test('loads PRJ IDs from sibling project task docs and extracts AC, DoR and DoD', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qa-sibling-docs-'));
  try {
    await writeWorktree(root, 'prjct-fe/.keep', '');
    await writeWorktree(root, 'docs/project/work/tasks/PRJ-T315.md', ticket);
    const loaded = await loadTicket(join(root, 'prjct-fe'), 'realiza las pruebas de PRJ-T315.');
    assert.equal(loaded?.ref, '../docs/project/work/tasks/PRJ-T315.md');
    assert.deepEqual(loaded?.ac, ['Contract compiles']);
    assert.deepEqual(loaded?.dor, ['Toolchain available']);
    assert.deepEqual(loaded?.dod, ['Breaking changes are tested']);
    assert.equal((await loadTicket(join(root, 'prjct-fe'), '../docs/project/work/tasks/PRJ-T315.md'))?.fingerprint, loaded?.fingerprint);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('supports legacy numeric tickets and title-named documents with frontmatter IDs', async () => fixture(async dir => {
  await writeWorktree(dir, 'docs/tickets/07-login.md', ticket);
  await writeWorktree(dir, 'docs/work/contract.md', `---\nid: PRJ-T315\n---\n${ticket}`);
  assert.equal((await loadTicket(dir, 'ticket 07'))?.ref, 'docs/tickets/07-login.md');
  assert.equal((await loadTicket(dir, 'PRJ-T315'))?.ref, 'docs/work/contract.md');
}));

test('missing or ambiguous explicit references block instead of silently dropping the ticket', async () => fixture(async dir => {
  await writeWorktree(dir, 'docs/a/PRJ-T315.md', ticket);
  await writeWorktree(dir, 'docs/b/PRJ-T315.md', ticket);
  await assert.rejects(loadTicket(dir, 'PRJ-T315'), /Multiple documents/);
  await assert.rejects(loadTicket(dir, 'PRJ-T999'), /No unique ticket/);
  await assert.rejects(loadTicket(dir, 'PRJ-T315 PRJ-T316'), /Multiple QA tasks/);
}));

test('rejects ambient ticket files, symbolic links and symlinked ticket directories', async () => fixture(async dir => {
  await writeWorktree(dir, 'docs/PRJ-T315.md', ticket);
  const canonical = await realpath(dir);
  await symlink(join(canonical, 'docs/PRJ-T315.md'), join(dir, 'linked.md'));
  await symlink(join(canonical, 'docs'), join(dir, 'linked-docs'));
  await assert.rejects(loadTicket(dir, '.pi/ticket.md'), /outside .pi/);
  await assert.rejects(loadTicket(dir, 'linked.md'), /without symbolic links/);
  await assert.rejects(loadTicket(dir, 'linked-docs/PRJ-T315.md'), /without symbolic links/);
}));

test('loadIntent recovers a ticket from the active exchange after an assistant answer', async () => fixture(async dir => {
  await writeWorktree(dir, 'docs/project/work/tasks/PRJ-T315.md', ticket);
  const host = harness(dir);
  host.sessionManager.appendMessage({ role: 'user', content: 'what ticket was worked on?', timestamp: Date.now() });
  host.sessionManager.appendMessage({ role: 'assistant', api: 'openai-completions', provider: 'fixture', model: 'offline', content: [{ type: 'text', text: 'PRJ-T315 is ready for QA.' }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });
  const context = { sessionManager: host.sessionManager, getSystemPrompt: () => '' };
  const loaded = await loadIntent(context, dir, 'realiza las pruebas');
  assert.equal(loaded.ticket?.ref, 'docs/project/work/tasks/PRJ-T315.md');
}));

test('old runs keep their records and evidence but drop working copies', async () => {
  const { mkdtemp, mkdir: mk, writeFile: wf, readdir: rd, utimes } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join: j } = await import('node:path');
  const { pruneRuns, runsRoot, KEEP_WORKING_COPIES } = await import('../src/store.ts');
  const home = await mkdtemp(j(tmpdir(), 'qa-prune-'));
  const root = runsRoot(home);
  const total = KEEP_WORKING_COPIES + 3;
  for (let i = 0; i < total; i++) {
    const dir = j(root, `run-${i}`);
    await mk(j(dir, 'tester', 'repo', 'node_modules'), { recursive: true });
    await mk(j(dir, 'artifacts'), { recursive: true });
    await wf(j(dir, 'report.json'), '{}');
    const at = new Date(Date.now() - (total - i) * 60_000);
    await utimes(dir, at, at);
  }
  await pruneRuns('run-0', home);
  assert.deepEqual((await rd(j(root, 'run-0'))).sort(), ['artifacts', 'report.json', 'tester'], 'the run starting now is never touched');
  assert.deepEqual((await rd(j(root, 'run-1'))).sort(), ['artifacts', 'report.json'], 'an old run keeps its record and evidence');
  assert.ok((await rd(j(root, `run-${total - 1}`))).includes('tester'), 'recent runs keep their working copies');
});
