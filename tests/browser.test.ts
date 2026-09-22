import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createQaBrowser } from '../src/browser.ts';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('qa_browser captures textual and visual Playwright evidence', async context => {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor >= 26) { context.skip('Playwright browser smoke is isolated from Node 26 runtimes that can terminate natively.'); return; }
  try { await access(chrome); } catch { context.skip('Chrome is not installed on this runner.'); return; }
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
