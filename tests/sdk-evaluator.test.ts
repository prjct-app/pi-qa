import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createSdkEvaluator } from '../src/sdk-evaluator.ts';

test('QA evaluates through Pi on the inherited model and reasoning, retaining unknowns', async () => {
  const model = { provider: 'fixture', id: 'frontier', maxTokens: 16384 };
  const calls: unknown[] = [];
  const runtime = {
    getModel(provider: string, id: string) { assert.equal(provider, model.provider); assert.equal(id, model.id); return model; },
    async completeSimple(selected: unknown, context: unknown, options: { reasoning?: string }) {
      assert.equal(selected, model);
      assert.equal(options.reasoning, 'high');
      calls.push(context);
      return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ answers: {
        passed: { choice: 'supports', confidence: 0.95 },
        invalid: { choice: 'supports', confidence: 5 },
      } }) }], usage: { input: 20, cacheRead: 10, cacheWrite: 0, output: 8 } };
    },
  } as unknown as Pick<ModelRuntime, 'getModel' | 'completeSimple'>;
  const client = createSdkEvaluator({ model, thinkingLevel: 'high', timeoutMs: 1000, runtime: async () => runtime });
  const result = await client.systemOne({ state: { output: 'CLI assertion passed', contact: 'person@example.com' }, questions: {
    passed: 'Did the assertion pass?', missing: 'Was the UI tested?', invalid: 'Anything else?',
  } });
  assert.equal(calls.length, 1);
  assert.match(JSON.stringify(calls[0]), /CLI assertion passed/);
  assert.ok(!JSON.stringify(calls[0]).includes('person@example.com'));
  assert.ok(JSON.stringify(calls[0]).includes('p**********@****.com'));
  assert.equal(result.model, 'fixture/frontier');
  assert.equal(result.answers.passed?.choice, 'supports');
  assert.deepEqual(result.answers.missing, { choice: 'insufficient_evidence', confidence: 0 });
  assert.deepEqual(result.answers.invalid, { choice: 'insufficient_evidence', confidence: 0 });
});

test('an unavailable Pi model cannot produce a QA success', async () => {
  const client = createSdkEvaluator({ model: { provider: 'fixture', id: 'missing' }, timeoutMs: 1000,
    runtime: async () => ({ getModel: () => undefined }) as unknown as ModelRuntime });
  await assert.rejects(client.systemOne({ state: {}, questions: {} }), /unavailable/);
});

test('QA keeps extension-registered providers and authentication on the parent registry', async () => {
  const model = { provider: 'extension-provider', id: 'selected', maxTokens: 2048 };
  const seen: unknown[] = [];
  const registry = {
    find: () => model,
    streamSimple(selected: unknown, context: unknown, options: { reasoning?: string }) {
      assert.equal(selected, model);
      assert.equal(options.reasoning, 'high');
      seen.push(context);
      return { result: async () => ({ stopReason: 'stop', content: [{ type: 'text', text: '{"answers":{"evidence":{"choice":"supports","confidence":0.9}}}' }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }) };
    },
  };
  const client = createSdkEvaluator({ model, thinkingLevel: 'high', timeoutMs: 1000,
    registry: registry as unknown as NonNullable<Parameters<typeof createSdkEvaluator>[0]['registry']>,
    runtime: async () => { throw new Error('must reuse the parent provider'); } });
  const result = await client.systemOne({ state: { output: 'original evidence' }, questions: { evidence: 'Does the record support this?' } });
  assert.equal(result.answers.evidence?.choice, 'supports');
  assert.equal(seen.length, 1);
});
