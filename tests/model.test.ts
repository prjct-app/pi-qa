import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectQaModel, type QaModel } from '../src/model.ts';

const model = (id: string, input = 1, output = 2): QaModel => ({
  provider: 'fixture', id, name: id, reasoning: true,
  cost: { input, output, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 16_000,
});

test('uses the session model, not the smallest or cheapest one', () => {
  const selected = selectQaModel([model('frontier-max', 10, 30), model('qa-mini', 1, 2), model('qa-haiku', 0.5, 1), model('coder-3b')], model('frontier-max'));
  assert.equal(selected?.id, 'frontier-max');
});

test('without a session model the first available one is used, in the order Pi lists them', () => {
  assert.equal(selectQaModel([model('frontier'), model('coder-3b')], undefined)?.id, 'frontier');
  assert.equal(selectQaModel([], undefined), undefined);
});

test('respects a configured model override when it is available', () => {
  const selected = selectQaModel([model('qa-mini'), model('frontier-max')], undefined, 'fixture/frontier-max');
  assert.equal(selected?.id, 'frontier-max');
});

test('the current model stands in when the client exposes no available list', () => {
  assert.equal(selectQaModel([], model('current-only'))?.id, 'current-only');
});
