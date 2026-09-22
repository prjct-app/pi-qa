import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import type { ExecutionReceipt, QaArtifact } from './schema.ts';
import { clip, plain, sha256Hex } from './text.ts';

const BrowserActionSchema = Type.Object({
  action: Type.Union([
    Type.Literal('open'), Type.Literal('snapshot'), Type.Literal('click'), Type.Literal('fill'),
    Type.Literal('press'), Type.Literal('screenshot'), Type.Literal('close'),
  ]),
  url: Type.Optional(Type.String({ maxLength: 4096 })),
  selector: Type.Optional(Type.String({ maxLength: 2048 })),
  value: Type.Optional(Type.String({ maxLength: 4096 })),
  key: Type.Optional(Type.String({ maxLength: 64 })),
  name: Type.Optional(Type.String({ maxLength: 128 })),
});

type BrowserAction = {
  action: 'open' | 'snapshot' | 'click' | 'fill' | 'press' | 'screenshot' | 'close';
  url?: string;
  selector?: string;
  value?: string;
  key?: string;
  name?: string;
};

export type QaBrowserSession = {
  tool: {
    name: string;
    label: string;
    description: string;
    parameters: typeof BrowserActionSchema;
    execute: (id: string, params: BrowserAction) => Promise<{ content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>; details: Record<string, unknown> }>;
  };
  artifacts: QaArtifact[];
  receipts: ExecutionReceipt[];
  close: () => Promise<void>;
};

export const createQaBrowser = (artifactDir: string): QaBrowserSession => {
  const state: { browser?: Browser; context?: BrowserContext; page?: Page; traceStarted: boolean; closed: boolean; sequence: number } = {
    traceStarted: false,
    closed: false,
    sequence: 0,
  };
  const artifacts: QaArtifact[] = [];
  const receipts: ExecutionReceipt[] = [];

  const ensurePage = async (): Promise<Page> => {
    if (state.page) return state.page;
    const executablePath = await browserExecutable();
    if (!executablePath) throw new Error('No supported Chrome/Chromium executable is installed. Install Chrome or Chromium, then retry the browser check.');
    const { chromium } = await import('playwright-core');
    await mkdir(artifactDir, { recursive: true, mode: 0o700 });
    state.browser = await chromium.launch({ headless: true, executablePath });
    state.context = await state.browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: false });
    await state.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    state.traceStarted = true;
    state.page = await state.context.newPage();
    return state.page;
  };

  const observation = async (page: Page): Promise<string> => {
    const title = await page.title().catch(() => '');
    const body = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
    const controls = await page.locator('a,button,input,select,textarea,[role]').evaluateAll((nodes: any[]) => nodes.slice(0, 80).map((node: any) => ({
      tag: String(node.tagName ?? '').toLowerCase(),
      role: node.getAttribute?.('role') ?? undefined,
      name: node.getAttribute?.('aria-label') ?? node.innerText ?? node.value ?? undefined,
      href: node.getAttribute?.('href') ?? undefined,
      disabled: Boolean(node.disabled),
    }))).catch(() => []);
    return [
      `URL: ${page.url()}`,
      `Title: ${plain(title)}`,
      `Visible text:\n${clip(plain(body), 12_000)}`,
      `Interactive elements:\n${clip(JSON.stringify(controls, null, 2), 8_000)}`,
    ].join('\n');
  };

  const screenshot = async (page: Page, requested?: string): Promise<{ artifact: QaArtifact; data: string }> => {
    state.sequence += 1;
    const name = `${String(state.sequence).padStart(2, '0')}-${safeName(requested ?? 'evidence')}.png`;
    const path = join(artifactDir, name);
    await page.screenshot({ path, fullPage: true, type: 'png' });
    const data = await readFile(path);
    const artifact: QaArtifact = {
      kind: 'screenshot', path, hash: sha256Hex(data), url: page.url(),
      description: `Full-page browser evidence captured after ${requested ?? 'inspection'}.`,
    };
    artifacts.push(artifact);
    return { artifact, data: data.toString('base64') };
  };

  const close = async (): Promise<void> => {
    if (state.closed) return;
    state.closed = true;
    if (state.context && state.traceStarted) {
      const path = join(artifactDir, 'trace.zip');
      await state.context.tracing.stop({ path }).then(async () => {
        const data = await readFile(path);
        artifacts.push({ kind: 'trace', path, hash: sha256Hex(data), description: 'Playwright trace with DOM snapshots and browser screenshots.' });
      }).catch(() => undefined);
    }
    await state.context?.close().catch(() => undefined);
    await state.browser?.close().catch(() => undefined);
    state.page = undefined;
    state.context = undefined;
    state.browser = undefined;
  };

  const perform = async (_id: string, params: BrowserAction) => {
    if (params.action === 'close') {
      await close();
      return textResult('Browser session closed; trace persisted.', { artifacts });
    }
    const page = await ensurePage();
    if (params.action === 'open') {
      if (!params.url) throw new Error('open requires url.');
      await page.goto(params.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } else if (params.action === 'click') {
      if (!params.selector) throw new Error('click requires selector.');
      await page.locator(params.selector).first().click({ timeout: 10_000 });
    } else if (params.action === 'fill') {
      if (!params.selector) throw new Error('fill requires selector.');
      await page.locator(params.selector).first().fill(params.value ?? '', { timeout: 10_000 });
    } else if (params.action === 'press') {
      if (!params.selector || !params.key) throw new Error('press requires selector and key.');
      await page.locator(params.selector).first().press(params.key, { timeout: 10_000 });
    }
    await page.waitForTimeout(200);
    const observed = await observation(page);
    if (params.action !== 'screenshot') return textResult(observed, { url: page.url() });
    const captured = await screenshot(page, params.name);
    return {
      content: [
        { type: 'text' as const, text: `${observed}\nScreenshot: ${captured.artifact.path}\nSHA-256: ${captured.artifact.hash}` },
        { type: 'image' as const, data: captured.data, mimeType: 'image/png' },
      ],
      details: { artifact: captured.artifact },
    };
  };

  const execute = async (toolCallId: string, params: BrowserAction) => {
    const id = `browser-${toolCallId}-${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const artifactOffset = artifacts.length;
    const command = JSON.stringify(params);
    try {
      const result = await perform(toolCallId, params);
      const output = result.content.map(item => item.type === 'text' ? item.text : '').join('\n');
      const artifactHashes = artifacts.slice(artifactOffset).map(artifact => artifact.hash);
      receipts.push(browserReceipt({ id, command, cwd: artifactDir, startedAt, status: 'completed', exitCode: 0, output, artifactHashes }));
      return { ...result, content: [...result.content, { type: 'text' as const, text: `QA execution receipt: ${id}` }] };
    } catch (error) {
      const output = error instanceof Error ? error.message : String(error);
      receipts.push(browserReceipt({ id, command, cwd: artifactDir, startedAt, status: 'failed', exitCode: 1, output, artifactHashes: artifacts.slice(artifactOffset).map(artifact => artifact.hash) }));
      throw new Error(`${output}\nQA execution receipt: ${id}`);
    }
  };

  return {
    tool: {
      name: 'qa_browser',
      label: 'QA browser',
      description: 'Stateful Playwright browser for QA evidence. Open a URL, inspect textual DOM state, interact, and capture screenshot/trace artifacts. Screenshots are evidence only when paired with a textual observation.',
      parameters: BrowserActionSchema,
      execute,
    },
    artifacts,
    receipts,
    close,
  };
};

const textResult = (text: string, details: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text }], details });

const browserReceipt = (input: { id: string; command: string; cwd: string; startedAt: string; status: ExecutionReceipt['status']; exitCode: number; output: string; artifactHashes: string[] }): ExecutionReceipt => ({
  id: input.id,
  tool: 'qa_browser',
  command: input.command,
  cwd: input.cwd,
  startedAt: input.startedAt,
  finishedAt: new Date().toISOString(),
  status: input.status,
  exitCode: input.exitCode,
  outputHash: sha256Hex(input.output),
  outputExcerpt: clip(plain(input.output), 4_000),
  artifactHashes: input.artifactHashes,
});

const browserExecutable = async (): Promise<string | undefined> => {
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : process.platform === 'win32'
      ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  const found = await Promise.all(candidates.map(async path => {
    try { await access(path); return path; } catch { return undefined; }
  }));
  return found.find(Boolean);
};

const safeName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'evidence';
