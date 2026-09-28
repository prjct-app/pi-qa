import type { FrameLocator, Page } from 'playwright-core';
import type { QaArtifact } from './schema.ts';

/** What qa_browser returns to the agent: text observations, and a screenshot when one was taken. */
export type BrowserResult = {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  details: Record<string, unknown>;
};

/** Where observations and interactions happen: the page, or the MCP App frame inside it. */
export type Scope = { readonly root: Page | FrameLocator; readonly url: string; readonly title: string };

/** The parts of a qa_browser session that the WebMCP and MCP App helpers share. */
export type BrowserKit = {
  page(): Promise<Page>;
  observe(scope: Scope): Promise<string>;
  /** Writes `data` to the artifact directory and records it as hashed evidence. */
  saveFile(stem: string, extension: string, data: string, description: string, url?: string): Promise<QaArtifact>;
};

export const textResult = (text: string, details: Record<string, unknown>): BrowserResult => ({ content: [{ type: 'text', text }], details });

export const pageScope = async (page: Page): Promise<Scope> => ({ root: page, url: page.url(), title: await page.title().catch(() => '') });

export const scopeText = (scope: Scope): Promise<string> => scope.root.locator('body').innerText({ timeout: 5_000 }).catch(() => '');

/** Parses agent-supplied JSON object text. */
export const parseJsonObject = (text: string, label: string): Record<string, unknown> => {
  const value = ((): unknown => { try { return JSON.parse(text); } catch { throw new Error(`${label} is not valid JSON: ${text.slice(0, 200)}`); } })();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
  return Object.fromEntries(Object.entries(value));
};
