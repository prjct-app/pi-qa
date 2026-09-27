import type { Page } from 'playwright-core';
import { pageScope, parseJsonObject, scopeText, textResult, type BrowserKit, type BrowserResult } from './browser-kit.ts';
import { clip, plain } from './text.ts';

/**
 * WebMCP: pages register typed tools on document.modelContext. Chrome exposes
 * the API only with this feature on; pages without WebMCP are unaffected.
 */
export const WEBMCP_ARGS = ['--enable-features=WebMCPTesting'];

/** One tool a page registered, as the QA agent sees it. */
export type WebMcpTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema?: unknown;
  annotations: Record<string, boolean>;
  origin?: string;
};

/** What Chrome hands back for a registered tool (inputSchema is JSON text). */
type RegisteredTool = { name: string; title?: string; description?: string; inputSchema?: string; annotations?: Record<string, boolean>; origin?: string };
type ModelContext = { getTools?: () => Promise<RegisteredTool[]>; executeTool?: (tool: RegisteredTool, input: string) => Promise<unknown> };

/**
 * The page's WebMCP tools, or undefined when it exposes no document.modelContext.
 * The page functions declare no named helpers: the bundler's name shims do not exist in the page.
 */
const webMcpTools = async (page: Page): Promise<WebMcpTool[] | undefined> => {
  const raw = await page.evaluate(async () => {
    const context = (document as Document & { modelContext?: ModelContext }).modelContext;
    if (!context?.getTools) return undefined;
    return (await context.getTools()).map(tool => ({
      name: String(tool.name), title: String(tool.title ?? ''), description: String(tool.description ?? ''),
      inputSchema: tool.inputSchema, annotations: { ...(tool.annotations ?? {}) }, origin: String(tool.origin ?? ''),
    }));
  });
  return raw?.map(({ title, origin, inputSchema, ...tool }) => ({
    ...tool, ...(title ? { title } : {}), ...(origin ? { origin } : {}), inputSchema: parseSchema(inputSchema),
  }));
};

export const listWebMcpTools = async (kit: BrowserKit): Promise<BrowserResult> => {
  const page = await kit.page();
  const tools = await webMcpTools(page);
  if (!tools) return textResult(`URL: ${page.url()}\nWebMCP: this page exposes no document.modelContext, so it registers no tools. Drive it with open/click/fill instead.`, { url: page.url(), tools: [] });
  const artifact = await kit.saveFile('webmcp-tools', 'json', JSON.stringify({ url: page.url(), tools }, null, 2), `WebMCP tools the page registered (${tools.length}).`, page.url());
  const lines = tools.map(tool => `- ${tool.name}${hints(tool.annotations)}: ${plain(tool.description)}\n  input schema: ${clip(JSON.stringify(tool.inputSchema ?? {}), 2_000)}`);
  return textResult([
    `URL: ${page.url()}`,
    `WebMCP tools (${tools.length}):`,
    ...(lines.length ? lines : ['(none registered: drive this page with open, click, fill and press)']),
    `Manifest: ${artifact.path}\nSHA-256: ${artifact.hash}`,
  ].join('\n'), { url: page.url(), artifact, tools });
};

/**
 * Runs one WebMCP tool and reports what it returned and what the page shows
 * afterwards. A tool that throws is an observation, not a qa_browser failure,
 * so negative cases have evidence; a tool the page never registered is.
 */
export const callWebMcpTool = async (kit: BrowserKit, name: string, inputText: string): Promise<BrowserResult> => {
  const input = parseJsonObject(inputText, 'call_tool input');
  const page = await kit.page();
  const tools = await webMcpTools(page);
  if (!tools) throw new Error(`WebMCP: ${page.url()} exposes no document.modelContext, so there is no tool ${name}.`);
  const tool = tools.find(candidate => candidate.name === name);
  if (!tool) throw new Error(`WebMCP: ${page.url()} registers no tool named ${name}. Registered: ${tools.map(candidate => candidate.name).join(', ') || 'none'}.`);
  const before = await scopeText(await pageScope(page));
  const outcome = await page.evaluate(async ([toolName, json]) => {
    const context = (document as Document & { modelContext?: ModelContext }).modelContext;
    const registered = (await context?.getTools?.() ?? []).find(candidate => candidate.name === toolName);
    if (!context?.executeTool || !registered) return { ok: false, output: `Tool ${toolName} disappeared before it ran.` };
    try { return { ok: true, output: await context.executeTool(registered, json) }; }
    catch (error) { return { ok: false, output: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }; }
  }, [name, JSON.stringify(input)] as const);
  await page.waitForTimeout(200);
  const after = await pageScope(page);
  const changed = before !== await scopeText(after);
  const problems = schemaProblems(tool.inputSchema, input);
  return textResult([
    `WebMCP tool: ${name}${hints(tool.annotations)}`,
    `Input: ${clip(JSON.stringify(input), 2_000)}`,
    `Input vs schema: ${problems.length ? problems.join('; ') : 'conforms'} (Chrome does not validate inputs; the page must)`,
    `Result: ${outcome.ok ? 'returned' : 'threw'}`,
    `Output: ${clip(plain(toolOutput(outcome.output)), 6_000)}`,
    `Page text changed: ${changed ? 'yes' : 'no'}`,
    '--- Page after the call ---',
    await kit.observe(after),
  ].join('\n'), { url: page.url(), tool: name, returned: outcome.ok, pageChanged: changed });
};

/** " [readOnly, consequential]" for the annotations that are on. */
export const hints = (annotations: Record<string, unknown>): string => {
  const on = Object.entries(annotations).filter(([, value]) => value === true).map(([key]) => key.replace(/Hint$/, ''));
  return on.length ? ` [${on.join(', ')}]` : '';
};

/** Chrome hands the schema back as JSON text. */
const parseSchema = (schema: unknown): unknown => {
  if (typeof schema !== 'string') return schema ?? undefined;
  try { return schema ? JSON.parse(schema) : undefined; } catch { return schema; }
};

const JSON_TYPES: Record<string, (value: unknown) => boolean> = {
  string: value => typeof value === 'string', number: value => typeof value === 'number', integer: value => Number.isInteger(value),
  boolean: value => typeof value === 'boolean', object: value => typeof value === 'object' && value !== null && !Array.isArray(value),
  array: value => Array.isArray(value), null: value => value === null,
};

type ObjectSchema = { properties?: Record<string, { type?: string | string[] }>; required?: string[]; additionalProperties?: unknown };

/** Top-level differences between an input and a tool's JSON Schema: missing required, unknown or mistyped properties. */
export const schemaProblems = (schema: unknown, input: Record<string, unknown>): string[] => {
  if (typeof schema !== 'object' || schema === null) return [];
  const { properties = {}, required = [], additionalProperties }: ObjectSchema = schema;
  return [
    ...required.filter(key => !(key in input)).map(key => `missing required "${key}"`),
    ...(additionalProperties === false ? Object.keys(input).filter(key => !(key in properties)).map(key => `unknown property "${key}"`) : []),
    ...Object.entries(input).flatMap(([key, value]) => {
      const types = [properties[key]?.type ?? []].flat();
      return types.length && !types.some(type => JSON_TYPES[type]?.(value) ?? true) ? [`"${key}" is not ${types.join(' or ')}`] : [];
    }),
  ];
};

/** Tool results as text: MCP-style text content plainly, anything else as JSON. */
export const toolOutput = (output: unknown): string => {
  const value = ((): unknown => { try { return typeof output === 'string' ? JSON.parse(output) : output; } catch { return output; } })();
  const content = typeof value === 'object' && value !== null && 'content' in value ? value.content : undefined;
  if (Array.isArray(content) && content.every(item => item?.type === 'text')) return content.map(item => String(item.text ?? '')).join('\n');
  return typeof value === 'string' ? value : JSON.stringify(value);
};
