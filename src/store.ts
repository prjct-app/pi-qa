import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prjctHome } from './settings.ts';
import type { QaRunRecord } from './schema.ts';

export const runsRoot = (home = prjctHome()): string => join(home, 'pi-qa', 'runs');

/** Runs that keep their working copies; older ones keep only their records. */
export const KEEP_WORKING_COPIES = 10;
/** What a run keeps for good: the record, the contract, the snapshot, the evidence. */
const RECORD = new Set(['report.json', 'eval.json', 'contract.json', 'snapshot.json', 'artifacts']);

/**
 * Old runs drop their working copies (whole checkouts with node_modules and
 * .git, up to 475 MB each) and keep their records and evidence, so a verdict
 * can still be read and re-scored. Never touches the run starting now.
 */
export async function pruneRuns(keepRunId: string, home = prjctHome()): Promise<number> {
  const root = runsRoot(home);
  const runs = await Promise.all((await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory() && entry.name !== keepRunId)
    .map(async entry => ({ name: entry.name, at: (await stat(join(root, entry.name)).catch(() => undefined))?.mtimeMs ?? 0 })));
  const old = runs.sort((a, b) => b.at - a.at).slice(KEEP_WORKING_COPIES);
  const removed = await Promise.all(old.map(async run => {
    const entries = await readdir(join(root, run.name)).catch(() => [] as string[]);
    const extra = entries.filter(name => !RECORD.has(name));
    await Promise.all(extra.map(name => rm(join(root, run.name, name), { recursive: true, force: true }).catch(() => undefined)));
    return extra.length;
  }));
  return removed.reduce((sum, n) => sum + n, 0);
}

export async function prepareRunDir(runId: string, home = prjctHome()): Promise<string> {
  const root = runsRoot(home);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700).catch(() => undefined);
  const dir = join(root, runId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  return dir;
}

export async function writeRun(dir: string, record: QaRunRecord): Promise<void> {
  await writeJson(join(dir, 'report.json'), record);
}

/** Re-evaluations keep the original audited report untouched. */
export async function writeEval(dir: string, record: QaRunRecord): Promise<void> {
  await writeJson(join(dir, 'report-eval.json'), record);
}

const writeJson = async (path: string, record: QaRunRecord): Promise<void> => {
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
};

export async function readRun(dir: string): Promise<QaRunRecord> {
  return JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as QaRunRecord;
}

export const runDirFor = (runId: string, home = prjctHome()): string => join(runsRoot(home), runId);

export async function writeLatest(runId: string, home = prjctHome()): Promise<void> {
  const path = join(runsRoot(home), 'latest');
  await writeFile(path, `${runId}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

export async function readLatest(home = prjctHome()): Promise<string | undefined> {
  try {
    const text = (await readFile(join(runsRoot(home), 'latest'), 'utf8')).trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}
