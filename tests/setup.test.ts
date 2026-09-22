import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyEvaluatorKey } from '../src/setup.ts';
import { defaultSettings } from '../src/settings.ts';
import { fakeJev } from './fixtures/fakes.ts';

test('embedded evaluator accepts a valid global key with one request', async () => {
  const calls = { count: 0 };
  const baseFactory = fakeJev({});
  const factory = ((key, settings) => {
    const client = baseFactory(key, settings);
    return { ...client, systemOne: (async request => { calls.count += 1; return client.systemOne(request); }) as typeof client.systemOne };
  }) satisfies typeof baseFactory;
  assert.equal(await verifyEvaluatorKey('k'.repeat(20), defaultSettings(), factory), undefined);
  assert.equal(calls.count, 1);
});

test('embedded evaluator returns a bounded validation error', async () => {
  const error = await verifyEvaluatorKey('k'.repeat(20), defaultSettings(), fakeJev({ timeout: true }));
  assert.match(error ?? '', /timeout/i);
  assert.ok((error ?? '').length <= 300);
});
