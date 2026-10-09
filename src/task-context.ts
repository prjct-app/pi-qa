import { git, type GitExec } from './git.ts';

export type ContextEntry = { type?: string; message?: unknown; summary?: string };

/** Preserve author intent; selecting which requirements still apply belongs to the model. */
export function userRequestHistory(entries: readonly ContextEntry[]): string | undefined {
  const compactedAt = entries.findLastIndex(entry => entry.type === 'compaction');
  const summary = compactedAt >= 0 ? entries[compactedAt]?.summary : undefined;
  const requests = entries.slice(compactedAt + 1).flatMap(entry => entry.type === 'message'
    && object(entry.message) && entry.message.role === 'user' ? [contentText(entry.message.content)] : []).filter(Boolean);
  if (!summary && requests.length <= 1) return requests[0];
  return [
    'User request history in chronological order. Preserve the original mission and added constraints; later explicit corrections or task replacements take precedence. Generic status or testing requests do not erase prior requirements.',
    ...(summary ? [`Prior compacted context (verify claims against execution evidence):\n${summary}`] : []),
    ...requests.map((text, index) => `User message ${index + 1}:\n${text}`),
  ].join('\n\n');
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';

export const contentText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part: unknown) => {
    if (typeof part === 'string') return part;
    if (!object(part)) return '';
    if (typeof part.text === 'string') return part.text;
    // Typed answers are tool calls, not assistant text. Read only their answer,
    // not arbitrary tool output or older turns that may contain unrelated tickets.
    if (part.type === 'toolCall' && object(part.arguments)) {
      if (part.name === 'pi_qa_contract' && typeof part.arguments.ticketRef === 'string') return part.arguments.ticketRef;
      if (part.name === 'answer') {
        const refs: unknown[] = Array.isArray(part.arguments.refs) ? part.arguments.refs : [];
        const paths = refs.flatMap(ref => object(ref) && typeof ref.path === 'string' && ref.path.endsWith('.md') ? [ref.path] : []);
        return [typeof part.arguments.answer === 'string' ? part.arguments.answer : '', ...paths].join('\n');
      }
    }
    return '';
  }).join('\n');
};

export function currentTaskText(entries: readonly ContextEntry[]): string {
  const index = entries.findLastIndex(entry => entry.type === 'message' && object(entry.message) && entry.message.role === 'user');
  if (index < 0) return '';
  const message = entries[index]?.message;
  const previous = entries.slice(0, index).findLastIndex(entry => entry.type === 'message' && object(entry.message) && entry.message.role === 'user');
  const start = object(message) && usesActiveTask(contentText(message.content)) && previous >= 0 ? previous : index;
  return entries.slice(start).flatMap(entry => {
    const message = entry.message;
    if (entry.type !== 'message' || !object(message) || !['user', 'assistant'].includes(String(message.role))) return [];
    return [contentText(message.content)];
  }).join('\n');
}

export function lastUserText(entries: readonly ContextEntry[]): string | undefined {
  const entry = entries.findLast(entry => entry.type === 'message' && object(entry.message) && entry.message.role === 'user');
  return object(entry?.message) ? contentText(entry.message.content) || undefined : undefined;
}

export const taskIds = (text: string): string[] => [...new Set(
  [...text.matchAll(/\b[A-Z][A-Z0-9]{1,15}-[A-Z]{0,4}\d+\b/gi)].map(match => match[0].toUpperCase()),
)];

/** Only an empty or generic test request may inherit the active task. */
export const usesActiveTask = (request?: string): boolean => !request || request.toLowerCase()
  .replace(/[.,!¿?¡]/g, ' ')
  .replace(/\b(?:please|por|favor|realiza|ejecuta|haz|corre|run|perform|execute|do|test|tests|testing|prueba|pruebas|probar|revisa|review|verifica|verify|qa|las|los|la|el|the|all|todo|todas|todos)\b/g, '')
  .trim() === '';

export async function branchTaskIds(cwd: string, run: GitExec = git): Promise<string[]> {
  const branch = await run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch.code !== 0) return [];
  const ids = taskIds(branch.stdout);
  if (ids.length) return ids;
  if (/^(main|master|develop)\s*$/.test(branch.stdout)) return [];
  const commit = await run(cwd, ['log', '-1', '--format=%s']);
  return commit.code === 0 ? taskIds(commit.stdout) : [];
}
