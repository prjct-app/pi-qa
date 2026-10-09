import { appendFileSync } from 'node:fs';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getCurrentTools, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';

import { REVIEWER_REPORT_TOOL, TESTER_REPORT_TOOL } from '../../src/schema.ts';

/**
 * Spy fixture for the PRJ-T314 regression: registers an offline provider that
 * records the active tool allowlist passed into the model stream to a file
 * (`PI_QA_TOOLS_SPY_FILE`), then submits the matching QA report tool so the
 * runner completes. The role is inferred from which report tool is in the
 * allowlist. Used by tests/runner-tools.test.ts to assert the tester sees
 * `qa_browser` and the reviewer does not.
 */
export default function toolsSpyFixture(pi: ExtensionAPI): void {
  pi.registerProvider('qa-tools-spy', {
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'fixture-only',
    api: 'openai-completions',
    models: [{
      id: 'offline',
      name: 'Offline tools spy',
      reasoning: false,
      input: ['text'],
      contextWindow: 32000,
      maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model, context, options) {
      const target = process.env.PI_QA_TOOLS_SPY_FILE;
      const names = getCurrentTools(context.messages).map(tool => tool.name);
      if (target) {
        const hasReviewer = names.includes(REVIEWER_REPORT_TOOL);
        const hasTester = names.includes(TESTER_REPORT_TOOL);
        const inferredRole = hasReviewer && !hasTester ? 'reviewer' : hasTester && !hasReviewer ? 'tester' : 'unknown';
        try {
          appendFileSync(target, JSON.stringify({ role: inferredRole, tools: names }) + '\n');
        } catch {
          // Recording is best-effort; the test treats a missing side-channel as a failure.
        }
      }

      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: 'assistant',
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(),
        stopReason: 'toolUse',
      };
      const finish = () => {
        if (names.includes(REVIEWER_REPORT_TOOL)) {
          message.content = [{ type: 'toolCall', id: 'spy-review', name: REVIEWER_REPORT_TOOL, arguments: {
            findings: [], notes: 'spy reviewer', blockers: [],
          } }];
        } else if (names.includes(TESTER_REPORT_TOOL)) {
          message.content = [{ type: 'toolCall', id: 'spy-test', name: TESTER_REPORT_TOOL, arguments: {
            tests: [], notes: 'spy tester',
          } }];
        } else {
          message.stopReason = 'stop';
          message.content = [{ type: 'text', text: 'No report tool available.' }];
        }
        stream.push({ type: 'done', reason: 'toolUse', message });
        stream.end();
      };
      void options;
      queueMicrotask(finish);
      return stream;
    },
  });
}
