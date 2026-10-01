import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fingerprintText, type IntentContext } from './contract.ts';
import { taskIds } from './task-context.ts';

const MAX_BYTES = 256_000;
const MAX_FILES = 1_000;

/** Resolve only a named document/ID, never an ambient .pi/ticket.md. */
export async function loadTicket(cwd: string, reference: string): Promise<IntentContext['ticket']> {
  const paths = markdownPaths(reference);
  const ids = taskIds(reference);
  const numbers = [...new Set([...reference.matchAll(/\b(?:ticket|issue|tarea)\s*#?(\d+)\b/gi)].map(match => match[1]!))];
  if (!paths.length && !ids.length && !numbers.length) return undefined;
  if (paths.length > 1 || (!paths.length && ids.length + numbers.length > 1)) {
    throw new Error('Multiple QA tasks named. Specify one ticket ID or Markdown path.');
  }
  const root = await realpath(cwd);
  const requested = paths[0] ?? await findTicket(root, ids[0] ?? numbers[0]!);
  if (!requested) throw new Error(`No unique ticket ${ids[0] ?? numbers[0]} found in local project docs. Specify its Markdown path.`);
  const text = await readTicketSource(root, requested);
  const sections = splitSections(text);
  return {
    text,
    ac: bullets(sections['acceptance criteria'] ?? sections.ac ?? ''),
    dor: bullets(sections['definition of ready'] ?? sections.dor ?? ''),
    dod: bullets(sections['definition of done'] ?? sections.dod ?? ''),
    ref: relative(root, resolve(root, requested)),
    fingerprint: fingerprintText(text),
  };
}

export const markdownPaths = (text: string): string[] => [...new Set(
  [...text.matchAll(/(?:^|[\s`(\["'])([^\s`\[\]()"'<>]+\.md)(?=$|[\s`\])"'.,;])/gi)]
    .map(match => match[1]!).filter(path => !path.includes('://')),
)];

/** Shared by capture and staleness checks, including sibling docs repositories. */
export async function readTicketSource(cwd: string, reference: string): Promise<string> {
  const root = await realpath(cwd);
  const path = resolve(root, reference);
  if (!path.endsWith('.md') || path.split('/').includes('.pi')) throw new Error('QA tickets must be Markdown documents outside .pi.');
  const info = await lstat(path);
  if (!info.isFile() || info.size > MAX_BYTES || await realpath(path) !== path) {
    throw new Error(`Ticket must be a regular file under 256 KB without symbolic links: ${reference}`);
  }
  return readFile(path, 'utf8');
}

async function findTicket(cwd: string, id: string): Promise<string | undefined> {
  const roots = [...new Set([join(cwd, 'docs'), join(dirname(cwd), 'docs'), join(cwd, 'project'), join(cwd, 'tickets')])];
  const budget = { files: 0 };
  const files = [...new Set((await Promise.all(roots.map(root => markdownFiles(root, 0, budget)))).flat())];
  const matches = files.filter(path => {
    const name = basename(path, '.md');
    return /^\d+$/.test(id) ? name.match(/^\d+/)?.[0] === id
      : name.toUpperCase() === id || name.toUpperCase().startsWith(`${id}-`) || name.toUpperCase().startsWith(`${id}.`);
  });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Multiple documents match ${id}. Specify its Markdown path.`);
  // Some repositories name files by title and keep the authoritative ID in frontmatter.
  const byId = (await Promise.all(files.map(async path => {
    const text = await readTicketSource(cwd, path).catch(() => '');
    const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1] ?? '';
    const declared = /^id:\s*["']?([^\s"']+)["']?\s*$/m.exec(header)?.[1];
    return declared?.toUpperCase() === id.toUpperCase() ? path : undefined;
  }))).filter((path): path is string => Boolean(path));
  if (byId.length > 1) throw new Error(`Multiple documents declare ${id}. Specify its Markdown path.`);
  return byId[0];
}

async function markdownFiles(root: string, depth: number, budget: { files: number }): Promise<string[]> {
  if (depth > 6 || budget.files >= MAX_FILES) return [];
  const info = await lstat(root).catch(() => undefined);
  if (!info?.isDirectory()) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    if (budget.files >= MAX_FILES) throw new Error('QA ticket discovery exceeded 1,000 files. Specify the ticket path.');
    if (entry.name.startsWith('.') || ['node_modules', 'vendor', 'qa-results'].includes(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await markdownFiles(path, depth + 1, budget));
    else if (entry.isFile() && entry.name.endsWith('.md')) {
      budget.files += 1;
      result.push(path);
    }
  }
  return result;
}

const splitSections = (text: string): Record<string, string> =>
  text.split(/^#{1,3}\s+/m).reduce<Record<string, string>>((sections, block) => {
    const nl = block.indexOf('\n');
    if (nl >= 0) sections[block.slice(0, nl).trim().toLowerCase()] = block.slice(nl + 1);
    return sections;
  }, {});

const bullets = (text: string): string[] => text.split('\n')
  .map(line => line.replace(/^\s*[-*]\s+(?:\[[ xX]\]\s*)?/, '').trim())
  .filter(line => line.length > 0 && !line.startsWith('#'));
