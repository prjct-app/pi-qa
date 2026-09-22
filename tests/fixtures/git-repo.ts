import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { mkdtemp } from 'node:fs/promises';

const exec = promisify(execFile);

export async function gitRepo(prefix = 'pi-qa-git-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await exec('git', ['init', '-b', 'main'], { cwd: dir });
  await exec('git', ['config', 'user.email', 'qa@example.test'], { cwd: dir });
  await exec('git', ['config', 'user.name', 'QA Fixture'], { cwd: dir });
  await exec('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), 'fixture\n');
  await writeFile(join(dir, 'src.js'), 'export const add = (a, b) => a + b;\n');
  await exec('git', ['add', '.'], { cwd: dir });
  await exec('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

export async function commitFile(dir: string, relative: string, content: string, message: string): Promise<void> {
  await mkdir(join(dir, relative, '..'), { recursive: true }).catch(() => undefined);
  await writeFile(join(dir, relative), content);
  await exec('git', ['add', relative], { cwd: dir });
  await exec('git', ['commit', '-m', message], { cwd: dir });
}

export async function writeWorktree(dir: string, relative: string, content: string): Promise<void> {
  await mkdir(join(dir, relative, '..'), { recursive: true }).catch(() => undefined);
  await writeFile(join(dir, relative), content);
}
