import type { Api, Model } from '@earendil-works/pi-ai';

export type QaModel = Pick<Model<Api>, 'provider' | 'id' | 'name' | 'reasoning' | 'cost' | 'contextWindow' | 'maxTokens'>;

/**
 * QA judges work, so it runs on the model the person is using. A configured
 * override that is available wins; the first available model is the fallback
 * only when the session has none. Picking the smallest or cheapest model
 * handed the hardest judgement to the weakest reader.
 */
export function selectQaModel(available: readonly QaModel[], current: QaModel | undefined, override?: string): QaModel | undefined {
  const candidates = available.length ? available : current ? [current] : [];
  if (override) {
    const exact = candidates.find(model => override === model.id || override === `${model.provider}/${model.id}` || override.toLowerCase() === model.name.toLowerCase());
    if (exact) return exact;
  }
  return current ?? candidates[0];
}
