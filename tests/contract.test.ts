import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveContract, focusContract, sanitizeContract } from '../src/contract.ts';

test('without a ticket or written intent, one inferred smoke item is not required', () => {
  const contract = deriveContract({}, ['src/add.ts', 'src/other.ts', 'README.md']);
  assert.equal(contract.items.length, 1);
  assert.equal(contract.items[0]?.source, 'inferred_from_diff');
  assert.equal(contract.items[0]?.required, false);
});

test('an explicit request does not grow a case per changed file', () => {
  const contract = deriveContract({ userRequest: { text: 'Add subtract(a, b)', ref: 'session:user' } }, ['src.js', 'package.json', 'README.md']);
  assert.deepEqual(contract.items.map(item => item.source), ['user_request']);
  assert.equal(contract.items[0]?.required, true);
});

test('focus keeps required outcomes and drops inferred file probes', () => {
  const contract = focusContract({
    description: 'ship it',
    items: [
      { id: 'U1', text: 'Add subtract(a, b)', source: 'user_request', sourceRef: 'session:user', required: true, observe: 'call it' },
      { id: 'I1', text: 'src.js should not regress', source: 'inferred_from_diff', sourceRef: 'src.js', required: false, observe: 'look' },
      { id: 'T-DOR1', text: 'ticket is ready', source: 'ticket', sourceRef: 'ticket', required: false, observe: 'record' },
    ],
    invariants: [], regressionRisks: ['src.js should not regress'], definitionOfReady: [], definitionOfDone: [],
  });
  assert.deepEqual(contract.items.map(item => item.id), ['U1']);
  assert.deepEqual(contract.regressionRisks, []);
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
