import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastUserText, projectMemory } from '../src/context.ts';

const message = (role: string, text: string) => ({ type: 'message', message: { role, content: text } });

test('uses the latest user message only when it is the current conversational entry', () => {
  assert.equal(lastUserText([message('assistant', 'done'), message('user', 'test login')]), 'test login');
});

test('extracts bounded project memory from the Pi system prompt', () => {
  assert.equal(projectMemory('before <project_memory>Recent release constraint</project_memory> after'), 'Recent release constraint');
  assert.equal(projectMemory('no memory'), undefined);
});

test('does not reach backward past a newer assistant response for unrelated intent', () => {
  assert.equal(lastUserText([message('user', 'old task'), message('assistant', 'completed')]), undefined);
});
