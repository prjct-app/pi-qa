import type { AgentOutcome, AgentRole, ReviewerReport, TesterReport } from '../../src/schema.ts';
import type { QaRunner } from '../../src/runner.ts';
import type { EvaluatorClient } from '../../src/evaluator.ts';
import { defaultSettings } from '../../src/settings.ts';

export function fakeRunner(reports: { reviewer?: ReviewerReport; tester?: TesterReport; fail?: AgentRole; timeout?: AgentRole }): QaRunner {
  return async input => {
    if (input.signal.aborted) return { role: input.role, status: 'canceled', latencyMs: 1 };
    if (reports.timeout === input.role) return { role: input.role, status: 'timeout', error: 'Agent timed out.', latencyMs: 1 };
    if (reports.fail === input.role) return { role: input.role, status: 'failed', error: 'Agent failed.', latencyMs: 1 };
    if (input.role === 'reviewer') {
      return { role: 'reviewer', status: 'completed', report: reports.reviewer ?? { findings: [], notes: 'clean', blockers: [] }, latencyMs: 2 };
    }
    const report = reports.tester ?? { tests: [], notes: 'none' };
    return {
      role: 'tester', status: 'completed',
      report: { ...report, tests: report.tests.map(test => ({ ...test, expected: test.expected ?? test.assertion, expectedSource: test.expectedSource ?? 'existing_test' as const })) },
      latencyMs: 2,
    };
  };
}

export function trackingRunner(): { runner: QaRunner; launched: AgentRole[] } {
  const launched: AgentRole[] = [];
  return {
    launched,
    runner: async input => {
      launched.push(input.role);
      if (input.role === 'reviewer') {
        return { role: 'reviewer', status: 'completed', report: { findings: [], notes: 'ok', blockers: [] }, latencyMs: 1 };
      }
      return { role: 'tester', status: 'completed', report: { tests: [], notes: 'ok' }, latencyMs: 1 };
    },
  };
}

export const fakeEvaluator = (opts: {
  finding?: 'supports' | 'contradicts' | 'insufficient_evidence';
  criterion?: 'supports' | 'contradicts' | 'insufficient_evidence';
  test?: 'supports' | 'contradicts' | 'insufficient_evidence';
  relevant?: boolean;
  confidence?: number;
  timeout?: boolean;
  model?: string;
}): EvaluatorClient => {
    const client: EvaluatorClient = {
      modelPin: 'fixture/active-model',
      systemOne: async request => {
        if (opts.timeout) {
          const error = new Error('timeout');
          error.name = 'TimeoutError';
          throw error;
        }
        const questions = request.questions as Record<string, { type?: string }>;
        const confidence = opts.confidence ?? 0.92;
        const model = opts.model ?? 'fixture/active-model';
        const usage = { input_tokens: 12, output_tokens: 3 };
        const answers = Object.fromEntries(Object.keys(questions).map(key => {
          const picked = key.startsWith('test_')
            ? opts.test ?? (opts.relevant === false ? 'insufficient_evidence' : opts.criterion ?? 'supports')
            : opts.criterion ?? 'supports';
          return [key, { choice: picked, confidence }];
        }));
        return { answers, model, usage } as Awaited<ReturnType<EvaluatorClient['systemOne']>>;
      },
    };
    return client;
};
