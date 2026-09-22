import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runQa } from '../src/orchestrate.ts';
import { reportTool, sdkRunner } from '../src/runner.ts';
import { defaultSettings } from '../src/settings.ts';
import { memoryStore } from './fixtures/fakes.ts';
import { gitRepo, writeWorktree } from './fixtures/git-repo.ts';

const fixture = fileURLToPath(new URL('./fixtures/mock-provider.ts', import.meta.url));

test('end-to-end Pi SDK session launches one QA agent and preserves the checkout', { timeout: 30_000 }, async () => {
  const dir = await gitRepo();
  const dest = await mkdtemp(join(tmpdir(), 'pi-qa-e2e-'));
  const agentDir = await mkdtemp(join(tmpdir(), 'pi-qa-agent-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const before = 'export const add = (a, b) => a - b;\n';
  const progress: string[] = [];
  await writeWorktree(dir, 'src.js', before);
  try {
    const record = await runQa({
      cwd: dir,
      intent: { userRequest: { text: 'Keep add() adding', ref: 'session:user' } },
      model: { provider: 'qa-fixture', id: 'offline' },
      agentDir,
      store: memoryStore(),
      settings: defaultSettings(),
      runner: sdkRunner,
      extensionPaths: [fixture],
      onProgress: event => { if (event.kind === 'stage' || event.kind === 'jev') progress.push(event.message); },
      home: dest,
      env: {},
    });
    assert.equal(record.agents.reviewer.status, 'completed', record.agents.reviewer.error);
    assert.equal(record.agents.tester.status, 'completed', record.agents.tester.error);
    assert.deepEqual(record.agents.reviewer.report, { findings: [], notes: '', blockers: [] });
    assert.match(JSON.stringify(record.agents.tester.report), /Offline SDK tester/);
    assert.equal(record.agents.tester.executions?.length, 1);
    assert.equal(record.agents.tester.executions?.[0]?.tool, 'bash');
    assert.ok(record.checks.some(check => check.kind === 'test-definition' && check.ok));
    assert.ok(record.checks.some(check => check.kind === 'test-provenance' && check.ok));
    assert.ok(record.checks.some(check => check.kind === 'test-ran' && check.ok));
    assert.ok(progress.some(message => /Running command:/i.test(message)));
    assert.ok(progress.some(message => /Finalizing test cases/i.test(message)));
    assert.ok(progress.some(message => /Evaluating all test cases/i.test(message)));
    assert.ok(progress.some(message => /Saving the auditable QA record/i.test(message)));
    assert.equal(await readFile(join(dir, 'src.js'), 'utf8'), before);
    assert.ok(record.snapshot.fingerprint);
    assert.notEqual(record.verdict, 'PASS');
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});

test('an invalid report goes back to the agent to fix instead of ending the run', async () => {
  const slot: { report?: unknown; error?: string } = {};
  const tool = reportTool('reviewer', slot);
  await assert.rejects(tool.execute('1', { findings: 'none' }), /Report not recorded\. Fix and call pi_qa_reviewer_report again/);
  assert.equal(slot.report, undefined);
  assert.match(slot.error ?? '', /schema validation/);
  const result = await tool.execute('2', { findings: [], notes: '', blockers: [] });
  assert.equal(result.terminate, true);
  assert.deepEqual(slot.report, { findings: [], notes: '', blockers: [] });
  assert.equal(slot.error, undefined);
});
