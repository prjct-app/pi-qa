import { Type, type Static } from 'typebox';
import { Compile } from 'typebox/compile';

const lazy = <T>(fn: () => T): (() => T) => {
  const slot: { value?: T } = {};
  return () => {
    if (slot.value === undefined) slot.value = fn();
    return slot.value;
  };
};

export const COMMAND = 'qa';
export const CONTRACT_TOOL = 'pi_qa_contract';
export const REVIEWER_REPORT_TOOL = 'pi_qa_reviewer_report';
export const TESTER_REPORT_TOOL = 'pi_qa_tester_report';
export const CUSTOM_RUN = 'pi-qa-run';
export const CUSTOM_CONTRACT = 'pi-qa-contract';
export const CUSTOM_STATUS = 'pi-qa-status';

export const VERDICTS = ['PASS', 'FAIL', 'NOT_VERIFIED', 'STALE'] as const;
export type QaVerdict = (typeof VERDICTS)[number];

export const SOURCES = ['user_request', 'ticket', 'plan', 'inferred_from_diff'] as const;
export type CriterionSource = (typeof SOURCES)[number];

export const AGENT_ROLES = ['reviewer', 'tester'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const AGENT_STATUSES = ['completed', 'failed', 'timeout', 'canceled'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const EVIDENCE_LABELS = ['supports', 'contradicts', 'insufficient_evidence'] as const;
export type EvidenceLabel = (typeof EVIDENCE_LABELS)[number];

export const SEVERITIES = ['blocking', 'warning', 'note'] as const;
export type FindingSeverity = (typeof SEVERITIES)[number];

export const FILE_KINDS = ['text', 'binary', 'symlink', 'submodule', 'large', 'missing'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

const SourceSchema = Type.Union([
  Type.Literal('user_request'), Type.Literal('ticket'), Type.Literal('plan'), Type.Literal('inferred_from_diff'),
]);
const SeveritySchema = Type.Union([
  Type.Literal('blocking'), Type.Literal('warning'), Type.Literal('note'),
]);

export const ContractItemSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  text: Type.String({ minLength: 1, maxLength: 4000 }),
  source: SourceSchema,
  sourceRef: Type.String({ maxLength: 2000 }),
  sourceText: Type.Optional(Type.String({ maxLength: 8000 })),
  required: Type.Boolean(),
  observe: Type.String({ minLength: 1, maxLength: 2000 }),
}, { additionalProperties: false });
export type ContractItem = Static<typeof ContractItemSchema>;

export const EvaluationContractSchema = Type.Object({
  description: Type.String({ minLength: 1, maxLength: 2000 }),
  items: Type.Array(ContractItemSchema, { maxItems: 64 }),
  invariants: Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 32 }),
  regressionRisks: Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 32 }),
  definitionOfReady: Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 32 }),
  definitionOfDone: Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 32 }),
  ticketRef: Type.Optional(Type.String({ maxLength: 500 })),
  ticketFingerprint: Type.Optional(Type.String({ maxLength: 128 })),
}, { additionalProperties: false });
export type EvaluationContract = Static<typeof EvaluationContractSchema>;

export const ReviewFindingSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  severity: SeveritySchema,
  file: Type.String({ minLength: 1, maxLength: 1024 }),
  startLine: Type.Integer({ minimum: 1 }),
  endLine: Type.Integer({ minimum: 1 }),
  excerpt: Type.String({ maxLength: 8000 }),
  behavior: Type.String({ minLength: 1, maxLength: 2000 }),
  claim: Type.String({ minLength: 1, maxLength: 4000 }),
  evidence: Type.String({ minLength: 1, maxLength: 4000 }),
  impact: Type.Optional(Type.String({ maxLength: 2000 })),
  suggestedAction: Type.Optional(Type.String({ maxLength: 2000 })),
  contractItemIds: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32 }),
}, { additionalProperties: false });
export type ReviewFinding = Static<typeof ReviewFindingSchema>;

export const ReviewerReportSchema = Type.Object({
  findings: Type.Array(ReviewFindingSchema, { maxItems: 64 }),
  notes: Type.String({ maxLength: 8000 }),
  blockers: Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 32 }),
}, { additionalProperties: false });
export type ReviewerReport = Static<typeof ReviewerReportSchema>;

const TestKindSchema = Type.Union([
  Type.Literal('smoke'), Type.Literal('unit'), Type.Literal('integration'), Type.Literal('e2e'), Type.Literal('api'), Type.Literal('ui'),
  Type.Literal('build'), Type.Literal('static'), Type.Literal('security'), Type.Literal('manual'), Type.Literal('other'),
]);
export const QaArtifactSchema = Type.Object({
  kind: Type.Union([Type.Literal('screenshot'), Type.Literal('trace'), Type.Literal('log'), Type.Literal('file')]),
  path: Type.String({ minLength: 1, maxLength: 4096 }),
  hash: Type.String({ minLength: 64, maxLength: 64 }),
  description: Type.String({ maxLength: 2000 }),
  url: Type.Optional(Type.String({ maxLength: 4096 })),
}, { additionalProperties: false });
export type QaArtifact = Static<typeof QaArtifactSchema>;

export const TestRecordSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  kind: Type.Optional(TestKindSchema),
  command: Type.String({ minLength: 1, maxLength: 4000 }),
  cwd: Type.String({ maxLength: 1024 }),
  exitCode: Type.Integer(),
  expected: Type.Optional(Type.String({ maxLength: 4000 })),
  expectedSource: Type.Optional(Type.Union([
    Type.Literal('user'), Type.Literal('ticket'), Type.Literal('spec'), Type.Literal('existing_test'), Type.Literal('default_smoke'), Type.Literal('inferred'),
  ])),
  observed: Type.String({ maxLength: 8000 }),
  assertion: Type.String({ minLength: 1, maxLength: 4000 }),
  reproduction: Type.Optional(Type.String({ maxLength: 4000 })),
  rerunExitCode: Type.Optional(Type.Integer()),
  rerunObserved: Type.Optional(Type.String({ maxLength: 8000 })),
  contractItemIds: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32 }),
  executionIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32 })),
  skipped: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export type TestRecord = Static<typeof TestRecordSchema>;

export const TesterReportSchema = Type.Object({
  tests: Type.Array(TestRecordSchema, { maxItems: 64 }),
  artifacts: Type.Optional(Type.Array(QaArtifactSchema, { maxItems: 128 })),
  notes: Type.String({ maxLength: 8000 }),
}, { additionalProperties: false });
export type TesterReport = Static<typeof TesterReportSchema>;

const contractValidator = lazy(() => Compile(EvaluationContractSchema));
const reviewerValidator = lazy(() => Compile(ReviewerReportSchema));
const testerValidator = lazy(() => Compile(TesterReportSchema));

export const checkContract = (value: unknown): value is EvaluationContract => contractValidator().Check(value);
export const checkReviewerReport = (value: unknown): value is ReviewerReport => reviewerValidator().Check(value);
export const checkTesterReport = (value: unknown): value is TesterReport => testerValidator().Check(value);

export const contractProblems = (value: unknown): string[] => [...contractValidator().Errors(value)].map(error => error.message);
export const reviewerProblems = (value: unknown): string[] => [...reviewerValidator().Errors(value)].map(error => error.message);
export const testerProblems = (value: unknown): string[] => [...testerValidator().Errors(value)].map(error => error.message);

export type ChangedPath = {
  path: string;
  previousPath?: string;
  status: string;
  kind: FileKind;
  hash?: string;
  previousHash?: string;
  size?: number;
  symlinkTarget?: string;
  omittedReason?: string;
};

export type QaSurface = 'browser' | 'api' | 'command';

export type Snapshot = {
  runId: string;
  qaSurface?: QaSurface;
  scope?: 'change' | 'target';
  targetPaths?: string[];
  capturedAt: string;
  cwd: string;
  branch: string | null;
  head: string | null;
  base: string | null;
  baseKind: 'worktree' | 'local-ref' | 'unresolved';
  fingerprint: string;
  dirty: boolean;
  paths: ChangedPath[];
  stagedPatch: string;
  unstagedPatch: string;
  combinedPatch: string;
  untracked: string[];
  unsupported: { path: string; reason: string }[];
  resolutionError?: string;
};

export type ExecutionReceipt = {
  id: string;
  tool: 'bash' | 'qa_browser';
  command: string;
  cwd: string;
  startedAt: string;
  finishedAt: string;
  status: 'completed' | 'failed' | 'canceled';
  exitCode: number | null;
  outputHash: string;
  outputExcerpt: string;
  artifactHashes?: string[];
};

export type AgentOutcome = {
  role: AgentRole;
  status: AgentStatus;
  report?: ReviewerReport | TesterReport;
  error?: string;
  executions?: ExecutionReceipt[];
  latencyMs: number;
  tokens?: number;
};

export type DeterministicCheck = {
  subjectId: string;
  kind: 'finding-excerpt' | 'finding-path' | 'test-definition' | 'test-provenance' | 'test-ran' | 'test-exit' | 'hash';
  ok: boolean;
  detail: string;
};

export type EvaluatorDecision = {
  subjectId: string;
  question: string;
  label: EvidenceLabel | 'noul_true' | 'noul_false' | 'unavailable' | 'timeout' | 'low_confidence';
  confidence: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  error?: string;
};

export type CriterionEvaluation = {
  id: string;
  text: string;
  source: CriterionSource;
  required: boolean;
  label: EvidenceLabel;
  reason: string;
  evaluator: EvaluatorDecision[];
  tests: string[];
  findings: string[];
};

export type QaExportSummary = {
  directory: string;
  files: Array<{ path: string; hash: string }>;
};

export type QaRecommendedAction = {
  id: string;
  kind: 'rerun' | 'export' | 'copy_prompt' | 'comment_ticket' | 'create_defect' | 'request_input';
  label: string;
  reason: string;
  primary: boolean;
};

export type QaRunRecord = {
  runId: string;
  startedAt: string;
  finishedAt: string;
  verdict: QaVerdict;
  explanation: string;
  nextVerification: string;
  snapshot: Snapshot;
  contract: EvaluationContract;
  agents: { reviewer: AgentOutcome; tester: AgentOutcome };
  checks: DeterministicCheck[];
  criteria: CriterionEvaluation[];
  evaluator: {
    configured: boolean;
    modelPin: string;
    modelActual?: string;
    available: boolean;
    error?: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  };
  unresolvedRisks: string[];
  contractProblems?: string[];
  recommendedActions?: QaRecommendedAction[];
  exports?: QaExportSummary;
  findingEvaluator?: EvaluatorDecision[];
  findingImpactEvaluator?: EvaluatorDecision[];
  testEvaluator?: EvaluatorDecision[];
  testFailureEvaluator?: EvaluatorDecision[];
  stale: boolean;
  latencyMs: number;
};

export const emptyReviewer = (): ReviewerReport => ({ findings: [], notes: '', blockers: [] });
export const emptyTester = (): TesterReport => ({ tests: [], notes: '' });
export const emptyContract = (): EvaluationContract => ({
  description: 'No evaluation contract could be established.',
  items: [],
  invariants: [],
  regressionRisks: [],
  definitionOfReady: [],
  definitionOfDone: [],
});
