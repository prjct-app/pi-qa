import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { git, parseNameStatus, splitZ, type GitExec } from './git.ts';
import { sha256Hex } from './text.ts';
import type { ChangedPath, Snapshot } from './schema.ts';
import type { QaSettings } from './settings.ts';

const LOCAL_BASES = ['main', 'master', 'develop'] as const;

export type SnapshotBlobs = Map<string, Buffer>;

export type CapturedSnapshot = {
  snapshot: Snapshot;
  blobs: SnapshotBlobs;
};

export async function captureSnapshot(cwd: string, options: {
  git?: GitExec;
  settings: QaSettings;
  base?: string;
  now?: () => string;
  runId?: string;
  scope?: 'change' | 'target';
  filesystemTarget?: boolean;
  targetPaths?: string[];
}): Promise<CapturedSnapshot> {
  const run = options.git ?? git;
  const runId = options.runId ?? randomUUID();
  const scope = options.scope ?? 'change';
  const capturedAt = (options.now ?? (() => new Date().toISOString()))();
  if (options.filesystemTarget) return captureFilesystemTarget(cwd, runId, capturedAt, options.settings, options.targetPaths ?? ['.']);
  const inside = await run(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    if (scope === 'target') return { snapshot: emptyTarget(runId, capturedAt, cwd), blobs: new Map() };
    return { snapshot: unresolved(runId, capturedAt, cwd, 'Not a git worktree. Initialize a repository or run from a checkout.'), blobs: new Map() };
  }
  const head = trim(await run(cwd, ['rev-parse', 'HEAD']));
  const branch = trim(await run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']));
  const dirty = await isDirty(cwd, run);
  const resolvedBase = dirty ? undefined : await resolveLocalBase(cwd, run, options.base);
  const base = dirty
    ? (head.value ? { sha: head.value, kind: 'worktree' as const } : undefined)
    : resolvedBase ?? (scope === 'target' && head.value ? { sha: head.value, kind: 'worktree' as const } : undefined);
  if (!base) {
    return {
      snapshot: unresolved(runId, capturedAt, cwd, 'Working tree is clean and no trustworthy local base was found. Pass --base <local-ref>. Remote branches are not fetched.', head.value, branch.value),
      blobs: new Map(),
    };
  }
  const range = dirty ? 'HEAD' : `${base.sha}...HEAD`;
  const nameStatus = parseNameStatus(splitZ((await run(cwd, ['diff', '-z', '--name-status', '-M', range])).stdout));
  const untracked = splitZ((await run(cwd, ['ls-files', '-z', '--others', '--exclude-standard'])).stdout);
  const stagedPatch = (await run(cwd, ['diff', '--cached', '--binary', '--no-ext-diff', '-M'])).stdout;
  const unstagedPatch = (await run(cwd, ['diff', '--binary', '--no-ext-diff', '-M'])).stdout;
  const combinedPatch = dirty
    ? (await run(cwd, ['diff', 'HEAD', '--binary', '--no-ext-diff', '-M'])).stdout
    : (await run(cwd, ['diff', '--binary', '--no-ext-diff', '-M', `${base.sha}...HEAD`])).stdout;
  const modes = await stagedModes(cwd, run);
  const blobs: SnapshotBlobs = new Map();
  const changed = await Promise.all(nameStatus.map(entry => describePath(cwd, entry, modes, blobs, options.settings)));
  const untrackedPaths = await Promise.all(untracked.map(path => describePath(cwd, { status: '??', path }, modes, blobs, options.settings)));
  const paths = [...changed, ...untrackedPaths.filter(path => !changed.some(item => item.path === path.path))];
  const unsupported = paths.flatMap(path => path.omittedReason ? [{ path: path.path, reason: path.omittedReason }] : []);
  if (paths.length === 0 && !dirty && scope === 'change') {
    return {
      snapshot: {
        ...unresolved(runId, capturedAt, cwd, `No commits between ${base.sha.slice(0, 8)} and HEAD, and the working tree is clean.`, head.value, branch.value, scope),
        base: base.sha,
        baseKind: base.kind,
      },
      blobs,
    };
  }
  const snapshot: Snapshot = {
    runId, scope, capturedAt, cwd,
    branch: branch.value,
    head: head.value,
    base: base.sha,
    baseKind: base.kind,
    fingerprint: '',
    dirty,
    paths,
    stagedPatch,
    unstagedPatch,
    combinedPatch,
    untracked,
    unsupported,
  };
  return { snapshot: { ...snapshot, fingerprint: fingerprintOf(snapshot) }, blobs };
}

export function fingerprintOf(snapshot: Pick<Snapshot, 'scope' | 'targetPaths' | 'head' | 'base' | 'paths' | 'untracked' | 'combinedPatch' | 'stagedPatch' | 'unstagedPatch'>): string {
  return sha256Hex(JSON.stringify({
    scope: snapshot.scope,
    targetPaths: snapshot.targetPaths ?? [],
    head: snapshot.head,
    base: snapshot.base,
    paths: snapshot.paths.map(path => ({ path: path.path, previousPath: path.previousPath, status: path.status, kind: path.kind, hash: path.hash, size: path.size })),
    untracked: snapshot.untracked,
    patch: sha256Hex(snapshot.combinedPatch),
    staged: sha256Hex(snapshot.stagedPatch),
    unstaged: sha256Hex(snapshot.unstagedPatch),
  }));
}

export async function currentFingerprint(cwd: string, options: { git?: GitExec; settings: QaSettings; base?: string; scope?: 'change' | 'target'; filesystemTarget?: boolean; targetPaths?: string[] }): Promise<string | undefined> {
  const captured = await captureSnapshot(cwd, { ...options, runId: 'probe' });
  if (captured.snapshot.resolutionError) return undefined;
  return captured.snapshot.fingerprint;
}

const trim = (result: { stdout: string; code: number }): { value: string | null } =>
  ({ value: result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null });

const isDirty = async (cwd: string, run: GitExec): Promise<boolean> => {
  const status = await run(cwd, ['status', '--porcelain=v1', '-uall']);
  return status.stdout.trim().length > 0;
};

const resolveLocalBase = async (cwd: string, run: GitExec, explicit?: string): Promise<{ sha: string; kind: 'local-ref' } | undefined> => {
  if (explicit) {
    const resolved = await run(cwd, ['rev-parse', '--verify', '--quiet', explicit]);
    if (resolved.code === 0 && resolved.stdout.trim()) return { sha: resolved.stdout.trim(), kind: 'local-ref' };
    return undefined;
  }
  const upstream = await run(cwd, ['rev-parse', '--verify', '--quiet', '@{upstream}']);
  const named = await Promise.all(LOCAL_BASES.map(async name => {
    const local = await run(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
    if (local.code === 0 && local.stdout.trim()) return local.stdout.trim();
    const remote = await run(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`]);
    return remote.code === 0 ? remote.stdout.trim() || undefined : undefined;
  }));
  const candidate = (upstream.code === 0 ? upstream.stdout.trim() : undefined) ?? named.find(Boolean);
  if (!candidate) return undefined;
  const mergeBase = await run(cwd, ['merge-base', 'HEAD', candidate]);
  if (mergeBase.code !== 0 || !mergeBase.stdout.trim()) return undefined;
  return { sha: mergeBase.stdout.trim(), kind: 'local-ref' };
};

const stagedModes = async (cwd: string, run: GitExec): Promise<Map<string, string>> => {
  const listed = await run(cwd, ['ls-files', '-s', '-z']);
  return parseLsFiles(splitZ(listed.stdout), new Map());
};

const parseLsFiles = (parts: string[], acc: Map<string, string>): Map<string, string> => {
  if (parts.length === 0) return acc;
  const record = parts[0]!;
  const tab = record.indexOf('\t');
  const meta = tab >= 0 ? record.slice(0, tab) : record;
  const path = tab >= 0 ? record.slice(tab + 1) : '';
  const mode = meta.split(/\s+/)[0] ?? '';
  if (path) acc.set(path, mode);
  return parseLsFiles(parts.slice(1), acc);
};

const describePath = async (cwd: string, entry: { status: string; path: string; previousPath?: string }, modes: Map<string, string>, blobs: SnapshotBlobs, settings: QaSettings): Promise<ChangedPath> => {
  const mode = modes.get(entry.path);
  if (mode === '160000') {
    return { path: entry.path, previousPath: entry.previousPath, status: entry.status, kind: 'submodule', omittedReason: 'Submodule (gitlink) is unsupported evidence.' };
  }
  const abs = join(cwd, entry.path);
  try {
    const stat = await lstat(abs);
    if (stat.isSymbolicLink()) {
      const target = await readlink(abs);
      return { path: entry.path, previousPath: entry.previousPath, status: entry.status, kind: 'symlink', size: stat.size, symlinkTarget: target, omittedReason: 'Symlink recorded as target only; contents were not followed.' };
    }
    if (stat.isDirectory()) {
      return { path: entry.path, previousPath: entry.previousPath, status: entry.status, kind: 'submodule', omittedReason: 'Directory entries (including nested repositories) are unsupported evidence.' };
    }
    const buf = await readFile(abs);
    const hash = sha256Hex(buf);
    if (stat.size > settings.largeFileBytes) {
      // Keep exact bytes for immutable workspace reconstruction; only prompt inlining is unsupported.
      blobs.set(hash, buf);
      return { path: entry.path, previousPath: entry.previousPath, status: entry.status, kind: 'large', hash, size: stat.size, omittedReason: `File exceeds ${settings.largeFileBytes} bytes; content excluded from agent prompts, hash recorded.` };
    }
    if (buf.includes(0)) {
      blobs.set(hash, buf);
      return { path: entry.path, previousPath: entry.previousPath, status: entry.status, kind: 'binary', hash, size: stat.size, omittedReason: 'Binary file; hash recorded, content not inlined.' };
    }
    blobs.set(hash, buf);
    return { path: entry.path, previousPath: entry.previousPath, status: entry.status, kind: 'text', hash, size: stat.size };
  } catch {
    if (entry.status.startsWith('D')) {
      return { path: entry.path, previousPath: entry.previousPath, status: entry.status, kind: 'missing' };
    }
    return { path: entry.path, previousPath: entry.previousPath, status: entry.status, kind: 'missing', omittedReason: 'Path could not be read at capture time.' };
  }
};

const captureFilesystemTarget = async (cwd: string, runId: string, capturedAt: string, settings: QaSettings, roots: string[]): Promise<CapturedSnapshot> => {
  const normalizedRoots = roots.map(root => root === '.' ? '.' : relative(cwd, resolve(cwd, root))).filter(root => root === '.' || (root && !root.startsWith(`..${sep}`) && root !== '..'));
  if (normalizedRoots.length !== roots.length) {
    return { snapshot: unresolved(runId, capturedAt, cwd, 'Explicit target escapes its capture root.', null, null, 'target'), blobs: new Map() };
  }
  const files = [...new Set((await Promise.all(normalizedRoots.map(root => walkTarget(cwd, root)))).flat())].sort();
  if (files.length > 10_000) {
    return { snapshot: unresolved(runId, capturedAt, cwd, `Explicit target has ${files.length} files; limit is 10000. Narrow --target.`, null, null, 'target'), blobs: new Map() };
  }
  const stats = await Promise.all(files.map(async path => ({ path, stat: await lstat(join(cwd, path)) })));
  const bytes = stats.reduce((total, item) => total + (item.stat.isFile() ? item.stat.size : 0), 0);
  if (bytes > 512 * 1024 * 1024) {
    return { snapshot: unresolved(runId, capturedAt, cwd, `Explicit target is ${bytes} bytes; limit is 536870912. Narrow --target.`, null, null, 'target'), blobs: new Map() };
  }
  const blobs: SnapshotBlobs = new Map();
  const paths = await Promise.all(files.map(path => describePath(cwd, { status: '??', path }, new Map(), blobs, settings)));
  const combinedPatch = paths.flatMap(path => {
    if (path.kind !== 'text' || !path.hash) return [];
    const content = blobs.get(path.hash)?.toString('utf8') ?? '';
    return [`--- /dev/null\n+++ b/${path.path}\n@@ full target file @@\n${content}\n`];
  }).join('').slice(0, settings.patchChars);
  const unsupported = paths.flatMap(path => path.omittedReason ? [{ path: path.path, reason: path.omittedReason }] : []);
  const snapshot: Snapshot = {
    runId, scope: 'target', targetPaths: normalizedRoots, capturedAt, cwd, branch: null, head: null, base: null, baseKind: 'unresolved', fingerprint: '', dirty: true,
    paths, stagedPatch: '', unstagedPatch: '', combinedPatch, untracked: files, unsupported,
  };
  return { snapshot: { ...snapshot, fingerprint: fingerprintOf(snapshot) }, blobs };
};

const walkTarget = async (cwd: string, path: string): Promise<string[]> => {
  const absolute = resolve(cwd, path);
  const root = resolve(cwd);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) return [];
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return [path];
  const entries = await readdir(absolute, { withFileTypes: true });
  const visible = entries.filter(entry => !ignoredTargetEntry(entry.name));
  return (await Promise.all(visible.map(entry => walkTarget(cwd, path === '.' ? entry.name : join(path, entry.name))))).flat();
};

const ignoredTargetEntry = (name: string): boolean =>
  name === '.git' || name === 'node_modules' || name === '.prjct' || name === 'qa-results' || name === '.DS_Store'
  || name === '.env' || name.startsWith('.env.') || name === '.npmrc' || /\.(?:pem|key|p12|pfx)$/i.test(name);

const unresolved = (runId: string, capturedAt: string, cwd: string, resolutionError: string, head: string | null = null, branch: string | null = null, scope: 'change' | 'target' = 'change'): Snapshot => ({
  runId, scope, capturedAt, cwd, branch, head, base: null, baseKind: 'unresolved', fingerprint: sha256Hex(resolutionError),
  dirty: false, paths: [], stagedPatch: '', unstagedPatch: '', combinedPatch: '', untracked: [], unsupported: [], resolutionError,
});

const emptyTarget = (runId: string, capturedAt: string, cwd: string): Snapshot => {
  const snapshot: Snapshot = {
    runId, scope: 'target', capturedAt, cwd, branch: null, head: null, base: null, baseKind: 'unresolved', fingerprint: '', dirty: false,
    paths: [], stagedPatch: '', unstagedPatch: '', combinedPatch: '', untracked: [], unsupported: [],
  };
  return { ...snapshot, fingerprint: fingerprintOf(snapshot) };
};
