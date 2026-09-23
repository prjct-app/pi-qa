import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, readlink, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { git, gitBuffer, type GitExec } from './git.ts';
import type { CapturedSnapshot } from './snapshot.ts';

/**
 * Dependency trees are copied, never linked to the user's checkout: a link
 * would allow tester commands to mutate it. Links inside a tree are kept as links
 * (see copyTree), because tools resolve their own files from where they sit.
 */
const COPIED = ['node_modules', 'vendor'] as const;

/** Lockfile installs used when a faithful copy is not possible, in preference order. */
const INSTALLERS: readonly { lockfile: string; command: string; args: readonly string[] }[] = [
  { lockfile: 'pnpm-lock.yaml', command: 'pnpm', args: ['install', '--frozen-lockfile', '--prefer-offline'] },
  { lockfile: 'bun.lock', command: 'bun', args: ['install', '--frozen-lockfile'] },
  { lockfile: 'bun.lockb', command: 'bun', args: ['install', '--frozen-lockfile'] },
  { lockfile: 'yarn.lock', command: 'yarn', args: ['install', '--frozen-lockfile'] },
  { lockfile: 'package-lock.json', command: 'npm', args: ['ci', '--prefer-offline', '--no-audit', '--no-fund'] },
];
const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** Virtualenvs carry absolute interpreter paths; copying breaks them, linking would share them. */
const SKIPPED = ['.venv'] as const;

const CAP_FILES = 60_000;
const CAP_BYTES = 2 ** 31;

export type IsolatedWorkspace = {
  path: string;
  notes: string[];
  cleanup: () => Promise<void>;
};

export async function materializeWorkspace(captured: CapturedSnapshot, runDir: string, options: {
  git?: GitExec;
} = {}): Promise<IsolatedWorkspace> {
  const cwd = captured.snapshot.cwd;
  const dest = join(runDir, 'workspace');
  const run = options.git ?? git;
  const slot: { worktree: boolean } = { worktree: false };
  if (captured.snapshot.head) {
    const added = await run(cwd, ['worktree', 'add', '--detach', dest, captured.snapshot.head], { isolated: true });
    if (added.code === 0) slot.worktree = true;
    else {
      await mkdir(dest, { recursive: true, mode: 0o700 });
      await extractArchive(cwd, dest);
    }
  } else {
    await mkdir(dest, { recursive: true, mode: 0o700 });
  }
  await overlay(dest, captured);
  // A tracked ambient ticket can arrive through the base worktree or archive.
  await unlink(join(dest, '.pi', 'ticket.md')).catch(() => undefined);
  const dependencies = await copyDependencyTrees(cwd, dest);
  return {
    path: dest,
    notes: dependencies.notes,
    cleanup: async () => {
      if (slot.worktree) await run(cwd, ['worktree', 'remove', '--force', dest], { isolated: true }).catch(() => undefined);
      await rm(dest, { recursive: true, force: true });
      await Promise.all(dependencies.extraPaths.map(path => rm(path, { recursive: true, force: true })));
    },
  };
}

const extractArchive = async (cwd: string, dest: string): Promise<void> => {
  const archived = await gitBuffer(cwd, ['archive', '--format=tar', 'HEAD']);
  if (archived.code !== 0) return;
  await new Promise<void>((resolvePromise, reject) => {
    const tar = spawn('tar', ['-x', '-C', dest], { stdio: ['pipe', 'ignore', 'pipe'] });
    tar.on('error', reject);
    tar.on('close', code => code === 0 ? resolvePromise() : reject(new Error(`tar extract failed (${code})`)));
    tar.stdin.end(archived.stdout);
  }).catch(() => undefined);
};

const overlay = async (dest: string, captured: CapturedSnapshot): Promise<void> => {
  await Promise.all(captured.snapshot.paths.map(async path => {
    const target = join(dest, path.path);
    if (path.status.startsWith('D') && !path.previousPath) {
      await unlink(target).catch(() => undefined);
      return;
    }
    if (path.previousPath) await unlink(join(dest, path.previousPath)).catch(() => undefined);
    if (path.kind === 'symlink' && path.symlinkTarget) {
      await mkdir(dirname(target), { recursive: true });
      await unlink(target).catch(() => undefined);
      await symlink(path.symlinkTarget, target);
      return;
    }
    if ((path.kind === 'text' || path.kind === 'binary' || path.kind === 'large') && path.hash) {
      const blob = captured.blobs.get(path.hash);
      if (!blob) return;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, blob);
    }
  }));
};

const copyDependencyTrees = async (cwd: string, dest: string): Promise<{ notes: string[]; extraPaths: string[] }> => {
  const notes: string[] = [];
  await Promise.all(SKIPPED.map(async name => {
    if (await exists(join(cwd, name))) notes.push(`Workspace isolation: ${name} was not copied (environment-specific); tester commands needing it must set it up.`);
  }));
  await Promise.all(COPIED.map(async name => {
    const from = join(cwd, name);
    if (!await exists(from)) return;
    const outcome = await copyTree(from, join(dest, name));
    const broken = outcome === 'copied' && name === 'node_modules' ? await brokenBins(from, join(dest, name)) : [];
    if (outcome === 'copied' && broken.length === 0) return;
    const why = outcome === 'too-large' ? `it exceeds the copy budget (${CAP_FILES} files / ${CAP_BYTES} bytes)`
      : outcome === 'error' ? 'the copy failed'
      : `executable shims did not survive the copy (${broken.slice(0, 3).join(', ')})`;
    if (name !== 'node_modules') {
      notes.push(`Workspace isolation: ${name} was not copied because ${why}; tester commands must set it up.`);
      return;
    }
    await rm(join(dest, name), { recursive: true, force: true }).catch(() => undefined);
    notes.push(await installDependencies(dest, why));
  }));
  const local = await declaredLocalDependencies(cwd, dest);
  const outcomes = await Promise.all(local.map(async dependency => ({ dependency, outcome: await copyTree(dependency.source, dependency.destination, true) })));
  outcomes.forEach(({ dependency, outcome }) => {
    if (outcome === 'copied') notes.push(`Declared local dependency materialized: ${dependency.reference}`);
    else notes.push(`Declared local dependency unavailable in isolation: ${dependency.reference} (${outcome}).`);
  });
  return { notes, extraPaths: outcomes.filter(item => item.outcome === 'copied').map(item => item.dependency.destination) };
};

/**
 * Copies a dependency tree so it behaves like the original.
 *
 * A link that stays inside the tree is recreated as the same relative link:
 * `node_modules/.bin/vite -> ../vite/bin/vite.js` must stay a link, because the
 * script finds its own files relative to where it really lives. Copying its
 * contents instead left a script that looked for `node_modules/dist/node/cli.js`.
 * A link that leaves the tree (a `file:` package, a pnpm store elsewhere) is
 * copied, so nothing in the workspace points back into the user's checkout.
 * File data is cloned copy-on-write where the filesystem supports it.
 */
const copyTree = async (from: string, to: string, external = false): Promise<'copied' | 'too-large' | 'error'> => {
  const budget = { files: 0, bytes: 0 };
  try {
    await mkdir(to, { recursive: true, mode: 0o700 });
    const root = await realpath(from);
    const visiting = new Set<string>();
    const copyOne = async (srcPath: string, destPath: string, linked = false): Promise<void> => {
      const stat = await lstat(srcPath);
      if (stat.isSymbolicLink()) {
        const target = await readlink(srcPath);
        const absolute = resolve(dirname(srcPath), target);
        if (!linked && (absolute === root || absolute.startsWith(`${root}${sep}`))) {
          budget.files += 1;
          await symlink(relative(dirname(srcPath), absolute) || '.', destPath);
          return;
        }
        const resolved = await realpath(srcPath);
        if (visiting.has(resolved)) return;
        visiting.add(resolved);
        try { await copyOne(resolved, destPath, true); } finally { visiting.delete(resolved); }
        return;
      }
      if (stat.isDirectory()) {
        await mkdir(destPath, { recursive: true });
        const entries = await readdir(srcPath, { withFileTypes: true });
        await Promise.all(entries.filter(entry => !(linked && excludedDependencyEntry(entry.name))).map(entry => copyOne(join(srcPath, entry.name), join(destPath, entry.name), linked)));
        return;
      }
      budget.files += 1;
      budget.bytes += stat.size;
      if (budget.files > CAP_FILES || budget.bytes > CAP_BYTES) throw new Error('budget');
      await copyFile(srcPath, destPath, constants.COPYFILE_FICLONE);
    };
    await copyOne(root, to, external);
    return 'copied';
  } catch (error) {
    await rm(to, { recursive: true, force: true }).catch(() => undefined);
    return String(error).includes('budget') ? 'too-large' : 'error';
  }
};

const declaredLocalDependencies = async (cwd: string, dest: string): Promise<Array<{ source: string; destination: string; reference: string }>> => {
  const lockReferences = await readJson(join(cwd, 'package-lock.json')).then(value => Object.values((value.packages ?? {}) as Record<string, { resolved?: unknown; link?: unknown }>).flatMap(entry =>
    entry.link === true && typeof entry.resolved === 'string' ? [entry.resolved] : [],
  )).catch(() => [] as string[]);
  const manifestReferences = await readJson(join(cwd, 'package.json')).then(value => {
    const sections = [value.dependencies, value.devDependencies, value.optionalDependencies] as Array<Record<string, unknown> | undefined>;
    return sections.flatMap(section => Object.values(section ?? {}).flatMap(spec => typeof spec === 'string' && spec.startsWith('file:') ? [spec.slice(5)] : []));
  }).catch(() => [] as string[]);
  const references = [...new Set([...lockReferences, ...manifestReferences])];
  const runRoot = resolve(dirname(dest));
  return references.flatMap(reference => {
    const source = resolve(cwd, reference);
    const destination = resolve(dest, reference);
    const safe = destination === runRoot || destination.startsWith(`${runRoot}${sep}`);
    return safe ? [{ source, destination, reference }] : [];
  });
};

/** Shims in `.bin` that were links in the checkout and are not working links in the copy. */
const brokenBins = async (from: string, to: string): Promise<string[]> => {
  const entries = await readdir(join(from, '.bin')).catch(() => [] as string[]);
  const checks = await Promise.all(entries.map(async name => {
    const source = await lstat(join(from, '.bin', name)).catch(() => undefined);
    if (!source?.isSymbolicLink()) return undefined;
    const copied = await lstat(join(to, '.bin', name)).catch(() => undefined);
    if (!copied?.isSymbolicLink()) return name;
    return await stat(join(to, '.bin', name)).then(() => undefined, () => name);
  }));
  return checks.filter((name): name is string => name !== undefined);
};

/**
 * The fallback when node_modules cannot be copied faithfully: a clean install
 * from the project's own lockfile, inside the workspace. Never a guess — no
 * lockfile means no install, and the note says so.
 */
const installDependencies = async (dest: string, why: string): Promise<string> => {
  const found = await Promise.all(INSTALLERS.map(async installer => (await exists(join(dest, installer.lockfile)) ? installer : undefined)));
  const installer = found.find(item => item !== undefined);
  if (!installer) return `Workspace isolation: node_modules was not copied because ${why}, and no lockfile was found to install from; tester commands must install dependencies themselves.`;
  const command = `${installer.command} ${installer.args.join(' ')}`;
  const result = await new Promise<{ code: number | null; output: string }>(resolvePromise => {
    const child = spawn(installer.command, [...installer.args], { cwd: dest, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } });
    const chunks: string[] = [];
    const keep = (chunk: Buffer): void => { chunks.push(chunk.toString('utf8')); if (chunks.length > 200) chunks.shift(); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGTERM'), INSTALL_TIMEOUT_MS);
    child.on('error', error => { clearTimeout(timer); resolvePromise({ code: null, output: String(error.message) }); });
    child.on('close', code => { clearTimeout(timer); resolvePromise({ code, output: chunks.join('') }); });
  });
  if (result.code === 0) return `Workspace isolation: node_modules was installed with \`${command}\` from ${installer.lockfile} because ${why}.`;
  const tail = result.output.trim().split('\n').slice(-3).join(' ').slice(0, 400);
  return `Workspace isolation: node_modules could not be copied (${why}) and \`${command}\` failed (${result.code ?? 'not started'}): ${tail}. Tester commands must install dependencies themselves.`;
};

const readJson = async (path: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
const excludedDependencyEntry = (name: string): boolean => name === 'node_modules' || name === '.git' || name === '.env' || name.startsWith('.env.') || /\.(?:pem|key|p12|pfx)$/i.test(name);

const exists = async (path: string): Promise<boolean> => {
  try { await lstat(path); return true; } catch { return false; }
};

/** Exposed for tests that assert the user checkout stays untouched. */
export const workspaceRelative = (from: string, to: string): string => relative(from, to);
