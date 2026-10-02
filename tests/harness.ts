import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { installQa, type QaDependencies } from '../src/index.ts';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { COMMAND } from '../src/schema.ts';

type Handler = (event: unknown, context: unknown) => unknown;

export function harness(root: string, options: {
  mode?: 'tui' | 'rpc' | 'print' | 'json';
  dependencies?: QaDependencies;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  availableModels?: Array<Record<string, unknown> & { provider: string; id: string }>;
  systemPrompt?: string;
} = {}) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const notices: string[] = [];
  const entries: unknown[] = [];
  const customCalls: unknown[] = [];
  const sessionManager = SessionManager.inMemory(root);
  const context = {
    cwd: root,
    mode: options.mode ?? 'tui',
    hasUI: !['print', 'json'].includes(options.mode ?? 'tui'),
    isProjectTrusted: () => true,
    model: options.model ?? { provider: 'qa-fixture', id: 'offline' },
    thinkingLevel: options.thinkingLevel,
    modelRegistry: { getAvailable: () => options.availableModels ?? [] },
    scopedModels: [],
    sessionManager,
    getSystemPrompt: () => options.systemPrompt ?? '',
    ui: {
      notify: (text: string) => notices.push(text),
      setStatus: () => undefined,
      input: async () => undefined,
      select: async () => undefined,
      confirm: async () => false,
      custom: async (factory: unknown) => { customCalls.push(factory); return null; },
    },
  } as unknown as ExtensionContext;
  const toolContext: ExtensionToolContext = {
    ...context,
    tools: [],
    async executeTool(name) {
      return {
        toolCall: { type: 'toolCall', id: 'test/nested', name, arguments: {} },
        result: { content: [{ type: 'text', text: `Unknown fixture tool: ${name}` }], details: {} },
        isError: true,
      };
    },
  };
  const pi = {
    appendEntry: (type: string, data: unknown) => { entries.push({ type, data }); },
    sendMessage: () => undefined,
    on: (name: string, handler: Handler) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
  } as unknown as ExtensionAPI;
  installQa(pi, options.dependencies);
  return {
    tools, commands, notices, entries, customCalls, sessionManager,
    async emit(name: string) { for (const handler of handlers.get(name) ?? []) await handler({}, context); },
    async command(text: string) { return commands.get(COMMAND)!.handler(text, context); },
    async tool(name: string, params: unknown) { return tools.get(name)!.execute('test', params as never, undefined, undefined, toolContext); },
  };
}
