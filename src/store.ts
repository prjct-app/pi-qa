import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prjctHome } from './settings.ts';
import type { QaRunRecord } from './schema.ts';

export const runsRoot = (home = prjctHome()): string => join(home, 'pi-qa', 'runs');

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
  return migrateStoredRun(JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')));
}

/** Read historical reports without reviving the retired classifier integration. */
export function migrateStoredRun(raw: Record<string, any>): QaRunRecord {
  const { jev, findingJev, findingImpactJev, testJev, testFailureJev, ...record } = raw;
  const { keyFingerprint: _fingerprint, credentialSource: _source, ...evaluator } = record.evaluator ?? jev ?? {};
  return {
    ...record,
    evaluator,
    criteria: (record.criteria ?? []).map((item: Record<string, any>) => {
      const { jev: legacy, ...criterion } = item;
      return { ...criterion, evaluator: criterion.evaluator ?? legacy ?? [] };
    }),
    findingEvaluator: record.findingEvaluator ?? findingJev,
    findingImpactEvaluator: record.findingImpactEvaluator ?? findingImpactJev,
    testEvaluator: record.testEvaluator ?? testJev,
    testFailureEvaluator: record.testFailureEvaluator ?? testFailureJev,
    recommendedActions: record.recommendedActions?.filter((action: { kind: string }) => !['setup_jev', 'setup_evaluator'].includes(action.kind)),
  } as QaRunRecord;
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
