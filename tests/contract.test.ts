import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveContract, sanitizeContract } from '../src/contract.ts';

test('without a ticket or written intent, criteria are inferred and not required', () => {
  const contract = deriveContract({}, ['src/add.ts']);
  assert.ok(contract.items.length > 0);
  assert.ok(contract.items.every(item => item.source === 'inferred_from_diff'));
  assert.ok(contract.items.every(item => item.required === false));
});

test('user request items stay explicit; inferred items stay inferred', () => {
  const contract = deriveContract({ userRequest: { text: 'Add subtract(a, b)', ref: 'session:user' } }, ['src.js']);
  assert.ok(contract.items.some(item => item.source === 'user_request' && item.required));
  assert.ok(contract.items.some(item => item.source === 'inferred_from_diff' && !item.required));
});

test('the model cannot relabel inferred criteria as user requirements', () => {
  const { contract, problems } = sanitizeContract({
    description: 'ship it',
    items: [{
      id: 'X1',
      text: 'Secretly also rewrite auth',
      source: 'user_request',
      sourceRef: 'model',
      required: true,
      observe: 'look around',
    }],
    invariants: [],
    regressionRisks: [],
    definitionOfReady: [],
    definitionOfDone: [],
  }, { userRequest: { text: 'Add subtract(a, b)', ref: 'session:user' } });
  assert.equal(contract.items[0]?.source, 'inferred_from_diff');
  assert.equal(contract.items[0]?.required, false);
  assert.ok(problems.length > 0);
  assert.ok(problems.some(problem => /X1|user_request/i.test(problem)));
});

test('agents read the English mission while provenance keeps the verbatim original', () => {
  const original = 'Valida que el login rechace correos vacíos';
  const intent = {
    userRequest: { text: original, ref: 'command:/qa', english: 'Check that login rejects empty emails.' },
    plan: { text: 'Plan:\n1. Agrega la validación', items: ['Agrega la validación'], ref: 'plan', englishItems: ['Add the validation.'] },
  };
  const contract = deriveContract(intent, [], intent.userRequest.english);
  assert.equal(contract.description, 'Check that login rejects empty emails.');
  assert.deepEqual(contract.items.map(item => [item.text, item.sourceText]), [
    ['Check that login rejects empty emails.', original],
    ['Add the validation.', 'Agrega la validación'],
  ]);
  const kept = sanitizeContract({ ...contract }, intent);
  assert.deepEqual(kept.problems, [], 'the original still proves the source');
});
