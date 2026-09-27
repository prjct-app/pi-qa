import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { browserExecutable, createQaBrowser, schemaProblems } from '../src/browser.ts';

test('qa_browser captures textual and visual Playwright evidence', async context => {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor >= 26) { context.skip('Playwright browser smoke is isolated from Node 26 runtimes that can terminate natively.'); return; }
  if (!await browserExecutable()) { context.skip('No Chrome, Chromium, or Playwright Chromium on this runner.'); return; }
  const dir = await mkdtemp(join(tmpdir(), 'qa-browser-')); 
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>QA fixture</title><button id="go" onclick="document.querySelector(\'#result\').textContent=\'saved\'">Save</button><p id="result">idle</p>');
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    if (/EPERM|EACCES|operation not permitted|permission denied/i.test(String(error))) {
      context.skip('This sandbox does not allow a loopback browser fixture.');
      return;
    }
    throw error;
  }
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const browser = createQaBrowser(dir);
  try {
    const opened = await browser.tool.execute('1', { action: 'open', url: `http://127.0.0.1:${address.port}` });
    assert.match((opened.content[0] as { text: string }).text, /QA fixture/);
    const clicked = await browser.tool.execute('2', { action: 'click', selector: '#go' });
    assert.match((clicked.content[0] as { text: string }).text, /saved/);
    const captured = await browser.tool.execute('3', { action: 'screenshot', name: 'saved-state' });
    assert.equal(captured.content[1]?.type, 'image');
    assert.ok(browser.artifacts.some(artifact => artifact.kind === 'screenshot'));
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  try {
    const screenshot = browser.artifacts.find(artifact => artifact.kind === 'screenshot');
    const trace = browser.artifacts.find(artifact => artifact.kind === 'trace');
    assert.ok(screenshot && trace);
    assert.deepEqual([...await readFile(screenshot.path)].slice(0, 8), [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok((await readFile(trace.path)).length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('browserExecutable falls back to a cached Playwright Chromium', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qa-pw-cache-'));
  const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const binary = process.platform === 'darwin'
    ? join(root, 'chromium-1234', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
    : process.platform === 'win32'
      ? join(root, 'chromium-1234', 'chrome-win64', 'chrome.exe')
      : join(root, 'chromium-1234', 'chrome-linux64', 'chrome');
  try {
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, '');
    await mkdir(join(root, 'chromium-999'), { recursive: true });
    process.env.PLAYWRIGHT_BROWSERS_PATH = root;
    const found = await browserExecutable();
    assert.ok(found, 'expected some browser to be found');
    assert.ok(!found.startsWith(root) || found === binary);
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});

const WEBMCP_PAGE = `<!doctype html><title>Shop</title><p id="count">0</p><script>
const count = document.getElementById('count');
document.modelContext?.registerTool({
  name: 'add_to_cart', description: 'Add one item to the cart by SKU.',
  inputSchema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'], additionalProperties: false },
  execute: async ({ sku }) => {
    if (!sku) throw new Error('sku is required');
    count.textContent = String(Number(count.textContent) + 1);
    return { content: [{ type: 'text', text: 'added ' + sku }] };
  },
});
document.modelContext?.registerTool({
  name: 'cart_count', description: 'How many items are in the cart.', annotations: { readOnlyHint: true },
  execute: async () => ({ content: [{ type: 'text', text: count.textContent }] }),
});
</script>`;

test('qa_browser lists and calls WebMCP tools, with receipts and page evidence', async context => {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor >= 26) { context.skip('Playwright browser smoke is isolated from Node 26 runtimes that can terminate natively.'); return; }
  if (!await browserExecutable()) { context.skip('No Chrome, Chromium, or Playwright Chromium on this runner.'); return; }
  const dir = await mkdtemp(join(tmpdir(), 'qa-webmcp-'));
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/plain' ? '<!doctype html><title>Plain</title><p>no tools</p>' : WEBMCP_PAGE);
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    if (/EPERM|EACCES|operation not permitted|permission denied/i.test(String(error))) { context.skip('This sandbox does not allow a loopback browser fixture.'); return; }
    throw error;
  }
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const browser = createQaBrowser(dir);
  const text = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;
  try {
    await browser.tool.execute('1', { action: 'open', url: base });
    const listed = text(await browser.tool.execute('2', { action: 'tools' }));
    if (/exposes no document.modelContext/.test(listed)) { context.skip('This Chrome has no WebMCP (needs Chrome 149+).'); return; }
    assert.match(listed, /WebMCP tools \(2\)/);
    assert.match(listed, /- add_to_cart: Add one item/);
    assert.match(listed, /- cart_count \[readOnly\]: How many/);
    assert.ok(browser.artifacts.some(artifact => artifact.kind === 'file' && /webmcp-tools\.json$/.test(artifact.path)), 'the manifest is evidence');

    const added = text(await browser.tool.execute('3', { action: 'call_tool', name: 'add_to_cart', input: '{"sku":"A1"}' }));
    assert.match(added, /Result: returned/);
    assert.match(added, /Output: added A1/);
    assert.match(added, /Input vs schema: conforms/);
    assert.match(added, /Page text changed: yes/);
    assert.match(added, /Visible text:\n1/);

    const counted = text(await browser.tool.execute('4', { action: 'call_tool', name: 'cart_count' }));
    assert.match(counted, /Output: 1/);
    assert.match(counted, /Page text changed: no/);

    // A negative case: the tool throws, which is evidence, not a qa_browser failure.
    const rejected = text(await browser.tool.execute('5', { action: 'call_tool', name: 'add_to_cart', input: '{}' }));
    assert.match(rejected, /Input vs schema: missing required "sku"/);
    assert.match(rejected, /Result: threw/);
    // Chrome reports that the tool threw, not the page's own message.
    assert.match(rejected, /Output: UnknownError: Tool was executed but the invocation failed/);

    await assert.rejects(browser.tool.execute('6', { action: 'call_tool', name: 'checkout' }), /registers no tool named checkout\. Registered: add_to_cart, cart_count/);
    await assert.rejects(browser.tool.execute('7', { action: 'call_tool', name: 'add_to_cart', input: 'sku=A1' }), /not valid JSON/);
    assert.deepEqual(browser.receipts.map(receipt => receipt.status), ['completed', 'completed', 'completed', 'completed', 'completed', 'failed', 'failed']);

    await browser.tool.execute('8', { action: 'open', url: `${base}/plain` });
    assert.match(text(await browser.tool.execute('9', { action: 'tools' })), /WebMCP tools \(0\):\n\(none registered: drive this page with open, click, fill and press\)/);
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('schemaProblems reports missing, unknown and mistyped top-level input', () => {
  const schema = { type: 'object', properties: { sku: { type: 'string' }, qty: { type: 'integer' } }, required: ['sku'], additionalProperties: false };
  assert.deepEqual(schemaProblems(schema, { sku: 'A1', qty: 2 }), []);
  assert.deepEqual(schemaProblems(schema, { qty: 1.5, color: 'red' }), ['missing required "sku"', 'unknown property "color"', '"qty" is not integer']);
  assert.deepEqual(schemaProblems(undefined, { anything: true }), []);
});

test('qa_browser hosts an MCP App: renders its UI, relays app calls, and logs every message', async context => {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor >= 26) { context.skip('Playwright browser smoke is isolated from Node 26 runtimes that can terminate natively.'); return; }
  if (!await browserExecutable()) { context.skip('No Chrome, Chromium, or Playwright Chromium on this runner.'); return; }
  const dir = await mkdtemp(join(tmpdir(), 'qa-mcp-app-'));
  const browser = createQaBrowser(dir, { cwd: dir });
  const text = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;
  const server = join(import.meta.dirname, 'fixtures', 'mcp-app-server.mjs');
  try {
    await assert.rejects(browser.tool.execute('0', { action: 'app_tools' }), /No MCP server connected/);
    assert.match(text(await browser.tool.execute('1', { action: 'app_connect', command: process.execPath, args: [server] })), /Connected to MCP server counter-fixture 1\.0\.0/);

    const tools = text(await browser.tool.execute('2', { action: 'app_tools' }));
    assert.match(tools, /3 tools, 2 with a UI/);
    assert.match(tools, /- show_counter → ui:\/\/counter\/app\.html: Show the counter/);
    assert.match(tools, /- increment → ui:\/\/counter\/app\.html \[visibility: app\]/);
    assert.match(tools, /- ping: Answer pong/);

    const opened = text(await browser.tool.execute('3', { action: 'app_open', name: 'show_counter', input: '{"start":5}' }));
    assert.match(opened, /Resource: text\/html;profile=mcp-app, \d+ characters/);
    assert.match(opened, /Handshake: ui\/initialize completed in \d+ ms/);
    assert.match(opened, /Tool result: 5/);
    assert.match(opened, /URL: ui:\/\/counter\/app\.html\nTitle: MCP App show_counter\nVisible text:\nCounter\n+5\n/, 'the app shows the tool result');
    assert.match(opened, /app → host ui\/initialize/);
    assert.match(opened, /host → app ui\/notifications\/tool-input \{"arguments":\{"start":5\}\}/);
    assert.match(opened, /host → app ui\/notifications\/tool-result/);
    assert.ok(browser.artifacts.some(artifact => /mcp-app\.html$/.test(artifact.path)), 'the served UI is evidence');

    // Interactions act inside the app frame.
    assert.match(text(await browser.tool.execute('4', { action: 'click', selector: '#inc' })), /Visible text:\nCounter\n+6\n/);
    await browser.tool.execute('5', { action: 'click', selector: '#tell' });
    await browser.tool.execute('6', { action: 'click', selector: '#fetch' });
    const log = text(await browser.tool.execute('7', { action: 'app_log' }));
    assert.match(log, /app → host tools\/call \{"name":"increment"/);
    assert.match(log, /chat message from app: \[\{"type":"text","text":"Counter is 6"\}\]/);
    assert.match(log, /csp violation: connect-src blocked https:\/\/example\.com/);
    const shot = await browser.tool.execute('8', { action: 'screenshot', name: 'counter' });
    assert.equal(shot.content[1]?.type, 'image');

    await assert.rejects(browser.tool.execute('9', { action: 'app_open', name: 'ping' }), /Tool ping declares no UI/);
    await assert.rejects(browser.tool.execute('10', { action: 'app_open', name: 'nope' }), /no tool named nope/);
    await assert.rejects(browser.tool.execute('11', { action: 'app_connect' }), /exactly one of command/);
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
});
