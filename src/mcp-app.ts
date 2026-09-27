import { Client, StreamableHTTPClientTransport, type CallToolResult, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AppBridge, buildAllowAttribute, getToolUiResourceUri, RESOURCE_MIME_TYPE, type McpUiResourceCsp, type McpUiResourcePermissions } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { FrameLocator, Page } from 'playwright-core';
import { parseJsonObject, textResult, type BrowserKit, type BrowserResult, type Scope } from './browser-kit.ts';
import { clip, plain } from './text.ts';
import { toolOutput } from './webmcp.ts';

/**
 * A test host for MCP Apps (the MCP UI extension): pi-qa connects to an MCP
 * server, renders a tool's `ui://` resource in a sandboxed iframe inside the
 * QA browser, and runs the official AppBridge in Node over a transport that
 * crosses into the page. The app sees what Claude or ChatGPT would give it;
 * every message both ways is logged as evidence.
 */
const FRAME = 'mcp-app';
const BINDING = '__qaMcpAppToHost';
const UI_EXTENSION = 'io.modelcontextprotocol/ui';
const SANDBOX = 'allow-scripts allow-forms';
const INIT_TIMEOUT_MS = 10_000;
const HOST = { name: 'pi-qa', version: '1.0.0' };

export type McpAppHost = {
  connect(server: { command?: string; args?: string[]; url?: string }): Promise<BrowserResult>;
  tools(): Promise<BrowserResult>;
  open(name: string, inputText: string): Promise<BrowserResult>;
  log(): BrowserResult;
  /** The app frame while an app is open: interactions and observations act inside it. */
  scope(): Scope | undefined;
  /** Tears the open app down, e.g. before the page navigates elsewhere. */
  detach(): Promise<void>;
  close(): Promise<void>;
};

type Connection = { client: Client; label: string; stderr: string[] };
type OpenApp = { bridge: AppBridge; transport: Transport; tool: string; uri: string; frame: FrameLocator; from: number };

export const createMcpAppHost = (kit: BrowserKit, cwd: string): McpAppHost => {
  const state: { connection?: Connection; open?: OpenApp; wiredPage?: Page; log: string[] } = { log: [] };
  const note = (line: string): void => {
    state.log.push(line);
    if (state.log.length > 500) state.log.splice(0, state.log.length - 500);
  };
  const logFrom = (from: number): string => state.log.slice(from).join('\n') || '(no messages)';
  const stderrTail = (): string => {
    const text = state.connection?.stderr.join('').trim();
    return text ? `Server stderr (tail):\n${clip(text.slice(-4_000), 4_000)}` : '';
  };
  const connected = (): Connection => {
    if (!state.connection) throw new Error('No MCP server connected: run app_connect with command (stdio) or url (streamable HTTP) first.');
    return state.connection;
  };

  /** Once per page: messages from the app frame reach Node, and its errors reach the log. */
  const wire = async (page: Page): Promise<void> => {
    if (state.wiredPage === page) return;
    state.wiredPage = page;
    await page.exposeBinding(BINDING, (_source, message: unknown) => {
      if (isCspViolation(message)) { note(`csp violation: ${message.directive} blocked ${message.blocked || '(inline)'}`); return; }
      if (!isJsonRpc(message)) return;
      note(`app → host ${describe(message)}`);
      state.open?.transport.onmessage?.(message);
    });
    page.on('console', message => { if (state.open && message.type() === 'error') note(`console error: ${clip(plain(message.text()), 300)}`); });
    page.on('pageerror', error => { if (state.open) note(`uncaught error: ${clip(plain(error.message), 300)}`); });
  };

  const pageTransport = (page: Page): Transport => {
    const transport: Transport = {
      start: async () => undefined,
      send: async (message: JSONRPCMessage) => {
        note(`host → app ${describe(message)}`);
        await page.evaluate(([id, payload]) => {
          const frame = document.getElementById(id);
          if (frame instanceof HTMLIFrameElement) frame.contentWindow?.postMessage(payload, '*');
        }, [FRAME, message] as const);
      },
      close: async () => { transport.onclose?.(); },
    };
    return transport;
  };

  const detach = async (): Promise<void> => {
    const open = state.open;
    if (!open) return;
    state.open = undefined;
    await Promise.race([open.bridge.teardownResource({}).catch(() => undefined), delay(1_000)]);
    await open.bridge.close().catch(() => undefined);
  };

  const disconnect = async (): Promise<void> => {
    await detach();
    const connection = state.connection;
    state.connection = undefined;
    await connection?.client.close().catch(() => undefined);
  };

  const connect: McpAppHost['connect'] = async ({ command, args = [], url }) => {
    if (!command === !url) throw new Error('app_connect needs exactly one of command (a stdio MCP server, with args) or url (a streamable HTTP MCP server).');
    await disconnect();
    const stderr: string[] = [];
    const transport = url ? new StreamableHTTPClientTransport(new URL(url)) : new StdioClientTransport({ command: command!, args, cwd, stderr: 'pipe' });
    if (transport instanceof StdioClientTransport) transport.stderr?.on('data', (chunk: Buffer) => { stderr.push(chunk.toString('utf8')); if (stderr.length > 200) stderr.splice(0, stderr.length - 200); });
    const client = new Client(HOST, { capabilities: { extensions: { [UI_EXTENSION]: { mimeTypes: [RESOURCE_MIME_TYPE] } } } });
    const label = url ?? [command, ...args].join(' ');
    state.connection = { client, label, stderr };
    await client.connect(transport).catch(async error => {
      const tail = stderrTail();
      state.connection = undefined;
      throw new Error(`Could not connect to MCP server ${label}: ${error instanceof Error ? error.message : String(error)}${tail ? `\n${tail}` : ''}`);
    });
    const server = client.getServerVersion();
    return textResult([
      `Connected to MCP server ${server?.name ?? 'unknown'} ${server?.version ?? ''} (${label}).`,
      `Capabilities: ${Object.keys(client.getServerCapabilities() ?? {}).join(', ') || 'none'}`,
      'Next: app_tools lists its tools and which ones declare a UI.',
    ].join('\n'), { server: label });
  };

  const tools: McpAppHost['tools'] = async () => {
    const { client, label } = connected();
    const listed = (await client.listTools()).tools.map(tool => ({ name: tool.name, description: tool.description ?? '', ui: uiOf(tool), visibility: visibilityOf(tool) }));
    const artifact = await kit.saveFile('mcp-tools', 'json', JSON.stringify({ server: label, tools: listed }, null, 2), `Tools listed by MCP server ${label}.`);
    const withUi = listed.filter(tool => tool.ui.uri);
    return textResult([
      `MCP server ${label}: ${listed.length} tools, ${withUi.length} with a UI.`,
      ...listed.map(tool => `- ${tool.name}${tool.ui.uri ? ` → ${tool.ui.uri}` : ''}${tool.ui.problem ? ` (invalid UI: ${tool.ui.problem})` : ''}${tool.visibility ? ` [visibility: ${tool.visibility.join(', ')}]` : ''}: ${clip(plain(tool.description), 300)}`),
      `Manifest: ${artifact.path}\nSHA-256: ${artifact.hash}`,
      withUi.length ? 'Next: app_open with name and input renders one of them.' : 'No tool declares _meta.ui.resourceUri, so there is no MCP App to render.',
    ].join('\n'), { artifact });
  };

  const open: McpAppHost['open'] = async (name, inputText) => {
    const { client } = connected();
    const input = parseJsonObject(inputText, 'app_open input');
    const tool = (await client.listTools()).tools.find(candidate => candidate.name === name);
    if (!tool) throw new Error(`MCP server has no tool named ${name}.`);
    const { uri, problem } = uiOf(tool);
    if (!uri) throw new Error(`Tool ${name} declares no UI: ${problem ?? 'no _meta.ui.resourceUri'}.`);
    const contents = (await client.readResource({ uri })).contents;
    const content = contents.find(candidate => candidate.uri === uri) ?? contents[0];
    if (!content) throw new Error(`Resource ${uri} returned no contents.`);
    const html = 'text' in content ? content.text : Buffer.from(content.blob, 'base64').toString('utf8');
    const meta = resourceMeta(content._meta?.ui);
    const policy = contentSecurityPolicy(meta.csp);
    await detach();
    const page = await kit.page();
    await wire(page);
    const artifact = await kit.saveFile('mcp-app', 'html', html, `UI resource ${uri} served for tool ${name}.`, uri);
    const transport = pageTransport(page);
    const bridge = new AppBridge(client, HOST, { openLinks: {}, serverTools: {}, serverResources: {}, logging: {} }, {
      hostContext: { theme: 'light', displayMode: 'inline', availableDisplayModes: ['inline'], toolInfo: { tool } },
    });
    bridge.onmessage = async params => { note(`chat message from app: ${clip(plain(JSON.stringify(params.content)), 400)}`); return {}; };
    bridge.onopenlink = async params => { note(`open link requested: ${params.url} (not opened)`); return {}; };
    bridge.onupdatemodelcontext = async params => { note(`model context update: ${clip(plain(JSON.stringify(params)), 400)}`); return {}; };
    bridge.onrequestdisplaymode = async params => { note(`display mode requested: ${params.mode} (stays inline)`); return { mode: 'inline' }; };
    bridge.onsizechange = params => {
      if (params.height) void page.evaluate(([id, height]) => { const frame = document.getElementById(id); if (frame) frame.style.height = `${height}px`; }, [FRAME, params.height] as const).catch(() => undefined);
    };
    const initialized = new Promise<boolean>(resolve => { bridge.oninitialized = () => resolve(true); });
    const from = state.log.length;
    note(`open ${name} → ${uri}`);
    await bridge.connect(transport);
    state.open = { bridge, transport, tool: name, uri, frame: page.frameLocator(`#${FRAME}`), from };
    const started = Date.now();
    await page.setContent(hostPage(buildAllowAttribute(meta.permissions)));
    await page.evaluate(([id, doc]) => { const frame = document.getElementById(id); if (frame instanceof HTMLIFrameElement) frame.srcdoc = doc; }, [FRAME, instrument(html, policy)] as const);
    if (!await Promise.race([initialized, delay(INIT_TIMEOUT_MS).then(() => false)])) {
      const log = logFrom(from);
      await detach();
      throw new Error(`MCP App ${uri} did not complete ui/initialize within ${INIT_TIMEOUT_MS / 1000}s.\n${log}\n${stderrTail()}`.trim());
    }
    const handshake = Date.now() - started;
    await bridge.sendToolInput({ arguments: input });
    const result: CallToolResult = await client.callTool({ name, arguments: input });
    await bridge.sendToolResult(result);
    await page.waitForTimeout(300);
    return textResult([
      `MCP App: ${name} → ${uri}`,
      `Resource: ${content.mimeType ?? 'no mimeType'}${content.mimeType === RESOURCE_MIME_TYPE ? '' : ` (expected ${RESOURCE_MIME_TYPE})`}, ${html.length} characters`,
      `Sandbox: ${SANDBOX}; CSP: ${policy}`,
      `Handshake: ui/initialize completed in ${handshake} ms`,
      `Tool result${result.isError ? ' (isError)' : ''}: ${clip(plain(toolOutput(result)), 2_000)}`,
      `Resource saved: ${artifact.path}\nSHA-256: ${artifact.hash}`,
      '--- App after tool input and result ---',
      await kit.observe(appScope(state.open)),
      '--- Host log ---',
      logFrom(from),
      'click, fill, press, snapshot and screenshot now act inside this app until the next open or app_open. app_log shows later messages.',
    ].join('\n'), { tool: name, uri, artifact });
  };

  return {
    connect,
    tools,
    open,
    log: () => textResult([
      state.open ? `MCP App ${state.open.tool} → ${state.open.uri}` : 'No MCP App open.',
      logFrom(state.open?.from ?? 0),
      stderrTail(),
    ].filter(Boolean).join('\n'), {}),
    scope: () => state.open ? appScope(state.open) : undefined,
    detach,
    close: disconnect,
  };
};

const appScope = (open: OpenApp): Scope => ({ root: open.frame, url: open.uri, title: `MCP App ${open.tool}` });

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isJsonRpc = (value: unknown): value is JSONRPCMessage => isRecord(value) && value.jsonrpc === '2.0';

const isCspViolation = (value: unknown): value is { __qa: 'csp'; directive: string; blocked: string } =>
  isRecord(value) && value.__qa === 'csp' && typeof value.directive === 'string' && typeof value.blocked === 'string';

/** "tools/call {...}", "result #3 {...}", "error #3: ..." */
const describe = (message: JSONRPCMessage): string => {
  if ('method' in message) return `${message.method}${'params' in message && message.params ? ` ${clip(plain(JSON.stringify(message.params)), 240)}` : ''}`;
  if ('error' in message) return `error #${String(message.id)}: ${plain(message.error.message)}`;
  if ('result' in message) return `result #${String(message.id)} ${clip(plain(JSON.stringify(message.result)), 240)}`;
  return 'message';
};

const uiOf = (tool: Parameters<typeof getToolUiResourceUri>[0]): { uri?: string; problem?: string } => {
  try { return { uri: getToolUiResourceUri(tool) }; }
  catch (error) { return { problem: error instanceof Error ? error.message : String(error) }; }
};

const visibilityOf = (tool: { _meta?: Record<string, unknown> }): string[] | undefined => {
  const ui = tool._meta?.ui;
  const visibility = isRecord(ui) ? ui.visibility : undefined;
  return Array.isArray(visibility) ? visibility.map(String) : undefined;
};

const strings = (value: unknown): string[] | undefined => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;

/** The resource's `_meta.ui`: the CSP and permissions it asks the host for. */
const resourceMeta = (ui: unknown): { csp: McpUiResourceCsp; permissions: McpUiResourcePermissions } => {
  const csp = isRecord(ui) && isRecord(ui.csp) ? ui.csp : {};
  const permissions = isRecord(ui) && isRecord(ui.permissions) ? ui.permissions : {};
  const granted = (key: keyof McpUiResourcePermissions) => isRecord(permissions[key]) ? { [key]: {} } : {};
  return {
    csp: {
      ...(strings(csp.connectDomains) ? { connectDomains: strings(csp.connectDomains) } : {}),
      ...(strings(csp.resourceDomains) ? { resourceDomains: strings(csp.resourceDomains) } : {}),
      ...(strings(csp.frameDomains) ? { frameDomains: strings(csp.frameDomains) } : {}),
      ...(strings(csp.baseUriDomains) ? { baseUriDomains: strings(csp.baseUriDomains) } : {}),
    },
    permissions: { ...granted('camera'), ...granted('microphone'), ...granted('geolocation'), ...granted('clipboardWrite') },
  };
};

/** The CSP a spec-following host applies: nothing outside what the resource declared. */
export const contentSecurityPolicy = (csp: McpUiResourceCsp): string => {
  const list = (domains: string[] | undefined, fallback: string): string => domains?.length ? domains.join(' ') : fallback;
  const resources = (csp.resourceDomains ?? []).join(' ');
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${resources}`.trim(),
    `style-src 'unsafe-inline' ${resources}`.trim(),
    `img-src data: blob: ${resources}`.trim(),
    `font-src data: ${resources}`.trim(),
    `media-src data: blob: ${resources}`.trim(),
    `connect-src ${list(csp.connectDomains, "'none'")}`,
    `frame-src ${list(csp.frameDomains, "'none'")}`,
    `base-uri ${list(csp.baseUriDomains, "'self'")}`,
  ].join('; ');
};

/** The app document with the host's CSP and a CSP-violation reporter at the top of its head. */
const instrument = (html: string, policy: string): string => {
  const head = `<meta http-equiv="Content-Security-Policy" content="${policy}"><script>document.addEventListener('securitypolicyviolation',function(e){parent.postMessage({__qa:'csp',directive:e.violatedDirective,blocked:e.blockedURI||''},'*')})</script>`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, tag => `${tag}${head}`) : `${head}${html}`;
};

const attribute = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

const hostPage = (allow: string): string => `<!doctype html><html><head><title>MCP App host (pi-qa)</title></head><body style="margin:0">
<iframe id="${FRAME}" sandbox="${SANDBOX}"${allow ? ` allow="${attribute(allow)}"` : ''} style="width:100%;height:600px;border:0"></iframe>
<script>window.addEventListener('message', function (event) { var frame = document.getElementById('${FRAME}'); if (frame && event.source === frame.contentWindow) window.${BINDING}(event.data); });</script>
</body></html>`;
