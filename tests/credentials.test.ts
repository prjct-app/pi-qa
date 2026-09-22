import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keyringStoreFromEntries, markKeyRejected, publicStatus, removeKey, resolveKey, saveKey } from '../src/credentials.ts';
import { failingStore, memoryStore } from './fixtures/fakes.ts';

test('native keyring adapter stores the secret argument, not the account name', async () => {
  const global = fakeEntry();
  const legacy = fakeEntry('typesafe-api-key');
  const store = keyringStoreFromEntries(global.entry, [legacy.entry]);
  assert.equal(await store.get('api-key'), null);
  assert.equal(legacy.value(), null);
  await store.set('api-key', 'real-typesafe-secret');
  assert.equal(global.value(), 'real-typesafe-secret');
  assert.equal(await store.get('api-key'), 'real-typesafe-secret');
});

test('native keyring adapter migrates a valid legacy secret globally', async () => {
  const global = fakeEntry();
  const legacy = fakeEntry('legacy-real-secret');
  const store = keyringStoreFromEntries(global.entry, [legacy.entry]);
  assert.equal(await store.get('api-key'), 'legacy-real-secret');
  assert.equal(global.value(), 'legacy-real-secret');
  assert.equal(legacy.value(), null);
});

test('missing TypeSafe key is missing, not a pass', async () => {
  const resolved = await resolveKey(memoryStore(), {});
  assert.equal(resolved.state, 'missing');
  assert.equal(resolved.key, undefined);
});

test('TYPESAFE_API_KEY is used and not copied into the store', async () => {
  const store = memoryStore();
  const resolved = await resolveKey(store, { TYPESAFE_API_KEY: 'env-key-value-12345' });
  assert.equal(resolved.source, 'env');
  assert.equal(resolved.state, 'usable');
  assert.equal(await store.get('typesafe-api-key'), null);
});

test('legacy raw keyring values remain readable but unverified', async () => {
  const resolved = await resolveKey(memoryStore('typesafe-test-key-12345'), {});
  assert.equal(resolved.state, 'usable');
  assert.equal(resolved.verified, false);
});

test('invalid stored keys are invalid', async () => {
  const resolved = await resolveKey(memoryStore('short'), {});
  assert.equal(resolved.state, 'invalid');
});

test('keyring failure is inaccessible with no plaintext fallback', async () => {
  const resolved = await resolveKey(failingStore(), {});
  assert.equal(resolved.state, 'inaccessible');
  assert.match(resolved.detail, /keyring/i);
  assert.deepEqual(publicStatus(resolved).state, 'inaccessible');
  assert.equal('key' in publicStatus(resolved), false);
});

test('401 rejection clears verification without deleting the key', async () => {
  const store = memoryStore();
  await saveKey(store, 'typesafe-test-key-12345', true);
  await markKeyRejected(store, 'typesafe-test-key-12345');
  const resolved = await resolveKey(store, {});
  assert.equal(resolved.state, 'usable');
  assert.equal(resolved.verified, false);
  assert.equal(resolved.key, 'typesafe-test-key-12345');
  assert.match(resolved.fingerprint ?? '', /^[a-f0-9]{12}$/);
});

const fakeEntry = (initial: string | null = null) => {
  const state: { value: string | null } = { value: initial };
  return {
    entry: {
      getPassword: async () => state.value,
      setPassword: async (secret: string) => { state.value = secret; },
      deletePassword: async () => { state.value = null; },
    },
    value: () => state.value,
  };
};

test('verified key and verification metadata survive a new store read', async () => {
  const store = memoryStore();
  const saved = await saveKey(store, 'typesafe-test-key-12345', true);
  assert.equal(saved.verified, true);
  const reloaded = await resolveKey(store, {});
  assert.equal(reloaded.state, 'usable');
  assert.equal(reloaded.verified, true);
  assert.ok(reloaded.verifiedAt);
  assert.equal('key' in publicStatus(reloaded), false);
  const removed = await removeKey(store);
  assert.equal(removed.state, 'missing');
});
