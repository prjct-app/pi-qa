import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { IntentContext } from './contract.ts';
import { branchTaskIds, currentTaskText, lastUserText, userRequestHistory, taskIds, usesActiveTask } from './task-context.ts';
import { loadTicket, markdownPaths } from './tickets.ts';
import { clip, plain } from './text.ts';

export async function loadIntent(ctx: Pick<ExtensionContext, 'sessionManager' | 'getSystemPrompt'>, cwd: string, request?: string): Promise<IntentContext> {
  const entries = ctx.sessionManager.getBranch();
  const user = lastUserText(entries);
  const plan = request || user ? undefined : lastPlan(entries);
  const explicit = request ? await loadTicket(cwd, request) : undefined;
  const ticket = explicit ?? (usesActiveTask(request) ? await activeTicket(cwd, currentTaskText(entries)) : undefined);
  const memory = projectMemory(ctx.getSystemPrompt());
  return {
    userRequest: user ? { text: userRequestHistory(entries) ?? user, ref: 'session:user' } : undefined,
    plan,
    ticket,
    memory: memory ? { text: memory, ref: 'pi-memory:project' } : undefined,
  };
}

async function activeTicket(cwd: string, context: string): Promise<IntentContext['ticket']> {
  const contextual = taskIds(context);
  const branch = await branchTaskIds(cwd);
  const aligned = contextual.filter(id => branch.includes(id));
  const ids = contextual.length === 1 ? contextual : aligned.length === 1 ? aligned : branch;
  const paths = markdownPaths(context).filter(path => /(?:^|\/)docs\//.test(path));
  const matching = ids.length === 1 ? paths.filter(path => path.toUpperCase().includes(ids[0]!)) : paths;
  if (matching.length === 1) return loadTicket(cwd, matching[0]!);
  if (ids.length > 1) throw new Error('Multiple active QA tasks found. Specify one ticket ID or Markdown path.');
  if (ids.length === 1) return loadTicket(cwd, ids[0]!);
  if (contextual.length > 1 || matching.length > 1) throw new Error('Ambiguous QA task. Specify one ticket ID or Markdown path.');
  return undefined;
}

export function projectMemory(systemPrompt: string): string | undefined {
  const match = /<project_memory(?:\s[^>]*)?>([\s\S]*?)<\/project_memory>/i.exec(systemPrompt);
  const text = match?.[1] ? clip(plain(match[1]).trim(), 4_000) : '';
  return text || undefined;
}

export { lastUserText };

const lastPlan = (entries: readonly { type?: string; customType?: string; data?: unknown }[]): IntentContext['plan'] => {
  const hit = [...entries].reverse().find(entry => entry.type === 'custom' && (entry.customType === 'plan' || entry.customType === 'pi-plan'));
  if (!hit || !hit.data || typeof hit.data !== 'object') return undefined;
  const data = hit.data;
  const text = 'text' in data && typeof data.text === 'string' ? data.text
    : 'markdown' in data && typeof data.markdown === 'string' ? data.markdown : '';
  const todos: unknown[] = 'todos' in data && Array.isArray(data.todos) ? data.todos : [];
  const items = todos.flatMap(todo => {
    if (!todo || typeof todo !== 'object') return [];
    if ('text' in todo && typeof todo.text === 'string') return [todo.text];
    if ('title' in todo && typeof todo.title === 'string') return [todo.title];
    return [];
  });
  if (!text && items.length === 0) return undefined;
  return { text, items, ref: 'session:plan' };
};
