import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { captureSnapshot } from '../src/snapshot.ts';
import { materializeWorkspace } from '../src/workspace.ts';
import { defaultSettings } from '../src/settings.ts';
import { gitRepo } from './fixtures/git-repo.ts';

test('isolated workspace dereferences linked dependencies instead of preserving broken relative links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qa-linked-dep-'));
  const source = join(root, 'source');
  const linked = join(root, 'linked-package');
  const run = join(root, 'run');
  try {
    await mkdir(join(source, 'node_modules', '@scope'), { recursive: true });
    await mkdir(linked, { recursive: true });
    await writeFile(join(linked, 'package.json'), '{"name":"@scope/toolkit"}\n');
    await writeFile(join(linked, 'index.js'), 'export const ok = true;\n');
    await writeFile(join(source, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@scope/toolkit': { resolved: '../linked-package', link: true } } }));
    await symlink('../../../linked-package', join(source, 'node_modules', '@scope', 'toolkit'));
    const snapshot = {
      runId: 'linked', capturedAt: new Date().toISOString(), cwd: source, branch: null, head: null, base: null, baseKind: 'unresolved' as const, fingerprint: 'f'.repeat(64), dirty: true,
      paths: [], stagedPatch: '', unstagedPatch: '', combinedPatch: '', untracked: [], unsupported: [], scope: 'target' as const,
    };
    const workspace = await materializeWorkspace({ snapshot, blobs: new Map() }, run);
    try {
      const installed = join(workspace.path, 'node_modules', '@scope', 'toolkit');
      assert.equal((await lstat(installed)).isSymbolicLink(), false);
      assert.match(await readFile(join(installed, 'package.json'), 'utf8'), /@scope\/toolkit/);
      assert.match(await readFile(join(run, 'linked-package', 'package.json'), 'utf8'), /@scope\/toolkit/);
    } finally { await workspace.cleanup(); }
    await assert.rejects(lstat(join(run, 'linked-package')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('isolated workspace materializes large untracked files from captured bytes', async () => {
  const dir = await gitRepo();
  const runDir = await mkdtemp(join(tmpdir(), 'pi-qa-workspace-'));
  const content = 'large exact content\n'.repeat(20_000);
  try {
    await writeFile(join(dir, 'large.css'), content);
    const captured = await captureSnapshot(dir, { settings: defaultSettings() });
    assert.equal(captured.snapshot.paths.find(path => path.path === 'large.css')?.kind, 'large');
    const workspace = await materializeWorkspace(captured, runDir);
    try {
      assert.equal(await readFile(join(workspace.path, 'large.css'), 'utf8'), content);
      assert.equal(await readFile(join(dir, 'large.css'), 'utf8'), content);
    } finally {
      await workspace.cleanup();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  }
});

const bareSnapshot = (cwd: string) => ({
  runId: 'deps', capturedAt: new Date().toISOString(), cwd, branch: null, head: null, base: null, baseKind: 'unresolved' as const, fingerprint: 'f'.repeat(64), dirty: true,
  paths: [], stagedPatch: '', unstagedPatch: '', combinedPatch: '', untracked: [], unsupported: [], scope: 'target' as const,
});

test('bin shims stay relative links, so a tool finds its own files (the vite/eslint failure)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qa-bin-shims-'));
  const source = join(root, 'source');
  try {
    // npm layout: .bin/vite -> ../vite/bin/vite.js, which loads ../dist/node/cli.js relative to itself.
    await mkdir(join(source, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(source, 'node_modules', 'vite', 'bin'), { recursive: true });
    await mkdir(join(source, 'node_modules', 'vite', 'dist', 'node'), { recursive: true });
    await writeFile(join(source, 'node_modules', 'vite', 'bin', 'vite.js'),
      "#!/usr/bin/env node\nconsole.log(require('fs').readFileSync(require('path').join(__dirname, '../dist/node/cli.js'), 'utf8'));\n", { mode: 0o755 });
    await writeFile(join(source, 'node_modules', 'vite', 'dist', 'node', 'cli.js'), 'vite cli ok');
    await symlink('../vite/bin/vite.js', join(source, 'node_modules', '.bin', 'vite'));
    // pnpm layout: a package link into the tree's own store.
    await mkdir(join(source, 'node_modules', '.pnpm', 'eslint@9', 'node_modules', 'eslint'), { recursive: true });
    await writeFile(join(source, 'node_modules', '.pnpm', 'eslint@9', 'node_modules', 'eslint', 'package.json'), '{"name":"eslint"}');
    await symlink('.pnpm/eslint@9/node_modules/eslint', join(source, 'node_modules', 'eslint'));
    const workspace = await materializeWorkspace({ snapshot: bareSnapshot(source), blobs: new Map() }, join(root, 'run'));
    try {
      const shim = join(workspace.path, 'node_modules', '.bin', 'vite');
      assert.equal((await lstat(shim)).isSymbolicLink(), true);
      assert.equal(await readlink(shim), '../vite/bin/vite.js', 'the link stays relative, inside the copy');
      const ran = spawnSync(process.execPath, [shim], { encoding: 'utf8' });
      assert.equal(ran.status, 0, ran.stderr);
      assert.equal(ran.stdout.trim(), 'vite cli ok');
      assert.equal(await readlink(join(workspace.path, 'node_modules', 'eslint')), '.pnpm/eslint@9/node_modules/eslint');
      assert.match(await readFile(join(workspace.path, 'node_modules', 'eslint', 'package.json'), 'utf8'), /eslint/);
      assert.deepEqual(workspace.notes, [], 'a faithful copy needs no note');
    } finally { await workspace.cleanup(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shims that cannot survive the copy fall back to a clean lockfile install', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qa-bin-fallback-'));
  const source = join(root, 'source');
  const bin = join(root, 'fake-bin');
  const previousPath = process.env.PATH;
  try {
    // A shim pointing outside the tree is copied, not linked: it no longer works as a shim.
    await mkdir(join(source, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(root, 'elsewhere'), { recursive: true });
    await writeFile(join(root, 'elsewhere', 'tool.js'), 'x');
    await symlink('../../../elsewhere/tool.js', join(source, 'node_modules', '.bin', 'tool'));
    await writeFile(join(source, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
    // A stand-in npm that records its arguments and installs one working shim.
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'npm'), '#!/bin/sh\necho "$@" > npm-args.txt\nmkdir -p node_modules/.bin && ln -s ../pkg/cli.js node_modules/.bin/tool\n', { mode: 0o755 });
    process.env.PATH = `${bin}:${previousPath}`;
    // The lockfile reaches the workspace the way tracked files do: through the snapshot.
    const lockfile = Buffer.from('{"lockfileVersion":3,"packages":{}}');
    const snapshot = { ...bareSnapshot(source), paths: [{ path: 'package-lock.json', status: '??', kind: 'text' as const, size: lockfile.length, hash: 'lock' }] };
    const workspace = await materializeWorkspace({ snapshot: snapshot as any, blobs: new Map([['lock', lockfile]]) }, join(root, 'run'));
    try {
      assert.match(await readFile(join(workspace.path, 'npm-args.txt'), 'utf8'), /^ci --prefer-offline/);
      assert.equal(await readlink(join(workspace.path, 'node_modules', '.bin', 'tool')), '../pkg/cli.js');
      assert.match(workspace.notes.join('\n'), /installed with `npm ci --prefer-offline --no-audit --no-fund` from package-lock\.json because executable shims did not survive the copy \(tool\)/);
    } finally { await workspace.cleanup(); }
  } finally {
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
