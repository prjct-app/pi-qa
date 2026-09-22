import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureSnapshot } from '../src/snapshot.ts';
import { defaultSettings } from '../src/settings.ts';
import { gitRepo, writeWorktree } from './fixtures/git-repo.ts';
import { rm } from 'node:fs/promises';

const settings = defaultSettings();

test('captures untracked files in the snapshot fingerprint', async () => {
  const dir = await gitRepo();
  try {
    await writeWorktree(dir, 'new-file.ts', 'export const n = 1;\n');
    const captured = await captureSnapshot(dir, { settings });
    assert.equal(captured.snapshot.dirty, true);
    assert.ok(captured.snapshot.untracked.includes('new-file.ts'));
    assert.ok(captured.snapshot.paths.some(path => path.path === 'new-file.ts' && path.kind === 'text'));
    assert.ok(captured.blobs.size > 0);
    assert.match(captured.snapshot.fingerprint, /^[a-f0-9]{64}$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('clean worktree without a local base explains instead of inventing a pass', async () => {
  const dir = await gitRepo();
  try {
    const captured = await captureSnapshot(dir, { settings, base: 'does-not-exist' });
    assert.equal(captured.snapshot.baseKind, 'unresolved');
    assert.match(captured.snapshot.resolutionError ?? '', /--base|local/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('explicit filesystem target captures non-git files while excluding dependencies and secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qa-fs-target-'));
  try {
    await mkdir(join(dir, 'src'), { recursive: true });
    await mkdir(join(dir, 'node_modules', 'ignored'), { recursive: true });
    await writeFile(join(dir, 'package.json'), '{"name":"fixture"}\n');
    await writeFile(join(dir, 'src', 'index.ts'), 'export const value = 1;\n');
    await writeFile(join(dir, '.env'), 'SECRET=do-not-capture\n');
    await writeFile(join(dir, 'node_modules', 'ignored', 'index.js'), 'ignored\n');
    const captured = await captureSnapshot(dir, { settings, scope: 'target', filesystemTarget: true, targetPaths: ['.'] });
    assert.deepEqual(captured.snapshot.paths.map(path => path.path).sort(), ['package.json', 'src/index.ts']);
    assert.deepEqual(captured.snapshot.targetPaths, ['.']);
    assert.doesNotMatch(captured.snapshot.combinedPatch, /do-not-capture|ignored/);
    assert.equal(captured.snapshot.resolutionError, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('records binary, large, and symlink paths as unsupported evidence instead of omitting them', async () => {
  const dir = await gitRepo();
  try {
    await writeFile(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 9]));
    await writeFile(join(dir, 'huge.txt'), 'x'.repeat(settings.largeFileBytes + 10));
    const { symlink } = await import('node:fs/promises');
    await symlink('README.md', join(dir, 'link.md'));
    const captured = await captureSnapshot(dir, { settings });
    const kinds = new Set(captured.snapshot.paths.map(path => path.kind));
    assert.ok(kinds.has('binary'));
    assert.ok(kinds.has('large'));
    assert.ok(kinds.has('symlink'));
    const large = captured.snapshot.paths.find(path => path.path === 'huge.txt');
    assert.ok(large?.hash);
    assert.equal(captured.blobs.get(large.hash)?.length, settings.largeFileBytes + 10);
    assert.ok(captured.snapshot.unsupported.length >= 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
