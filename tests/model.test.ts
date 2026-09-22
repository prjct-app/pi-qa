import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectQaModel, type QaModel } from '../src/model.ts';

const model = (id: string, input = 1, output = 2): QaModel => ({
  provider: 'fixture', id, name: id, reasoning: true,
  cost: { input, output, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 16_000,
});

test('selects the smallest tier from the client available-model list', () => {
  const selected = selectQaModel([model('frontier-max', 10, 30), model('qa-mini', 1, 2), model('qa-haiku', 0.5, 1)], model('frontier-max'));
  assert.equal(selected?.id, 'qa-mini');
});

test('prefers explicit parameter-size models before generic frontier models', () => {
  const selected = selectQaModel([model('coder-8b'), model('coder-3b'), model('frontier')], undefined);
  assert.equal(selected?.id, 'coder-3b');
});

test('respects a configured model override when it is available', () => {
  const selected = selectQaModel([model('qa-mini'), model('frontier-max')], undefined, 'fixture/frontier-max');
  assert.equal(selected?.id, 'frontier-max');
});

test('falls back to the current model only when the client exposes no available list', () => {
  assert.equal(selectQaModel([], model('current-only'))?.id, 'current-only');
});
