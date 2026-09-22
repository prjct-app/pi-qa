import { TypeSafeClient, choice } from '@typesafe-ai/sdk';
import type { JevDecision } from './schema.ts';
import type { QaSettings } from './settings.ts';
import { clip, plain } from './text.ts';

export type JsonState = { [key: string]: string | number | boolean | null | JsonState | JsonState[] };
export type JevAnswers = Record<string, { choice?: string; confidence?: number }>;

export type JevClient = {
  modelPin: string;
  systemOne: (request: { state: JsonState | string; questions: Record<string, unknown>; model?: string }, options?: { signal?: AbortSignal }) => Promise<{
    answers: JevAnswers;
    model: string;
    usage: { input_tokens: number; output_tokens: number };
  }>;
};

export type JevFactory = (apiKey: string, settings: QaSettings) => JevClient;

export const createJevClient: JevFactory = (apiKey, settings) => {
  const client = new TypeSafeClient({
    apiKey,
    defaultModel: settings.jevModel,
    logLevel: 'off',
    timeout: settings.jevTimeoutMs,
    dangerouslyAllowBrowser: false,
  });
  return {
    modelPin: settings.jevModel,
    systemOne: async (request, options) => {
      const result = await client.systemOne({
        model: request.model ?? settings.jevModel,
        state: request.state,
        questions: request.questions as never,
      }, options);
      return { answers: result.answers as JevAnswers, model: result.model, usage: result.usage };
    },
  };
};

export type QaBatchSubject = {
  key: string;
  subjectId: string;
  question: 'test' | 'criterion';
  prompt: string;
};

export type QaBatchResult = {
  decisions: JevDecision[];
  modelActual?: string;
  error?: string;
  inputTokens: number;
  outputTokens: number;
};

const LABELS = {
  supports: 'The host evidence supports the expected behavior.',
  contradicts: 'The host evidence contradicts the expected behavior.',
  insufficient_evidence: 'The host evidence is insufficient or does not address the expected behavior.',
} as const;

/** One Jev request evaluates every test case and requirement after the QA agent has finished. */
export async function evaluateQaBatch(
  client: JevClient,
  state: JsonState,
  subjects: readonly QaBatchSubject[],
  settings: QaSettings,
  signal?: AbortSignal,
): Promise<QaBatchResult> {
  if (subjects.length === 0) return { decisions: [], inputTokens: 0, outputTokens: 0 };
  try {
    const questions = Object.fromEntries(subjects.map(subject => [subject.key, choice(subject.prompt, LABELS)]));
    const result = await client.systemOne({ model: client.modelPin, state, questions }, { signal });
    return {
      decisions: subjects.map(subject => {
        const answer = result.answers[subject.key];
        const picked = answer?.choice;
        const confidence = answer?.confidence ?? 0;
        const label: JevDecision['label'] = confidence < settings.confidenceThreshold
          ? 'low_confidence'
          : picked === 'supports' || picked === 'contradicts' || picked === 'insufficient_evidence'
            ? picked
            : 'insufficient_evidence';
        return {
          subjectId: subject.subjectId,
          question: subject.question,
          label,
          confidence,
          model: result.model,
          inputTokens: result.usage.input_tokens,
          outputTokens: result.usage.output_tokens,
        };
      }),
      modelActual: result.model,
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
    };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const timeout = /timeout|aborted|AbortError|APIUserAbort/i.test(text);
    const sanitized = clip(plain(text), 300);
    return {
      decisions: subjects.map(subject => ({
        subjectId: subject.subjectId,
        question: subject.question,
        label: timeout ? 'timeout' : 'unavailable',
        confidence: 0,
        model: client.modelPin,
        inputTokens: 0,
        outputTokens: 0,
        error: sanitized,
      })),
      error: sanitized,
      inputTokens: 0,
      outputTokens: 0,
    };
  }
}
