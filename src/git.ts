import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const READ = new Set([
  'rev-parse', 'status', 'diff', 'ls-files', 'hash-object', 'merge-base', 'cat-file',
  'submodule', 'show', 'log', 'archive', 'for-each-ref', 'symbolic-ref', 'name-rev',
  'rev-list', 'check-ignore', 'diff-index', 'ls-tree',
]);

const ISOLATED = new Set(['worktree', 'apply']);

export type GitResult = { stdout: string; stderr: string; code: number };

export type GitExec = (cwd: string, args: readonly string[], options?: GitOptions) => Promise<GitResult>;

export type GitOptions = {
  timeoutMs?: number;
  maxBuffer?: number;
  isolated?: boolean;
  encoding?: 'utf8' | 'buffer';
};

/** Read-only git against the user's checkout. Isolated mutations stay in a temp worktree. */
export async function git(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
  const result = await runGit(cwd, args, options, 'utf8');
  return { stdout: result.stdout as string, stderr: result.stderr, code: result.code };
}

/** Binary-safe variant for commands whose output is not text (git archive tar). */
export async function gitBuffer(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  const result = await runGit(cwd, args, options, 'buffer');
  return { stdout: result.stdout as Buffer, stderr: result.stderr, code: result.code };
}

const runGit = async (
  cwd: string,
  args: readonly string[],
  options: GitOptions,
  encoding: 'utf8' | 'buffer',
): Promise<{ stdout: string | Buffer; stderr: string; code: number }> => {
  const sub = args[0];
  if (!sub || (!READ.has(sub) && !(options.isolated && ISOLATED.has(sub)))) {
    throw new Error(`Refusing git ${sub ?? '(missing)'}: not a permitted non-destructive command.`);
  }
  try {
    const result = await execFileAsync('git', [...args], {
      cwd,
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
      encoding,
    });
    return { stdout: result.stdout as string | Buffer, stderr: String(result.stderr), code: 0 };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: unknown; stderr?: unknown; code?: string | number };
    if (err.code === 'ENOENT') throw new Error('git is not available on PATH.');
    const code = typeof err.code === 'number' ? err.code : 1;
    return { stdout: err.stdout as string | Buffer ?? '', stderr: String(err.stderr ?? error), code };
  }
};

export const gitOk = async (cwd: string, args: readonly string[], options?: GitOptions): Promise<string> => {
  const result = await git(cwd, args, options);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed (${result.code})`);
  return result.stdout;
};

export const splitZ = (text: string): string[] => text.split('\0').filter(part => part.length > 0);

export type NameStatus = { status: string; path: string; previousPath?: string };

export const parseNameStatus = (parts: string[], acc: NameStatus[] = []): NameStatus[] => {
  if (parts.length === 0) return acc;
  const status = parts[0]!;
  const code = status[0];
  if ((code === 'R' || code === 'C') && parts.length >= 3) {
    return parseNameStatus(parts.slice(3), [...acc, { status, previousPath: parts[1]!, path: parts[2]! }]);
  }
  if (parts.length >= 2) return parseNameStatus(parts.slice(2), [...acc, { status, path: parts[1]! }]);
  return acc;
};
