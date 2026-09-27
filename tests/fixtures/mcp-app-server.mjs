// A stdio MCP server with one MCP App (a counter), for qa_browser's MCP App host tests.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';

const require = createRequire(import.meta.url);
// The App SDK as one classic script: its trailing `export { a as B }` becomes `window.McpApps = { B: a }`.
const sdk = readFileSync(require.resolve('@modelcontextprotocol/ext-apps/app-with-deps'), 'utf8')
  .replace(/export\s*\{([^}]*)\};?\s*$/, (_, list) => `window.McpApps={${list.split(',').map(entry => {
    const [local, exported] = entry.trim().split(/\s+as\s+/);
    return `${exported ?? local}:${local}`;
  }).join(',')}};`);

const html = `<!doctype html><html><head><title>Counter</title></head><body>
<h1>Counter</h1><p id="value">…</p>
<button id="inc">Increment</button><button id="tell">Tell chat</button><button id="fetch">Fetch outside</button>
<script>${sdk}</script>
<script>
const app = new window.McpApps.App({ name: 'counter', version: '1.0.0' });
const value = document.getElementById('value');
const show = result => { value.textContent = result.content?.[0]?.text ?? '?'; };
app.ontoolresult = show;
document.getElementById('inc').onclick = async () => show(await app.callServerTool({ name: 'increment', arguments: {} }));
document.getElementById('tell').onclick = () => app.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Counter is ' + value.textContent }] });
document.getElementById('fetch').onclick = () => fetch('https://example.com/data').catch(() => undefined);
app.connect();
</script></body></html>`;

const server = new McpServer({ name: 'counter-fixture', version: '1.0.0' });
const state = { count: 0 };
const text = value => ({ content: [{ type: 'text', text: String(value) }] });
const APP = 'ui://counter/app.html';

registerAppTool(server, 'show_counter', { description: 'Show the counter.', inputSchema: { start: z.number().optional() }, _meta: { ui: { resourceUri: APP } } },
  async ({ start }) => { if (start !== undefined) state.count = start; return text(state.count); });
registerAppTool(server, 'increment', { description: 'Add one to the counter.', _meta: { ui: { resourceUri: APP, visibility: ['app'] } } },
  async () => { state.count += 1; return text(state.count); });
server.registerTool('ping', { description: 'Answer pong; no UI.' }, async () => text('pong'));
registerAppResource(server, 'counter', APP, { mimeType: RESOURCE_MIME_TYPE },
  async () => ({ contents: [{ uri: APP, mimeType: RESOURCE_MIME_TYPE, text: html, _meta: { ui: { csp: { connectDomains: [] } } } }] }));

await server.connect(new StdioServerTransport());
