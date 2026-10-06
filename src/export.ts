import { spawn } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { QaRunRecord, TestRecord } from './schema.ts';
import { clip as limitText, plain, sha256Hex } from './text.ts';
import { testOutcome } from './outcome.ts';

export type ExportedArtifacts = { directory: string; files: Array<{ path: string; hash: string }> };

export async function copyToClipboard(text: string): Promise<void> {
  const candidates: Array<[string, string[]]> = process.platform === 'darwin'
    ? [['pbcopy', []]]
    : process.platform === 'win32'
      ? [['clip', []]]
      : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']]];
  const failures: string[] = [];
  for (const [command, args] of candidates) {
    try {
      await pipeTo(command, args, text);
      return;
    } catch (error) {
      failures.push(`${command}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Clipboard is unavailable. ${failures.join('; ')}`);
}

export const qaPrompt = (record: QaRunRecord): string => {
  const allTests = testsOf(record);
  const pending = allTests.filter(test => testOutcome(record, test) !== 'PASS');
  const executions = record.agents.tester.executions ?? [];
  const cases = pending.map(test => {
    const outcome = testOutcome(record, test);
    const ids = [...new Set(test.executionIds ?? [])];
    const receipts = ids.map(id => executions.find(receipt => receipt.id === id)).filter(receipt => Boolean(receipt));
    const unknown = ids.filter(id => !executions.some(receipt => receipt.id === id));
    const failedChecks = record.checks.filter(check => check.subjectId === test.id && !check.ok);
    const decision = record.testEvaluator?.find(value => value.subjectId === test.id && value.question === 'test');
    return [
      `## ${outcome} · ${test.id}`,
      `Expected: ${safe(test.expected ?? test.assertion)}`,
      `Source: ${test.expectedSource ?? 'unspecified'}`,
      `Procedure: ${safe(test.command)}`,
      `Observed claim: ${limitText(safe(test.observed), 700)}`,
      `Evaluator: ${decision ? `${decision.label} (${decision.confidence.toFixed(2)})` : 'no decision'}`,
      ...failedChecks.map(check => `Blocker: ${safe(check.detail)}`),
      ...(unknown.length ? [`Unknown receipt IDs: ${unknown.join(', ')}`] : []),
      ...receipts.flatMap(receipt => [
        `Receipt: ${receipt!.id} · ${receipt!.tool} · ${receipt!.status} · exit ${receipt!.exitCode ?? '—'} · sha256:${receipt!.outputHash}`,
        `Host command: ${safe(receipt!.command)}`,
        `Host output tail: ${tail(safe(receipt!.outputExcerpt), 1_200) || '(empty)'}`,
      ]),
    ].join('\n');
  }).join('\n\n');
  const report = record.exports?.files.find(file => file.path.endsWith('/report.md'))?.path
    ?? record.exports?.files.find(file => file.path.endsWith('/test-results.json'))?.path
    ?? 'not exported';
  const passed = allTests.length - pending.length;
  const text = pending.length ? [
    'Continue this QA investigation. Focus only on the non-passing test cases below.',
    'Treat host receipts/hashes as evidence; agent observations are claims. Inspect the repository and recent context before changing code. Do not rerun passing cases unless a shared dependency requires it.',
    '',
    `Run: ${record.runId}`,
    `Mission: ${safe(record.contract.description)}`,
    `Snapshot: ${record.snapshot.fingerprint}`,
    `Passing cases omitted: ${passed}`,
    `Full report: ${report}`,
    '',
    cases,
    '',
    `Next: ${safe(record.nextVerification)}`,
  ].join('\n') : [
    `QA run ${record.runId} has no non-passing test cases.`,
    `Passing cases omitted: ${passed}`,
    `Full report: ${report}`,
  ].join('\n');
  return limitText(text, 30_000);
};

export async function openArtifactDirectory(directory: string): Promise<void> {
  const command: [string, string[]] = process.platform === 'darwin'
    ? ['open', [directory]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', directory]]
      : ['xdg-open', [directory]];
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' });
    child.on('error', reject);
    child.on('spawn', () => { child.unref(); resolvePromise(); });
  });
}

export async function writeArtifacts(record: QaRunRecord, directory: string): Promise<ExportedArtifacts> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const artifacts = [
    { name: 'report.md', content: markdown(record) },
    { name: 'test-results.json', content: `${JSON.stringify(testResults(record), null, 2)}\n` },
    { name: 'junit.xml', content: junit(record) },
    { name: 'ticket-comment.md', content: ticketComment(record) },
  ];
  await Promise.all(artifacts.map(async artifact => {
    const path = join(directory, artifact.name);
    await writeFile(path, artifact.content, { mode: 0o600 });
    await chmod(path, 0o600).catch(() => undefined);
  }));
  return { directory, files: artifacts.map(artifact => ({ path: join(directory, artifact.name), hash: sha256Hex(artifact.content) })) };
}

export const ticketComment = (record: QaRunRecord): string => {
  const tests = testsOf(record);
  const rows = tests.length
    ? tests.map(test => `- ${verified(record, test) ? outcomeOf(test) : 'NOT_VERIFIED'} — ${test.id}: ${safe(test.assertion)}`).join('\n')
    : '- No executable tests were recorded.';
  return [
    `## QA ${record.verdict}`,
    '',
    safe(record.explanation),
    '',
    `Snapshot: \`${record.snapshot.fingerprint.slice(0, 12)}\``,
    '',
    '### Checks',
    rows,
    '',
    '### Next action',
    safe(record.nextVerification),
    '',
    `_Run ${record.runId}_`,
    '',
  ].join('\n');
};

const markdown = (record: QaRunRecord): string => {
  const criteria = record.criteria.map(item => `- **${item.id} · ${item.label}** — ${safe(item.text)}\n  ${safe(item.reason)}`).join('\n') || '- No criteria were established.';
  const tests = testsOf(record).map(test => {
    const provenance = record.checks.find(check => check.subjectId === test.id && check.kind === 'test-provenance');
    return `- **${test.id} · ${verified(record, test) ? outcomeOf(test) : 'NOT_VERIFIED'}** (${test.kind ?? 'other'}, exit ${test.exitCode})\n  Expected: ${safe(test.expected ?? test.assertion)}\n  Observed claim: ${safe(test.observed)}\n  Provenance: ${safe(provenance?.detail ?? 'No host receipt.')}`;
  }).join('\n') || '- No tests were recorded.';
  const actions = (record.recommendedActions ?? []).map(action => `- ${action.primary ? '**' : ''}${safe(action.label)}${action.primary ? '**' : ''} — ${safe(action.reason)}`).join('\n') || `- ${safe(record.nextVerification)}`;
  return [
    `# QA ${record.verdict}`,
    '',
    safe(record.explanation),
    '',
    `- Run: \`${record.runId}\``,
    `- Snapshot: \`${record.snapshot.fingerprint}\``,
    `- Scope: ${record.snapshot.scope ?? 'change'}`,
    `- QA agent: ${record.agents.tester.status}`,
    `- Evaluator: ${record.evaluator.available ? record.evaluator.modelActual ?? record.evaluator.modelPin : 'NOT_VERIFIED'}`,
    '',
    '## Criteria',
    criteria,
    '',
    '## Tests',
    tests,
    '',
    '## Recommended actions',
    actions,
    '',
  ].join('\n');
};

const testResults = (record: QaRunRecord) => ({
  runId: record.runId,
  verdict: record.verdict,
  snapshot: record.snapshot.fingerprint,
  generatedAt: record.finishedAt,
  tests: testsOf(record).map(test => ({ ...test, provenanceVerified: verified(record, test) })),
  executions: record.agents.tester.executions ?? [],
});

const junit = (record: QaRunRecord): string => {
  const tests = testsOf(record);
  const failures = tests.filter(test => verified(record, test) && !test.skipped && test.exitCode !== 0).length;
  const skipped = tests.filter(test => test.skipped || !verified(record, test)).length;
  const cases = tests.map(test => {
    const body = test.skipped || !verified(record, test)
      ? `<skipped message="${xml(test.skipped ? test.observed : 'No verified host execution receipt.')}"/>`
      : test.exitCode !== 0
        ? `<failure message="failed check">${xml(test.observed)}</failure>`
        : '';
    return `  <testcase name="${xml(test.id)}" classname="qa.${xml(test.kind ?? 'other')}">${body}</testcase>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="qa" tests="${tests.length}" failures="${failures}" skipped="${skipped}">\n${cases}\n</testsuite>\n`;
};

const pipeTo = (command: string, args: string[], text: string): Promise<void> => new Promise((resolvePromise, reject) => {
  const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  const errors: Buffer[] = [];
  child.stderr?.on('data', chunk => errors.push(Buffer.from(chunk)));
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolvePromise() : reject(new Error(Buffer.concat(errors).toString('utf8') || `Exited ${code}`)));
  child.stdin?.end(text);
});

const testsOf = (record: QaRunRecord): TestRecord[] => {
  const report = record.agents.tester.report;
  return report && 'tests' in report ? report.tests : [];
};

const verified = (record: QaRunRecord, test: TestRecord): boolean =>
  record.checks.some(check => check.subjectId === test.id && check.kind === 'test-provenance' && check.ok);
const outcomeOf = (test: TestRecord): string => test.skipped ? 'skipped' : test.exitCode === 0 ? 'passed' : 'failed';
const safe = (value: unknown): string => plain(value).replace(/\s+/g, ' ').trim();
const tail = (value: string, max: number): string => value.length <= max ? value : `…${value.slice(-max)}`;
const xml = (value: unknown): string => safe(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
