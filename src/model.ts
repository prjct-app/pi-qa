import type { Api, Model } from '@earendil-works/pi-ai';

export type QaModel = Pick<Model<Api>, 'provider' | 'id' | 'name' | 'reasoning' | 'cost' | 'contextWindow' | 'maxTokens'>;

export function selectQaModel(available: readonly QaModel[], current: QaModel | undefined, override?: string): QaModel | undefined {
  const candidates = available.length ? available : current ? [current] : [];
  if (override) {
    const exact = candidates.find(model => override === model.id || override === `${model.provider}/${model.id}` || override.toLowerCase() === model.name.toLowerCase());
    if (exact) return exact;
  }
  return [...candidates].sort(compare)[0];
}

const compare = (a: QaModel, b: QaModel): number => {
  const left = score(a);
  const right = score(b);
  for (const index of [0, 1, 2, 3, 4] as const) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`);
};

const score = (model: QaModel): readonly [number, number, number, number, number] => {
  const label = `${model.id} ${model.name}`.toLowerCase();
  const tier = TIER_PATTERNS.findIndex(pattern => pattern.test(label));
  const parameterMatch = /(?:^|[-_\s:/])(\d+(?:\.\d+)?)b(?:$|[-_\s:/])/i.exec(label);
  const parameterSize = parameterMatch ? Number(parameterMatch[1]) : 1_000;
  const cost = finite(model.cost.input) + finite(model.cost.output);
  return [tier < 0 ? 100 : tier, parameterSize, cost, model.maxTokens, model.contextWindow];
};

const finite = (value: number): number => Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;

const TIER_PATTERNS = [
  /(?:^|[-_\s:/])1b(?:$|[-_\s:/])/, /(?:^|[-_\s:/])3b(?:$|[-_\s:/])/, /(?:^|[-_\s:/])7b(?:$|[-_\s:/])/, /(?:^|[-_\s:/])8b(?:$|[-_\s:/])/,
  /\bnano\b/, /\bmini\b/, /\bsmall\b/, /\blite\b/, /\bflash(?:[-_\s]?lite)?\b/, /\bhaiku\b/,
] as const;
