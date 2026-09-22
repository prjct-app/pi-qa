import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness } from './harness.ts';
import { fakeJev, fakeRunner, memoryStore } from './fixtures/fakes.ts';
import { gitRepo, writeWorktree } from './fixtures/git-repo.ts';
import { defaultSettings } from '../src/settings.ts';
import { CONTRACT_TOOL } from '../src/schema.ts';

for (const mode of ['tui', 'rpc'] as const) {
  test(`/qa works in ${mode} and launches one QA agent`, async () => {
    const dir = await gitRepo();
    const dest = await mkdtemp(join(tmpdir(), 'pi-qa-ext-'));
    await writeWorktree(dir, 'src.js', 'export const add = (a, b) => a - b;\n');
    const launched: string[] = [];
    const selectedModels: string[] = [];
    const model = (id: string, input: number) => ({ provider: 'qa-fixture', id, name: id, api: 'fixture', baseUrl: '', reasoning: true, input: ['text'], cost: { input, output: input, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8_000 });
    const host = harness(dir, {
      mode,
      model: { provider: 'qa-fixture', id: 'frontier-max' },
      availableModels: [model('frontier-max', 20), model('qa-mini', 1)],
      dependencies: {
        store: memoryStore('k'.repeat(20)),
        home: dest,
        settings: defaultSettings(),
        env: {},
        jevFactory: fakeJev({ criterion: 'supports', relevant: true }),
        runner: async input => {
          launched.push(input.role);
          selectedModels.push(input.model.id);
          return fakeRunner({})(input);
        },
      },
    });
    try {
      await host.command('');
      assert.deepEqual(launched, ['tester']);
      assert.deepEqual(selectedModels, ['qa-mini']);
      if (mode === 'tui') assert.equal(host.customCalls.length, 1);
      else assert.ok(host.notices.some(text => /NOT_VERIFIED|PASS|FAIL|STALE/.test(text)));
      await host.command('status');
      await host.emit('session_shutdown');
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(dest, { recursive: true, force: true });
    }
  });
}

test('/qa still runs without a global evaluator and says why there is no verdict', async () => {
  const dir = await gitRepo();
  const dest = await mkdtemp(join(tmpdir(), 'qa-preflight-'));
  const launched: string[] = [];
  const host = harness(dir, {
    mode: 'rpc',
    dependencies: {
      store: memoryStore(), home: dest, settings: defaultSettings(), env: {},
      runner: async input => { launched.push(input.role); return fakeRunner({})(input); },
    },
  });
  try {
    await host.command('smoke test this extension');
    assert.ok(launched.length > 0, 'the QA agents ran instead of the command refusing to start');
    assert.ok(host.notices.some(text => /cannot reach a verdict/i.test(text)));
    assert.ok(host.notices.some(text => /\/qa evaluate/i.test(text)));
  } finally {
    await host.emit('session_shutdown');
    await rm(dir, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test('a run without a key keeps its evidence and reaches NOT_VERIFIED, not a refusal', async () => {
  const dir = await gitRepo();
  const dest = await mkdtemp(join(tmpdir(), 'qa-nokey-'));
  const host = harness(dir, {
    mode: 'rpc',
    dependencies: { store: memoryStore(), home: dest, settings: defaultSettings(), env: {}, runner: fakeRunner({}) },
  });
  try {
    await host.command('smoke test this extension');
    const verdicts = host.entries.filter(entry => /NOT_VERIFIED/.test(JSON.stringify(entry)));
    assert.ok(verdicts.length > 0, 'the run produced a NOT_VERIFIED outcome rather than refusing to start');
  } finally {
    await host.emit('session_shutdown');
    await rm(dir, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test('/qa setup uses the shared docked secret UI without localhost server', async () => {
  const dir = await gitRepo();
  const host = harness(dir, { mode: 'tui', dependencies: { store: memoryStore(), settings: defaultSettings(), env: {} } });
  try {
    await host.command('setup');
    assert.equal(host.customCalls.length, 1);
    assert.equal(host.notices.some(text => /127\.0\.0\.1|localhost/i.test(text)), false);
  } finally {
    await host.emit('session_shutdown');
    await rm(dir, { recursive: true, force: true });
  }
});

test('/qa accepts an explicit QA mission without requiring a diff', async () => {
  const dir = await gitRepo();
  const dest = await mkdtemp(join(tmpdir(), 'qa-target-'));
  const launched: Array<{ role: string; scope: string | undefined; criterion: string | undefined }> = [];
  const host = harness(dir, {
    dependencies: {
      store: memoryStore('k'.repeat(20)), home: dest, settings: defaultSettings(), env: {},
      jevFactory: fakeJev({ criterion: 'supports', relevant: true }),
      runner: async input => {
        launched.push({ role: input.role, scope: input.snapshot.scope, criterion: input.contract.items.find(item => item.id === 'U1')?.text });
        return fakeRunner({})(input);
      },
    },
  });
  try {
    await host.command('smoke test https://example.test/login');
    assert.deepEqual(launched.map(item => item.role), ['tester']);
    assert.ok(launched.every(item => item.scope === 'target'));
    assert.ok(launched.every(item => item.criterion === 'smoke test https://example.test/login'));
  } finally {
    await host.emit('session_shutdown');
    await rm(dir, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test('/qa infers the pi-qa target when the mission says this extension', async () => {
  const dir = await gitRepo();
  const target = join(dir, 'pi-qa-source');
  const dest = await mkdtemp(join(tmpdir(), 'qa-self-target-'));
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'package.json'), '{"name":"@prjct.app/pi-qa"}\n');
  const seen: string[] = [];
  const host = harness(dir, {
    dependencies: {
      selfTarget: target,
      store: memoryStore('k'.repeat(20)), home: dest, settings: defaultSettings(), env: {},
      jevFactory: fakeJev({ criterion: 'supports', relevant: true }),
      runner: async input => {
        seen.push(`${input.role}:${input.snapshot.cwd}:${input.snapshot.paths.map(path => path.path).join(',')}`);
        return fakeRunner({})(input);
      },
    },
  });
  try {
    await host.command('realiza una prueba completa de la extension');
    assert.ok(seen.every(value => value.includes(`${target}:package.json`)));
  } finally {
    await host.emit('session_shutdown');
    await rm(dir, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test('/qa --target captures a quoted non-git directory for the QA agent', async () => {
  const dir = await gitRepo();
  const target = join(dir, 'fixture target');
  const dest = await mkdtemp(join(tmpdir(), 'qa-explicit-target-'));
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'package.json'), '{"name":"target"}\n');
  const seen: string[] = [];
  const host = harness(dir, {
    dependencies: {
      store: memoryStore('k'.repeat(20)), home: dest, settings: defaultSettings(), env: {},
      jevFactory: fakeJev({ criterion: 'supports', relevant: true }),
      runner: async input => {
        seen.push(`${input.role}:${await readFile(join(input.workspace, 'package.json'), 'utf8')}`);
        assert.deepEqual(input.snapshot.targetPaths, ['.']);
        return fakeRunner({})(input);
      },
    },
  });
  try {
    await host.command('--target "fixture target" smoke test the package');
    assert.deepEqual(seen, ['tester:{"name":"target"}\n']);
  } finally {
    await host.emit('session_shutdown');
    await rm(dir, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test('/qa cancel bypasses the run queue and aborts active agents immediately', async () => {
  const dir = await gitRepo();
  const dest = await mkdtemp(join(tmpdir(), 'qa-cancel-'));
  await writeWorktree(dir, 'src.js', 'export const value = 2;\n');
  const launched: string[] = [];
  const gate: { resolve?: () => void } = {};
  const started = new Promise<void>(resolve => { gate.resolve = resolve; });
  const host = harness(dir, {
    dependencies: {
      store: memoryStore('k'.repeat(20)), home: dest, settings: { ...defaultSettings(), timeoutMs: 10_000 }, env: {},
      jevFactory: fakeJev({ criterion: 'supports', relevant: true }),
      runner: async input => {
        launched.push(input.role);
        if (launched.length === 1) gate.resolve?.();
        await new Promise<void>(resolve => input.signal.aborted ? resolve() : input.signal.addEventListener('abort', () => resolve(), { once: true }));
        return { role: input.role, status: 'canceled', error: 'Canceled.', latencyMs: 1 };
      },
    },
  });
  try {
    const running = host.command('exercise cancellation');
    await started;
    await Promise.race([
      host.command('cancel'),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('/qa cancel waited behind the run queue')), 500)),
    ]);
    await running;
    assert.deepEqual(launched, ['tester']);
    assert.ok(host.notices.some(text => /Canceling/gi.test(text)));
  } finally {
    await host.emit('session_shutdown');
    await rm(dir, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test('/qa evaluate without a snapshot starts a fresh QA run', async () => {
  const dir = await gitRepo();
  const dest = await mkdtemp(join(tmpdir(), 'pi-qa-evaluate-fresh-'));
  await writeWorktree(dir, 'src.js', 'export const add = (a, b) => a - b;\n');
  const launched: string[] = [];
  const host = harness(dir, {
    dependencies: {
      store: memoryStore('k'.repeat(20)), home: dest, settings: defaultSettings(), env: {},
      jevFactory: fakeJev({ criterion: 'supports', relevant: true }),
      runner: async input => { launched.push(input.role); return fakeRunner({})(input); },
    },
  });
  try {
    await host.command('evaluate');
    assert.deepEqual(launched, ['tester']);
    assert.ok(host.notices.some(text => /Starting a fresh QA run/gi.test(text)));
  } finally {
    await host.emit('session_shutdown');
    await rm(dir, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});

test('pi_qa_contract stores a pending contract and rejects inferred relabeling on run', async () => {
  const dir = await gitRepo();
  const dest = await mkdtemp(join(tmpdir(), 'pi-qa-contract-'));
  await writeWorktree(dir, 'src.js', 'export const add = (a, b) => a + 1;\n');
  const host = harness(dir, {
    dependencies: {
      store: memoryStore('k'.repeat(20)),
      home: dest,
      settings: defaultSettings(),
      env: {},
      jevFactory: fakeJev({ criterion: 'supports', test: 'supports' }),
      runner: fakeRunner({}),
    },
  });
  try {
    const result = await host.tool(CONTRACT_TOOL, {
      description: 'change add',
      items: [{ id: 'U1', text: 'Add subtract', source: 'user_request', sourceRef: 'model', required: true, observe: 'test it' }],
      invariants: [], regressionRisks: [], definitionOfReady: [], definitionOfDone: [],
    });
    assert.match(JSON.stringify(result.content), /Contract stored/);
    await host.command('run');
    assert.ok(host.customCalls.length > 0);
  } finally {
    await host.emit('session_shutdown');
    await rm(dir, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  }
});
