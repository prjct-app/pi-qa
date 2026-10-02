import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROUTE_MIN, TASK_LEVELS, modelFor, pickQaModel, routeFor, type RouteChoice } from '../src/route.ts';
import type { JevClient } from '../src/jev.ts';
import type { QaSettings } from '../src/settings.ts';
import type { QaModel } from '../src/model.ts';
import type { SecretStore } from '@prjct.app/pi-tui-kit';

const choices = (ids: readonly string[]): RouteChoice[] => ids.map(modelId => ({ provider: 'test', modelId }));
const model = (id: string, input = 1, output = 2): QaModel => ({
  provider: 'fixture', id, name: id, reasoning: true,
  cost: { input, output, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 16_000,
});

const settings: QaSettings = {
  jevModel: 'jev-1.13.0', confidenceThreshold: 0.8, noulThreshold: 0.8, timeoutMs: 600_000, jevTimeoutMs: 30_000,
  excerptChars: 4_000, largeFileBytes: 262_144, patchChars: 200_000, idleSetupMs: 300_000, routeModels: false,
};

const stubJev = (answer: { choice?: string; confidence?: number } | Error): JevClient => ({
  modelPin: 'jev-1.13.0',
  systemOne: async () => {
    if (answer instanceof Error) throw answer;
    return { answers: { level: answer }, model: 'jev-1.13.0', usage: { input_tokens: 0, output_tokens: 0 } };
  },
});

const noStore: SecretStore = { get: async () => null, set: async () => undefined, delete: async () => undefined };
const envWithKey: NodeJS.ProcessEnv = { TYPESAFE_API_KEY: 'test-key-with-enough-character-to-pass-the-shape-check' };

test('a level picks across the session\'s models, cheapest first', () => {
  const one = choices(['only']);
  assert.equal(modelFor('reading', one), 'only');
  assert.equal(modelFor('reasoning', one), 'only');
  const two = choices(['cheap', 'strong']);
  assert.equal(modelFor('reading', two), 'cheap');
  assert.equal(modelFor('implementation', two), 'strong', 'with two, the middle is the stronger one');
  assert.equal(modelFor('reasoning', two), 'strong');
  const three = choices(['cheap', 'mid', 'strong']);
  assert.deepEqual(TASK_LEVELS.map(level => modelFor(level, three)), ['cheap', 'mid', 'strong']);
  const four = choices(['cheap', 'a', 'b', 'strong']);
  assert.deepEqual(TASK_LEVELS.map(level => modelFor(level, four)), ['cheap', 'b', 'strong']);
});

test('no judge, no answer, or no choice falls back to the session\'s model', async () => {
  const task = { subject: 'map the store', task: 'Read src/store.ts and report what it holds.' };
  for (const routed of [
    await routeFor(task, choices(['cheap']), undefined),
    await routeFor(task, [], stubJev({ choice: 'reading', confidence: 1 })),
  ]) assert.deepEqual(routed, { basis: 'session' });
});

test('an answer worth trusting routes to the level\'s model', async () => {
  const task = { subject: 'map the store', task: 'Read src/store.ts and report what it holds.' };
  const routed = await routeFor(task, choices(['cheap', 'strong']), stubJev({ choice: 'reading', confidence: 0.9 }));
  assert.deepEqual(routed, { level: 'reading', confidence: 0.9, wanted: 'cheap', basis: 'routed' });
});

test('an unsure judge, an unknown level, or a failure falls back to the session', async () => {
  const task = { subject: 'map the store', task: 'Read src/store.ts and report what it holds.' };
  for (const answer of [
    { choice: 'reading', confidence: ROUTE_MIN - 0.01 },
    { choice: 'a level this code does not know', confidence: 1 },
    { choice: 'reading', confidence: Number.NaN },
    new Error('the endpoint is down'),
  ]) {
    const routed = await routeFor(task, choices(['cheap', 'strong']), stubJev(answer as never));
    assert.deepEqual(routed, { basis: 'session' }, JSON.stringify(answer));
  }
});

test('routing is off by default; the QA agent runs on the session\'s model', async () => {
  const picked = await pickQaModel({
    textModels: [model('frontier-max', 10, 30), model('qa-mini', 1, 2)],
    current: model('frontier-max'),
    override: undefined,
    routeEnabled: false,
    mission: 'review the snapshot',
    store: noStore,
    env: {},
    settings,
  });
  assert.equal(picked.model?.id, 'frontier-max', 'opt-out keeps the deliberate design: QA matches the user');
  assert.equal(picked.routing, undefined);
});

test('when routing is on and the mission is reading, the QA agent runs on the cheapest model', async () => {
  const picked = await pickQaModel({
    textModels: [model('frontier-max', 10, 30), model('qa-mini', 1, 2)],
    current: model('frontier-max'),
    override: undefined,
    routeEnabled: true,
    mission: 'review the snapshot and list what is there',
    store: noStore,
    env: envWithKey,
    settings,
    jevFactory: () => stubJev({ choice: 'reading', confidence: 0.9 }),
  });
  assert.equal(picked.model?.id, 'qa-mini');
  assert.equal(picked.routing?.level, 'reading');
});

test('without a Jev key the router falls back to the session\'s model', async () => {
  const picked = await pickQaModel({
    textModels: [model('frontier-max', 10, 30), model('qa-mini', 1, 2)],
    current: model('frontier-max'),
    override: undefined,
    routeEnabled: true,
    mission: 'review the snapshot',
    store: noStore,
    env: {},
    settings,
  });
  assert.equal(picked.model?.id, 'frontier-max');
  assert.equal(picked.routing?.basis, 'session');
});