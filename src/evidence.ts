import type { DeterministicCheck, EvaluationContract, ExecutionReceipt, ReviewerReport, Snapshot, TestRecord, TesterReport } from './schema.ts';

export function deterministicChecks(snapshot: Snapshot, reviewer: ReviewerReport, tester: TesterReport, executions: ExecutionReceipt[] = []): DeterministicCheck[] {
  const findingPaths = reviewer.findings.map(finding => {
    const path = snapshot.paths.find(entry => entry.path === finding.file);
    const inSnapshot = Boolean(path) || snapshot.combinedPatch.includes(finding.file);
    return { subjectId: finding.id, kind: 'finding-path' as const, ok: inSnapshot, detail: inSnapshot ? `${finding.file} is in the snapshot.` : `${finding.file} is not in the captured snapshot.` };
  });
  const excerpts = reviewer.findings.map(finding => {
    const ok = excerptInSnapshot(snapshot, finding.file, finding.excerpt);
    return { subjectId: finding.id, kind: 'finding-excerpt' as const, ok, detail: ok ? 'Quoted excerpt occurs in the snapshot.' : 'Quoted excerpt does not occur in the snapshot; the finding is unsubstantiated.' };
  });
  const definitions = tester.tests.map(test => ({
    subjectId: test.id,
    kind: 'test-definition' as const,
    ok: Boolean(test.expected?.trim()) && Boolean(test.expectedSource) && test.expectedSource !== 'inferred',
    detail: !test.expected?.trim()
      ? 'Expected behavior is missing.'
      : !test.expectedSource ? 'Expected behavior source is missing.'
        : test.expectedSource === 'inferred' ? 'Expected behavior is only inferred and cannot establish PASS.' : `Expected behavior is sourced from ${test.expectedSource}.`,
  }));
  const provenance = tester.tests.map(test => provenanceCheck(test, executions));
  const ran = tester.tests.map(test => {
    const verified = provenance.find(check => check.subjectId === test.id)?.ok === true;
    return {
      subjectId: test.id,
      kind: 'test-ran' as const,
      ok: !test.skipped && verified,
      detail: test.skipped ? 'Test recorded as skipped.' : verified ? `Execution verified by host receipt for: ${test.command}` : 'No matching host execution receipt; agent-reported command/output is not execution evidence.',
    };
  });
  const exits = tester.tests.map(test => {
    const verified = provenance.find(check => check.subjectId === test.id)?.ok === true;
    return {
      subjectId: test.id,
      kind: 'test-exit' as const,
      ok: !test.skipped && verified && test.exitCode === 0,
      detail: test.skipped
        ? 'Skipped; exit code is not evidence.'
        : !verified
          ? 'Reported exit code was not matched to a host execution receipt.'
          : test.exitCode === 0 ? 'Host receipt confirms exit code 0.' : `Host receipt confirms failure with exit code ${test.exitCode}.`,
    };
  });
  return [...findingPaths, ...excerpts, ...definitions, ...provenance, ...ran, ...exits];
}

export const testHasVerifiedExecution = (test: TestRecord, checks: DeterministicCheck[]): boolean =>
  checks.some(check => check.subjectId === test.id && check.kind === 'test-provenance' && check.ok)
  && checks.some(check => check.subjectId === test.id && check.kind === 'test-definition' && check.ok);

const provenanceCheck = (test: TestRecord, executions: ExecutionReceipt[]): DeterministicCheck => {
  if (test.skipped) return { subjectId: test.id, kind: 'test-provenance', ok: false, detail: 'Skipped tests have no execution provenance.' };
  const ids = [...new Set(test.executionIds ?? [])];
  const cited = ids.map(id => executions.find(receipt => receipt.id === id));
  const receipts = cited.filter((receipt): receipt is ExecutionReceipt => Boolean(receipt));
  const unknown = ids.filter(id => !executions.some(receipt => receipt.id === id));
  if (ids.length === 0 || receipts.length === 0) {
    return { subjectId: test.id, kind: 'test-provenance', ok: false, detail: 'No known host execution receipt ID.' };
  }
  const exitMatches = test.exitCode === 0
    ? receipts.every(receipt => receipt.status === 'completed' && receipt.exitCode === 0)
    : receipts.some(receipt => receipt.status === 'failed' && receipt.exitCode === test.exitCode);
  if (!exitMatches) {
    return { subjectId: test.id, kind: 'test-provenance', ok: false, detail: 'Reported exit code does not match the cited host receipt.' };
  }
  if (test.rerunExitCode !== undefined && !receipts.some(receipt => receipt.exitCode === test.rerunExitCode)) {
    return { subjectId: test.id, kind: 'test-provenance', ok: false, detail: 'Reported rerun exit code has no matching host receipt.' };
  }
  return {
    subjectId: test.id,
    kind: 'test-provenance',
    ok: true,
    detail: `Verified ${receipts.length} host receipt(s): ${receipts.map(receipt => `${receipt.id} (${receipt.tool}, sha256:${receipt.outputHash.slice(0, 12)})`).join(', ')}.${unknown.length ? ` Ignored unknown receipt ID(s): ${unknown.join(', ')}.` : ''}`,
  };
};

export function excerptInSnapshot(snapshot: Snapshot, _file: string, excerpt: string): boolean {
  const needle = excerpt.trim();
  if (!needle) return false;
  return snapshot.combinedPatch.includes(needle) || snapshot.stagedPatch.includes(needle) || snapshot.unstagedPatch.includes(needle);
}

export function blobContains(blobs: Map<string, Buffer>, snapshot: Snapshot, file: string, excerpt: string): boolean {
  const path = snapshot.paths.find(entry => entry.path === file);
  if (!path?.hash) return excerptInSnapshot(snapshot, file, excerpt);
  const blob = blobs.get(path.hash);
  if (!blob) return excerptInSnapshot(snapshot, file, excerpt);
  return blob.toString('utf8').includes(excerpt.trim());
}

export const requiredExplicit = (contract: EvaluationContract) =>
  contract.items.filter(item => item.required && item.source !== 'inferred_from_diff');
