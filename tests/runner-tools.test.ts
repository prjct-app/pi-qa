import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { buildActiveTools, sdkRunner, type RunnerInput } from '../src/runner.ts';
import { REVIEWER_REPORT_TOOL, TESTER_REPORT_TOOL, emptyContract, type AgentOutcome, type Snapshot } from '../src/schema.ts';
import { defaultSettings } from '../src/settings.ts';
import { gitRepo } from './fixtures/git-repo.ts';

const REVIEWER_SET = ['read', 'grep', 'find', 'ls', REVIEWER_REPORT_TOOL];
const TESTER_BASE = ['read', 'grep', 'find', 'ls', 'bash', TESTER_REPORT_TOOL];
const SPY_FIXTURE = fileURLToPath(new URL('./fixtures/mock-provider-tools-spy.ts', import.meta.url));

const bareSnapshot = (cwd: string): Snapshot => ({
  runId: 't314-spy',
  capturedAt: new Date().toISOString(),
  cwd,
  branch: null,
  head: null,
  base: null,
  baseKind: 'unresolved',
  fingerprint: 'f'.repeat(64),
  dirty: false,
  paths: [],
  stagedPatch: '',
  unstagedPatch: '',
  combinedPatch: '',
  untracked: [],
  unsupported: [],
  scope: 'target',
});

test('buildActiveTools: reviewer gets the existing read-only set, never qa_browser', () => {
  assert.deepEqual(buildActiveTools('reviewer', false), REVIEWER_SET);
  assert.deepEqual(buildActiveTools('reviewer', true), REVIEWER_SET,
    'reviewer must stay read-only even when the runner could supply a browser');
  assert.ok(!buildActiveTools('reviewer', true).includes('qa_browser'));
});

test('buildActiveTools: tester gets bash + report; qa_browser only when the runner has a browser', () => {
  assert.deepEqual(buildActiveTools('tester', false), TESTER_BASE);
  const testerWithBrowser = buildActiveTools('tester', true);
  assert.ok(testerWithBrowser.includes('qa_browser'),
    `tester with browser must include qa_browser, got ${testerWithBrowser.join(', ')}`);
  assert.ok(!TESTER_BASE.includes('qa_browser'),
    'qa_browser must not leak into the no-browser tester path');
});

const minimalRunner = (role: 'tester' | 'reviewer', workspace: string, artifactsDir: string, agentDir: string): RunnerInput => ({
  role,
  snapshot: bareSnapshot(workspace),
  contract: emptyContract(),
  workspace,
  artifactsDir,
  agentDir,
  model: { provider: 'qa-tools-spy', id: 'offline' },
  timeoutMs: 20_000,
  signal: AbortSignal.timeout(20_000),
  settings: defaultSettings(),
  extensionPaths: [SPY_FIXTURE],
});

/**
 * Integration regression for PRJ-T314: the tester session's active tool allowlist
 * must actually include `qa_browser` so the agent can invoke it; the reviewer
 * session's allowlist must remain unchanged. The spy fixture records the active
 * tool list passed into the model stream for each role, so we exercise the SDK
 * session end-to-end (not just the helper) while keeping the test offline.
 */
test('integration: tester session exposes qa_browser in active tools; reviewer session is unchanged', { timeout: 60_000 }, async () => {
  const dir = await gitRepo();
  const home = await mkdtemp(join(tmpdir(), 'pi-qa-tools-'));
  const agentDir = await mkdtemp(join(tmpdir(), 'pi-qa-tools-agent-'));
  const sideChannel = join(home, 'tools-spy.log');
  const previous = process.env.PI_QA_TOOLS_SPY_FILE;
  process.env.PI_QA_TOOLS_SPY_FILE = sideChannel;

  try {
    const reviewer: AgentOutcome = await sdkRunner(minimalRunner('reviewer', dir, home, agentDir));
    const tester: AgentOutcome = await sdkRunner(minimalRunner('tester', dir, home, agentDir));
    assert.equal(reviewer.status, 'completed', reviewer.error);
    assert.equal(tester.status, 'completed', tester.error);

    const lines = (await readFile(sideChannel, 'utf8')).split('\n').filter(Boolean);
    assert.equal(lines.length, 2, `expected two spy records (reviewer + tester), got ${lines.length}`);
    const records = lines.map(line => JSON.parse(line) as { role: 'tester' | 'reviewer' | 'unknown'; tools: string[] });
    const testerRecord = records.find(record => record.role === 'tester');
    const reviewerRecord = records.find(record => record.role === 'reviewer');
    assert.ok(testerRecord, `tester spy record missing; got roles ${records.map(r => r.role).join(',')}`);
    assert.ok(reviewerRecord, `reviewer spy record missing; got roles ${records.map(r => r.role).join(',')}`);

    assert.ok(testerRecord.tools.includes('qa_browser'),
      `tester active tools must include qa_browser, got: ${testerRecord.tools.join(', ')}`);
    assert.ok(testerRecord.tools.includes('bash'),
      `tester active tools must still include bash, got: ${testerRecord.tools.join(', ')}`);
    assert.ok(!reviewerRecord.tools.includes('qa_browser'),
      `reviewer active tools must not include qa_browser, got: ${reviewerRecord.tools.join(', ')}`);
    assert.deepEqual(
      reviewerRecord.tools.filter(name => !name.startsWith('pi_qa_')),
      ['read', 'grep', 'find', 'ls'],
      'reviewer read-only set must be unchanged',
    );
    assert.ok(reviewerRecord.tools.includes(REVIEWER_REPORT_TOOL));
    assert.ok(testerRecord.tools.includes(TESTER_REPORT_TOOL));
  } finally {
    if (previous === undefined) delete process.env.PI_QA_TOOLS_SPY_FILE;
    else process.env.PI_QA_TOOLS_SPY_FILE = previous;
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});
