import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getCurrentTools, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';
import { REVIEWER_REPORT_TOOL, TESTER_REPORT_TOOL } from '../../src/schema.ts';

/** Offline provider that submits the matching QA report tool. */
export default function fixtureProvider(pi: ExtensionAPI): void {
  pi.registerProvider('qa-fixture', {
    baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture-only', api: 'openai-completions',
    models: [{ id: 'offline', name: 'Offline fixture', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(), stopReason: 'toolUse',
      };
      const names = getCurrentTools(context.messages).map(tool => tool.name);
      const wait = JSON.stringify(context.messages).includes('fixture-wait');
      const finish = () => {
        if (wait) {
          message.stopReason = 'aborted';
          stream.push({ type: 'error', reason: 'aborted', error: message });
          stream.end();
          return;
        }
        const previous = context.messages.at(-1);
        if (previous?.role === 'toolResult' && (previous.toolName === REVIEWER_REPORT_TOOL || previous.toolName === TESTER_REPORT_TOOL)) {
          message.stopReason = 'stop';
          message.content = [{ type: 'text', text: 'Report delivered.' }];
          stream.push({ type: 'done', reason: 'stop', message });
          stream.end();
          return;
        }
        if (names.includes(REVIEWER_REPORT_TOOL)) {
          message.content = [{ type: 'toolCall', id: 'fixture-review', name: REVIEWER_REPORT_TOOL, arguments: {
            findings: [], notes: 'Offline SDK reviewer finished.', blockers: [],
          } }];
        } else if (previous?.role === 'toolResult' && previous.toolName === 'bash') {
          const receipt = /QA execution receipt: ([^"\\n]+)/.exec(JSON.stringify(previous))?.[1];
          message.content = [{ type: 'toolCall', id: 'fixture-test', name: TESTER_REPORT_TOOL, arguments: {
            tests: [{ id: 't1', command: 'node -e "process.exit(0)"', cwd: '.', exitCode: 0, expected: 'process exits successfully', expectedSource: 'default_smoke', observed: 'exit 0', assertion: 'process starts', contractItemIds: [], executionIds: receipt ? [receipt] : [] }],
            notes: 'Offline SDK tester finished.',
          } }];
        } else {
          message.content = [{ type: 'toolCall', id: 'fixture-bash', name: 'bash', arguments: { command: 'node -e "process.exit(0)"' } }];
        }
        stream.push({ type: 'done', reason: 'toolUse', message });
        stream.end();
      };
      if (wait) {
        if (options?.signal?.aborted) finish();
        else options?.signal?.addEventListener('abort', finish, { once: true });
      } else queueMicrotask(finish);
      return stream;
    },
  });
}
