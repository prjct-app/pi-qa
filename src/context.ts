import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { fingerprintText, type IntentContext } from './contract.ts';
import { clip, plain } from './text.ts';

const TICKET_FILES = ['TICKET.md', '.pi/ticket.md', 'ticket.md'] as const;

export async function loadIntent(ctx: ExtensionContext, cwd: string): Promise<IntentContext> {
  const entries = ctx.sessionManager.getBranch();
  const user = lastUserText(entries);
  const plan = lastPlan(entries);
  const ticket = await loadTicket(cwd);
  const memory = projectMemory(ctx.getSystemPrompt());
  return {
    userRequest: user ? { text: user, ref: 'session:user' } : undefined,
    plan,
    ticket,
    memory: memory ? { text: memory, ref: 'pi-memory:project' } : undefined,
  };
}

export function projectMemory(systemPrompt: string): string | undefined {
  const match = /<project_memory(?:\s[^>]*)?>([\s\S]*?)<\/project_memory>/i.exec(systemPrompt);
  const text = match?.[1] ? clip(plain(match[1]).trim(), 4_000) : '';
  return text || undefined;
}

export function lastUserText(entries: readonly { type?: string; message?: unknown }[]): string | undefined {
  const latest = [...entries].reverse().find(entry => entry.type === 'message');
  const message = latest?.message as { role?: string; content?: unknown } | undefined;
  if (message?.role !== 'user') return undefined;
  return contentText(message.content) || undefined;
}

const lastPlan = (entries: readonly { type?: string; customType?: string; data?: unknown }[]): IntentContext['plan'] => {
  const hit = [...entries].reverse().find(entry => entry.type === 'custom' && (entry.customType === 'plan' || entry.customType === 'pi-plan'));
  if (!hit || !hit.data || typeof hit.data !== 'object') return undefined;
  const data = hit.data as { text?: string; markdown?: string; todos?: Array<{ text?: string; title?: string }> };
  const text = data.text ?? data.markdown ?? '';
  const items = (data.todos ?? []).map(todo => todo.text ?? todo.title ?? '').filter(Boolean);
  if (!text && items.length === 0) return undefined;
  return { text, items, ref: 'session:plan' };
};

const loadTicket = async (cwd: string): Promise<IntentContext['ticket']> => {
  const found = await firstFile(cwd, TICKET_FILES);
  if (!found) return undefined;
  const sections = splitSections(found.text);
  return {
    text: found.text,
    ac: bullets(sections['acceptance criteria'] ?? sections.ac ?? ''),
    dor: bullets(sections['definition of ready'] ?? sections.dor ?? ''),
    dod: bullets(sections['definition of done'] ?? sections.dod ?? ''),
    ref: found.path,
    fingerprint: fingerprintText(found.text),
  };
};

const firstFile = async (cwd: string, names: readonly string[]): Promise<{ path: string; text: string } | undefined> => {
  if (names.length === 0) return undefined;
  const path = join(cwd, names[0]!);
  try {
    const text = await readFile(path, 'utf8');
    return { path, text };
  } catch {
    return firstFile(cwd, names.slice(1));
  }
};

const splitSections = (text: string): Record<string, string> =>
  text.split(/^#{1,3}\s+/m).reduce<Record<string, string>>((acc, block) => {
    const nl = block.indexOf('\n');
    if (nl < 0) return acc;
    acc[block.slice(0, nl).trim().toLowerCase()] = block.slice(nl + 1);
    return acc;
  }, {});

const bullets = (text: string): string[] =>
  text.split('\n').map(line => line.replace(/^\s*[-*]\s+/, '').trim()).filter(line => line.length > 0 && !line.startsWith('#'));

const contentText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object' && 'text' in part && typeof (part as { text: unknown }).text === 'string') {
      return (part as { text: string }).text;
    }
    return '';
  }).join('\n');
};
