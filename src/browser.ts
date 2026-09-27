import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { browserExecutable } from './browser-executable.ts';
import { pageScope, textResult, type BrowserKit, type BrowserResult, type Scope } from './browser-kit.ts';
import { createMcpAppHost } from './mcp-app.ts';
import type { ExecutionReceipt, QaArtifact } from './schema.ts';
import { clip, plain, sha256Hex } from './text.ts';
import { callWebMcpTool, listWebMcpTools, WEBMCP_ARGS } from './webmcp.ts';

export { browserExecutable } from './browser-executable.ts';
export { schemaProblems, WEBMCP_ARGS, type WebMcpTool } from './webmcp.ts';

const ACTIONS = ['open', 'snapshot', 'click', 'fill', 'press', 'screenshot', 'tools', 'call_tool', 'app_connect', 'app_tools', 'app_open', 'app_log', 'close'] as const;

const BrowserActionSchema = Type.Object({
  action: Type.Union(ACTIONS.map(action => Type.Literal(action))),
  url: Type.Optional(Type.String({ maxLength: 4096, description: 'Page URL for open, or a streamable HTTP MCP server URL for app_connect.' })),
  selector: Type.Optional(Type.String({ maxLength: 2048 })),
  value: Type.Optional(Type.String({ maxLength: 4096 })),
  key: Type.Optional(Type.String({ maxLength: 64 })),
  name: Type.Optional(Type.String({ maxLength: 128, description: 'Screenshot name, the WebMCP tool for call_tool, or the MCP tool for app_open.' })),
  input: Type.Optional(Type.String({ maxLength: 16_384, description: 'Tool input for call_tool and app_open, as JSON object text, e.g. {"sku":"A1"}. Defaults to {}.' })),
  command: Type.Optional(Type.String({ maxLength: 1024, description: 'app_connect: executable of a stdio MCP server, run in the QA workspace.' })),
  args: Type.Optional(Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 32, description: 'app_connect: arguments for command.' })),
});

type BrowserAction = {
  action: (typeof ACTIONS)[number];
  url?: string;
  selector?: string;
  value?: string;
  key?: string;
  name?: string;
  input?: string;
  command?: string;
  args?: string[];
};

export type QaBrowserSession = {
  tool: {
    name: string;
    label: string;
    description: string;
    parameters: typeof BrowserActionSchema;
    execute: (id: string, params: BrowserAction) => Promise<BrowserResult>;
  };
  artifacts: QaArtifact[];
  receipts: ExecutionReceipt[];
  close: () => Promise<void>;
};

const DESCRIPTION = [
  'Stateful Playwright browser for QA evidence. Open a URL, inspect textual DOM state, interact, and capture screenshot/trace artifacts. Screenshots are evidence only when paired with a textual observation.',
  'WebMCP: `tools` lists the typed tools the open page registers (document.modelContext); `call_tool` runs one by `name` with `input` as JSON object text and reports its output, whether it threw, how the input compares to its schema, and the page afterwards.',
  'MCP Apps: `app_connect` starts a stdio MCP server (`command`, `args`, run in the QA workspace) or connects to `url`; `app_tools` lists its tools and their `ui://` resources; `app_open` calls a tool by `name` with `input` and renders its UI like Claude or ChatGPT would, after which click, fill, press, snapshot and screenshot act inside the app; `app_log` shows every message between app and host, CSP violations, and console errors.',
].join(' ');

export const createQaBrowser = (artifactDir: string, options: { cwd?: string } = {}): QaBrowserSession => {
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
    if (!executablePath) throw new Error('No supported Chrome/Chromium executable is installed. Install Chrome, or run `npx playwright-core install chromium`, then retry the browser check.');
    const { chromium } = await import('playwright-core');
    await mkdir(artifactDir, { recursive: true, mode: 0o700 });
    state.browser = await chromium.launch({ headless: true, executablePath, args: WEBMCP_ARGS });
    state.context = await state.browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: false });
    await state.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    state.traceStarted = true;
    state.page = await state.context.newPage();
    return state.page;
  };

  const observe = async (scope: Scope): Promise<string> => {
    const body = await scope.root.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
    const controls = await scope.root.locator('a,button,input,select,textarea,[role]').evaluateAll((nodes: Element[]) => nodes.slice(0, 80).map(node => ({
      tag: node.tagName.toLowerCase(),
      role: node.getAttribute('role') ?? undefined,
      name: node.getAttribute('aria-label') ?? (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement ? node.value : node instanceof HTMLElement ? node.innerText : undefined),
      href: node.getAttribute('href') ?? undefined,
      disabled: node.hasAttribute('disabled'),
    }))).catch(() => []);
    return [
      `URL: ${scope.url}`,
      `Title: ${plain(scope.title)}`,
      `Visible text:\n${clip(plain(body), 12_000)}`,
      `Interactive elements:\n${clip(JSON.stringify(controls, null, 2), 8_000)}`,
    ].join('\n');
  };

  const nextPath = (stem: string, extension: string): string => {
    state.sequence += 1;
    return join(artifactDir, `${String(state.sequence).padStart(2, '0')}-${safeName(stem)}.${extension}`);
  };

  const kit: BrowserKit = {
    page: ensurePage,
    observe,
    saveFile: async (stem, extension, data, description, url) => {
      const path = nextPath(stem, extension);
      await mkdir(artifactDir, { recursive: true, mode: 0o700 });
      await writeFile(path, data, { mode: 0o600 });
      const artifact: QaArtifact = { kind: 'file', path, hash: sha256Hex(data), ...(url ? { url } : {}), description };
      artifacts.push(artifact);
      return artifact;
    },
  };
  const apps = createMcpAppHost(kit, options.cwd ?? artifactDir);
  /** Inside the open MCP App, else the page. */
  const scope = async (): Promise<Scope> => apps.scope() ?? pageScope(await ensurePage());

  const screenshot = async (page: Page, requested?: string): Promise<{ artifact: QaArtifact; data: string }> => {
    const path = nextPath(requested ?? 'evidence', 'png');
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
    await apps.close();
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

  /** Actions that return their own observation. */
  const special = async (params: BrowserAction): Promise<BrowserResult | undefined> => {
    if (params.action === 'close') { await close(); return textResult('Browser session closed; trace persisted.', { artifacts }); }
    if (params.action === 'tools') return listWebMcpTools(kit);
    if (params.action === 'call_tool') return callWebMcpTool(kit, required(params.name, 'call_tool requires name (the WebMCP tool name).'), params.input ?? '{}');
    if (params.action === 'app_connect') return apps.connect({ ...(params.command ? { command: params.command, args: params.args ?? [] } : {}), ...(params.url ? { url: params.url } : {}) });
    if (params.action === 'app_tools') return apps.tools();
    if (params.action === 'app_open') return apps.open(required(params.name, 'app_open requires name (the MCP tool whose UI to render).'), params.input ?? '{}');
    if (params.action === 'app_log') return apps.log();
    return undefined;
  };

  const perform = async (params: BrowserAction): Promise<BrowserResult> => {
    const handled = await special(params);
    if (handled) return handled;
    const page = await ensurePage();
    if (params.action === 'open') {
      await apps.detach();
      await page.goto(required(params.url, 'open requires url.'), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } else if (params.action === 'click') {
      await (await scope()).root.locator(required(params.selector, 'click requires selector.')).first().click({ timeout: 10_000 });
    } else if (params.action === 'fill') {
      await (await scope()).root.locator(required(params.selector, 'fill requires selector.')).first().fill(params.value ?? '', { timeout: 10_000 });
    } else if (params.action === 'press') {
      if (!params.key) throw new Error('press requires selector and key.');
      await (await scope()).root.locator(required(params.selector, 'press requires selector and key.')).first().press(params.key, { timeout: 10_000 });
    }
    await page.waitForTimeout(200);
    const observed = await observe(await scope());
    if (params.action !== 'screenshot') return textResult(observed, { url: page.url() });
    const captured = await screenshot(page, params.name);
    return {
      content: [
        { type: 'text', text: `${observed}\nScreenshot: ${captured.artifact.path}\nSHA-256: ${captured.artifact.hash}` },
        { type: 'image', data: captured.data, mimeType: 'image/png' },
      ],
      details: { artifact: captured.artifact },
    };
  };

  const execute = async (toolCallId: string, params: BrowserAction): Promise<BrowserResult> => {
    const id = `browser-${toolCallId}-${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const artifactOffset = artifacts.length;
    const command = JSON.stringify(params);
    try {
      const result = await perform(params);
      const output = result.content.map(item => item.type === 'text' ? item.text : '').join('\n');
      const artifactHashes = artifacts.slice(artifactOffset).map(artifact => artifact.hash);
      receipts.push(browserReceipt({ id, command, cwd: artifactDir, startedAt, status: 'completed', exitCode: 0, output, artifactHashes }));
      return { ...result, content: [...result.content, { type: 'text', text: `QA execution receipt: ${id}` }] };
    } catch (error) {
      const output = error instanceof Error ? error.message : String(error);
      receipts.push(browserReceipt({ id, command, cwd: artifactDir, startedAt, status: 'failed', exitCode: 1, output, artifactHashes: artifacts.slice(artifactOffset).map(artifact => artifact.hash) }));
      throw new Error(`${output}\nQA execution receipt: ${id}`);
    }
  };

  return {
    tool: { name: 'qa_browser', label: 'QA browser', description: DESCRIPTION, parameters: BrowserActionSchema, execute },
    artifacts,
    receipts,
    close,
  };
};

const required = (value: string | undefined, message: string): string => {
  if (!value) throw new Error(message);
  return value;
};

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

const safeName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'evidence';
