import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where qa_browser finds Chrome: the system browser, Playwright's bundled one, or any it cached. */
const firstExisting = async (paths: string[]): Promise<string | undefined> => {
  const found = await Promise.all(paths.map(async path => {
    try { await access(path); return path; } catch { return undefined; }
  }));
  return found.find(Boolean);
};

const systemBrowsers = (): string[] => process.platform === 'darwin'
  ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
  : process.platform === 'win32'
    ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];

const playwrightCacheDir = (): string => {
  const configured = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (configured && configured !== '0') return configured;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ms-playwright');
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ms-playwright');
};

const cachedChromiumBinaries = (revisionDir: string): string[] => process.platform === 'darwin'
  ? ['chrome-mac-arm64', 'chrome-mac-x64', 'chrome-mac'].flatMap(dir => [
    join(revisionDir, dir, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
    join(revisionDir, dir, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
  ])
  : process.platform === 'win32'
    ? ['chrome-win64', 'chrome-win'].map(dir => join(revisionDir, dir, 'chrome.exe'))
    : ['chrome-linux64', 'chrome-linux'].map(dir => join(revisionDir, dir, 'chrome'));

// Any Chromium a previous Playwright install left behind, newest revision first.
// A few revisions of drift are fine for the CDP surface qa_browser uses.
const cachedPlaywrightChromium = async (): Promise<string | undefined> => {
  const root = playwrightCacheDir();
  const entries = await readdir(root).catch(() => [] as string[]);
  const revisions = entries
    .map(name => ({ name, revision: Number(/^chromium-(\d+)$/.exec(name)?.[1]) }))
    .filter(entry => Number.isFinite(entry.revision))
    .sort((a, b) => b.revision - a.revision);
  return firstExisting(revisions.flatMap(entry => cachedChromiumBinaries(join(root, entry.name))));
};

const bundledPlaywrightChromium = async (): Promise<string | undefined> => {
  try {
    const { chromium } = await import('playwright-core');
    return firstExisting([chromium.executablePath()]);
  } catch {
    return undefined;
  }
};

export const browserExecutable = async (): Promise<string | undefined> =>
  await firstExisting(systemBrowsers()) ?? await bundledPlaywrightChromium() ?? await cachedPlaywrightChromium();

