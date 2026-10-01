import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentOutcome, DeterministicCheck, QaSurface, Snapshot, TestRecord, TesterReport } from './schema.ts';
import { testHasVerifiedExecution } from './evidence.ts';

const WEB = ['next', 'react-dom', 'vue', 'nuxt', 'svelte', '@sveltejs/kit', '@angular/core', 'astro', 'preact', 'solid-js'];
const API = ['express', 'fastify', '@nestjs/core', 'koa', '@hapi/hapi'];

export async function qaSurface(cwd: string, mission: string, paths: Snapshot['paths']): Promise<QaSurface> {
  const manifest: unknown = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8').catch(() => '{}'));
  const dependencies = object(manifest) && object(manifest.dependencies) ? Object.keys(manifest.dependencies) : [];
  if (dependencies.some(name => WEB.includes(name)) || paths.some(path => /\.(html|vue|svelte)$/.test(path.path))) return 'browser';
  const python = (await Promise.all(['pyproject.toml', 'requirements.txt'].map(name => readFile(join(cwd, name), 'utf8').catch(() => '')))).join('\n');
  if (dependencies.some(name => API.includes(name)) || /\b(fastapi|django|flask)\b/i.test(python) || /\b(api|endpoints?)\b/i.test(mission)) return 'api';
  if (/https?:\/\//i.test(mission)) return 'browser';
  return 'command';
}

export const behavioralTest = (test: TestRecord): boolean =>
  !['unit', 'static', 'build'].includes(test.kind ?? 'other');

/** A green developer check cannot replace using the application's public surface. */
export function behaviorGap(snapshot: Snapshot | undefined, tester: AgentOutcome, report: TesterReport, checks: DeterministicCheck[]): string | undefined {
  if (!snapshot?.qaSurface) return undefined;
  const tests = report.tests.filter(test => !test.skipped && behavioralTest(test) && testHasVerifiedExecution(test, checks));
  if (snapshot.qaSurface === 'browser') {
    const observed = tests.some(test => (test.executionIds ?? []).some(id => {
      const receipt = tester.executions?.find(entry => entry.id === id);
      if (!receipt || receipt.tool !== 'qa_browser' || receipt.status !== 'completed' || !receipt.outputExcerpt.trim()) return false;
      const command: unknown = parse(receipt.command);
      return object(command) && ['open', 'click', 'fill', 'press', 'snapshot', 'call_tool', 'app_open'].includes(String(command.action));
    }));
    return observed ? undefined : 'The web application was not exercised in the browser. Code inspection, unit tests, lint and builds are supporting evidence only.';
  }
  if (snapshot.qaSurface === 'api' && !tests.some(test => ['api', 'integration', 'e2e', 'security'].includes(test.kind ?? '')
    && (test.executionIds ?? []).some(id => {
      const receipt = tester.executions?.find(entry => entry.id === id);
      return receipt?.tool === 'bash' && receipt.status === 'completed' && receipt.outputExcerpt.trim()
        && /\b(?:curl|wget|http|httpie)\s|\bfetch\s*\(|\brequests\.(?:get|post|put|patch|delete|request)\s*\(/.test(receipt.command);
    }))) {
    return 'The backend endpoints were not exercised. Start the service, send real requests and run relevant regression scenarios; code inspection alone is not QA.';
  }
  return tests.length ? undefined : 'The application was not exercised through its public interface. Developer checks alone are not behavioral QA.';
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
const parse = (text: string): unknown => { try { return JSON.parse(text); } catch { return undefined; } };
