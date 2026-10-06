import { SYMBOL, type PanelAction, type PanelDetail, type PanelItem, type PanelSpec, type Tone } from '@prjct.app/pi-tui-kit';
import type { QaLiveModel } from './progress.ts';
import type { CriterionEvaluation, QaArtifact, QaRecommendedAction, QaRunRecord, QaVerdict, TestRecord } from './schema.ts';
import { clip, plain } from './text.ts';
import { testOutcome } from './outcome.ts';

const safe = (value: unknown, limit = 2_000): string => clip(plain(value), limit);

const verdictStyle = (verdict: QaVerdict): { symbol: string; tone: Tone } => {
  if (verdict === 'PASS') return { symbol: SYMBOL.ok, tone: 'success' };
  if (verdict === 'FAIL') return { symbol: SYMBOL.error, tone: 'error' };
  return { symbol: SYMBOL.attention, tone: 'warning' };
};

const criterionStyle = (criterion: CriterionEvaluation): { symbol: string; tone: Tone } => {
  if (criterion.label === 'supports') return { symbol: SYMBOL.ok, tone: 'success' };
  if (criterion.label === 'contradicts') return { symbol: SYMBOL.error, tone: 'error' };
  return { symbol: SYMBOL.attention, tone: 'warning' };
};

const testStyle = (record: QaRunRecord, test: TestRecord): { symbol: string; tone: Tone; meta: string } => {
  const outcome = testOutcome(record, test);
  if (outcome === 'PASS') return { symbol: SYMBOL.ok, tone: 'success', meta: outcome };
  if (outcome === 'FAIL') return { symbol: SYMBOL.error, tone: 'error', meta: outcome };
  return { symbol: SYMBOL.attention, tone: 'warning', meta: outcome };
};

const resultItem = (record: QaRunRecord): PanelItem => ({
  id: 'result',
  label: `Result · ${record.verdict}`,
  ...verdictStyle(record.verdict),
  meta: record.snapshot.fingerprint.slice(0, 12),
  search: `${record.explanation} ${record.nextVerification}`,
});

const agentItems = (record: QaRunRecord): PanelItem[] => (['reviewer', 'tester'] as const).map(role => {
  const agent = record.agents[role];
  const completed = agent.status === 'completed';
  return {
    id: `agent:${role}`,
    label: role === 'reviewer' ? 'Code reviewer' : 'Tester',
    symbol: completed ? SYMBOL.ok : agent.status === 'failed' ? SYMBOL.error : SYMBOL.attention,
    tone: completed ? 'success' : agent.status === 'failed' ? 'error' : 'warning',
    meta: agent.status,
    search: agent.error ?? '',
  };
});

const criterionItems = (record: QaRunRecord): PanelItem[] => record.criteria.map(criterion => ({
  id: `criterion:${criterion.id}`,
  label: `${criterion.id} · ${safe(criterion.text, 120)}`,
  ...criterionStyle(criterion),
  meta: criterion.label,
  search: `${criterion.source} ${criterion.required ? 'required' : 'optional'}`,
}));

const testsOf = (record: QaRunRecord): TestRecord[] => {
  const report = record.agents.tester.report;
  return report && 'tests' in report ? report.tests : [];
};

const actionItems = (record: QaRunRecord): PanelItem[] => (record.recommendedActions ?? []).filter(action =>
  record.verdict !== 'STALE' || action.kind === 'rerun' || action.kind === 'export' || action.kind === 'copy_prompt',
).map(action => ({
  id: `action:${action.id}`,
  label: `${action.primary ? 'Recommended' : 'Action'} · ${safe(action.label, 100)}`,
  symbol: action.primary ? SYMBOL.cursor : SYMBOL.mode,
  tone: action.primary ? 'accent' : 'muted',
  meta: action.kind.replace('_', ' '),
  search: action.reason,
}));

const artifactsOf = (record: QaRunRecord): QaArtifact[] => {
  const report = record.agents.tester.report;
  return report && 'artifacts' in report ? report.artifacts ?? [] : [];
};

const exportItems = (record: QaRunRecord): PanelItem[] => (record.exports?.files ?? []).map((artifact, index) => ({
  id: `exported:${index}`,
  label: `Artifact · ${artifact.path.split('/').at(-1) ?? artifact.path}`,
  symbol: SYMBOL.ok,
  tone: 'success',
  meta: artifact.hash.slice(0, 8),
  search: artifact.path,
}));

const artifactItems = (record: QaRunRecord): PanelItem[] => artifactsOf(record).map((artifact, index) => ({
  id: `artifact:${index}`,
  label: `${artifact.kind} · ${safe(artifact.description, 100)}`,
  symbol: artifact.kind === 'screenshot' ? SYMBOL.mode : SYMBOL.idle,
  tone: 'muted',
  meta: artifact.hash.slice(0, 8),
  search: `${artifact.path} ${artifact.url ?? ''}`,
}));

const testItems = (record: QaRunRecord): PanelItem[] => testsOf(record).map(test => ({
  id: `test:${test.id}`,
  label: safe(test.assertion || test.id, 100),
  ...testStyle(record, test),
  search: `${test.command} ${test.assertion}`,
}));

const resultDetail = (record: QaRunRecord): PanelDetail => ({
  title: `QA ${record.verdict}`,
  subtitle: safe(record.explanation),
  subtitleTone: verdictStyle(record.verdict).tone,
  fields: [
    { label: 'run', value: record.runId },
    { label: 'snapshot', value: record.snapshot.fingerprint },
    { label: 'base', value: record.snapshot.base ?? '—' },
    { label: 'head', value: record.snapshot.head ?? '—' },
    { label: 'Evaluator', value: record.evaluator.available ? `${record.evaluator.modelActual ?? record.evaluator.modelPin} · ${record.evaluator.inputTokens} in / ${record.evaluator.outputTokens} out` : record.evaluator.error ?? 'not verified', tone: record.evaluator.available ? 'success' : 'warning' },
  ],
  sections: [
    { title: 'Mission', lines: [safe(record.contract.description)] },
    { title: 'Next', lines: [safe(record.nextVerification)] },
    ...(record.unresolvedRisks.length ? [{ title: 'Risks', lines: record.unresolvedRisks.map(risk => safe(risk)) }] : []),
  ],
});

const agentDetail = (record: QaRunRecord, role: 'reviewer' | 'tester'): PanelDetail => {
  const agent = record.agents[role];
  return {
    title: role === 'reviewer' ? 'Code reviewer' : 'Tester',
    subtitle: agent.status,
    subtitleTone: agent.status === 'completed' ? 'success' : agent.status === 'failed' ? 'error' : 'warning',
    fields: [
      { label: 'latency', value: `${agent.latencyMs}ms` },
      { label: 'error', value: safe(agent.error ?? '—') },
    ],
  };
};

const criterionDetail = (criterion: CriterionEvaluation): PanelDetail => ({
  title: `${criterion.id} · ${safe(criterion.text, 300)}`,
  subtitle: criterion.label,
  subtitleTone: criterionStyle(criterion).tone,
  fields: [
    { label: 'source', value: criterion.source },
    { label: 'required', value: criterion.required ? 'yes' : 'no' },
    { label: 'tests', value: criterion.tests.join(', ') || '—' },
    { label: 'findings', value: criterion.findings.join(', ') || '—' },
  ],
  sections: criterion.evaluator.length ? [{ title: 'Evaluator', lines: criterion.evaluator.map(decision => `${decision.label} · ${decision.confidence.toFixed(2)}${decision.error ? ` · ${safe(decision.error, 300)}` : ''}`) }] : [],
});

const actionDetail = (action: QaRecommendedAction): PanelDetail => ({
  title: safe(action.label),
  subtitle: action.primary ? 'recommended next action' : 'available action',
  subtitleTone: action.primary ? 'accent' : 'muted',
  sections: [{ title: 'Why', lines: [safe(action.reason)] }],
});

const exportDetail = (record: QaRunRecord, index: number): PanelDetail => {
  const artifact = record.exports!.files[index]!;
  return {
    title: artifact.path.split('/').at(-1) ?? artifact.path,
    subtitle: 'generated artifact',
    subtitleTone: 'success',
    fields: [
      { label: 'path', value: artifact.path },
      { label: 'sha256', value: artifact.hash },
    ],
  };
};

const artifactDetail = (artifact: QaArtifact): PanelDetail => ({
  title: safe(artifact.description),
  subtitle: artifact.kind,
  subtitleTone: 'muted',
  fields: [
    { label: 'path', value: safe(artifact.path) },
    { label: 'sha256', value: artifact.hash },
    { label: 'url', value: safe(artifact.url ?? '—') },
  ],
});

const testDetail = (record: QaRunRecord, test: TestRecord): PanelDetail => {
  const receipts = (test.executionIds ?? []).map(id => record.agents.tester.executions?.find(receipt => receipt.id === id)).filter(receipt => Boolean(receipt));
  const style = testStyle(record, test);
  return {
  title: safe(test.id),
  subtitle: style.meta,
  subtitleTone: style.tone,
  fields: [
    { label: 'source', value: test.expectedSource ?? 'unspecified', tone: test.expectedSource ? 'muted' : 'warning' },
    { label: 'cwd', value: safe(test.cwd) },
  ],
  sections: [
    { title: 'Expected', lines: [safe(test.expected ?? test.assertion)] },
    { title: 'Procedure', lines: [safe(test.command)] },
    { title: 'Observed claim', lines: [safe(test.observed)] },
    ...(receipts.length ? [{ title: 'Host receipts', lines: receipts.flatMap(receipt => [
      `${receipt!.id} · ${receipt!.tool} · ${receipt!.status} · exit ${receipt!.exitCode ?? '—'} · sha256:${receipt!.outputHash.slice(0, 12)}`,
      safe(receipt!.outputExcerpt),
    ]) }] : [{ title: 'Host receipts', lines: ['No verified execution receipt.'] }]),
  ],
  };
};

export const qaPanelSpec = (record: QaRunRecord, actions: PanelAction[] = []): PanelSpec => {
  const tests = testsOf(record);
  const items: PanelItem[] = tests.length
    ? testItems(record)
    : [{ id: 'empty', label: 'No test cases', symbol: SYMBOL.attention, tone: 'warning', meta: 'BLOCKED' }];
  return {
    title: `QA · ${record.verdict}`,
    summary: () => `${tests.filter(test => testStyle(record, test).meta === 'PASS').length}/${tests.length} passed`,
    items: () => items,
    initial: items[0]!.id,
    actions,
    detail: item => item.id === 'empty'
      ? { title: 'No test cases', subtitle: 'Expected behavior or target is missing.', subtitleTone: 'warning', sections: [{ title: 'Next', lines: [safe(record.nextVerification)] }] }
      : testDetail(record, tests.find(value => `test:${value.id}` === item.id)!),
  };
};

const liveItems = (model: QaLiveModel): PanelItem[] => [{
  id: 'cases',
  label: safe(model.state.message, 120),
  symbol: model.state.stage === 'failed' ? SYMBOL.error : SYMBOL.active,
  tone: model.state.stage === 'failed' ? 'error' : 'accent',
  meta: model.state.stage === 'agents' ? 'RUNNING' : 'PLANNING',
  search: model.state.mission,
}];

const liveDetail = (model: QaLiveModel): PanelDetail => ({
  title: 'Test cases',
  subtitle: safe(model.state.message),
  subtitleTone: model.state.stage === 'failed' ? 'error' : 'accent',
  fields: [{ label: 'elapsed', value: `${Math.round((Date.now() - model.state.startedAt) / 1000)}s` }],
  sections: [
    { title: 'Target behavior', lines: [safe(model.state.mission)] },
    { title: 'Activity', lines: model.state.activity.map(message => safe(message)) },
  ],
});

export const qaLivePanelSpec = (model: QaLiveModel, actions: PanelAction[] = []): PanelSpec => ({
  title: 'QA agent',
  summary: () => model.state.record
    ? qaPanelSpec(model.state.record).summary?.() ?? `${testsOf(model.state.record).length} test cases`
    : `${model.state.stage} · ${Math.round((Date.now() - model.state.startedAt) / 1000)}s`,
  items: () => model.state.record ? qaPanelSpec(model.state.record).items() : liveItems(model),
  initial: 'cases',
  detail: item => model.state.record ? qaPanelSpec(model.state.record).detail(item) : liveDetail(model),
  actions,
  refreshMs: 1_000,
  subscribe: changed => model.subscribe(changed),
});
