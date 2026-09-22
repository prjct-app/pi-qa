import type { QaRunRecord } from './schema.ts';
import { clip } from './text.ts';

const LIMIT = 16_384;

export function formatReport(record: QaRunRecord): string {
  const agents = `QA ${record.agents.tester.status}`;
  const criteria = record.criteria.map(item =>
    `  ${item.id} [${item.source}${item.required ? ', required' : ''}] ${item.label} — ${item.reason}`).join('\n');
  const checks = record.checks.length
    ? record.checks.map(check => `  ${check.ok ? 'ok' : 'no'} ${check.kind} ${check.subjectId}: ${check.detail}`).join('\n')
    : '  (none)';
  if (record.verdict === 'STALE') {
    return clip([
      'qa STALE',
      record.explanation,
      `Next: ${record.nextVerification}`,
      `Snapshot ${record.snapshot.fingerprint.slice(0, 12)} no longer matches the current change.`,
      `Run ${record.runId}`,
    ].join('\n'), LIMIT);
  }
  const jev = record.jev.available
    ? `${record.jev.modelActual ?? record.jev.modelPin}  in=${record.jev.inputTokens} out=${record.jev.outputTokens}  ${record.jev.latencyMs}ms`
    : record.jev.configured ? `unavailable${record.jev.error ? ` — ${record.jev.error}` : ''}` : 'not configured';
  const commands = record.agents.tester.report && 'tests' in record.agents.tester.report
    ? record.agents.tester.report.tests.map(test => `  ${test.exitCode === 0 ? 'pass' : test.skipped ? 'skip' : 'fail'} \`${test.command}\` → ${test.assertion}`).join('\n')
    : '  (none)';
  return [
    `qa ${record.verdict}`,
    record.explanation,
    `Next: ${record.nextVerification}`,
    `Snapshot ${record.snapshot.fingerprint.slice(0, 12)}  base ${short(record.snapshot.base)}  head ${short(record.snapshot.head)}  ${record.snapshot.paths.length} path(s)`,
    `Agents: ${agents}`,
    `Jev: ${jev}`,
    'Criteria:',
    criteria || '  (none)',
    'Checks:',
    checks,
    'Commands:',
    commands,
    record.unresolvedRisks.length ? `Risks: ${record.unresolvedRisks.join('; ')}` : '',
    `Run ${record.runId}  ${record.latencyMs}ms`,
  ].filter(Boolean).join('\n');
}

/** Tool and notify output is bounded, matching the pi-team metadata() discipline. */
export function boundedReport(record: QaRunRecord): string {
  const full = formatReport(record);
  if (full.length <= 16_384) return full;
  return `${full.slice(0, 16_384 - 16)}\n…[truncated]`;
}

const short = (value: string | null): string => value ? value.slice(0, 8) : 'none';
