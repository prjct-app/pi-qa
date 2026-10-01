import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export type ParsedArgs = { action: 'run' | 'status' | 'cancel' | 'setup' | 'evaluate'; base?: string; target?: string; runId?: string; request?: string };

export const parseArgs = (args: string): ParsedArgs => {
  const tokens = (args.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(token => token.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2')).filter(Boolean);
  const exact = tokens.join(' ');
  if (exact === 'status' || exact === 'cancel' || exact === 'setup') return { action: exact };
  if (tokens[0] === 'evaluate' && (tokens.length === 1 || (tokens.length === 2 && UUID.test(tokens[1] ?? '')))) {
    return { action: 'evaluate', runId: tokens[1] };
  }
  const collected = tokens.reduce<{ values: string[]; base?: string; target?: string; skip: boolean }>((acc, token, index, all) => {
    if (acc.skip) return { ...acc, skip: false };
    if (token === '--base' && all[index + 1]) return { ...acc, base: all[index + 1], skip: true };
    if (token === '--target' && all[index + 1]) return { ...acc, target: all[index + 1], skip: true };
    return { ...acc, values: [...acc.values, token] };
  }, { values: [], skip: false });
  const values = collected.values[0] === 'run' ? collected.values.slice(1) : collected.values;
  return { action: 'run', base: collected.base, target: collected.target, request: values.join(' ').trim() || undefined };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const refersToThisExtension = (request: string): boolean => /(?:\bpi-qa\b|\b(?:esta|this|la)\s+extensi[oó]n\b|\bextension\b|\bextensi[oó]n\b)/i.test(request);

export const findSelfTarget = async (cwd: string): Promise<string | undefined> => {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [...new Set([join(cwd, 'pi-qa'), cwd, dirname(moduleDir), moduleDir])];
  const matched = await Promise.all(candidates.map(async candidate => {
    try {
      const manifest: unknown = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'));
      return manifest && typeof manifest === 'object' && 'name' in manifest && manifest.name === '@prjct.app/pi-qa' ? candidate : undefined;
    } catch {
      return undefined;
    }
  }));
  return matched.find(Boolean);
};
