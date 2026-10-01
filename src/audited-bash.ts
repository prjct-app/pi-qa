import { randomUUID } from 'node:crypto';
import { createBashTool } from '@earendil-works/pi-coding-agent';
import type { ExecutionReceipt } from './schema.ts';
import { clip, plain, sha256Hex } from './text.ts';

export const auditedBash = (cwd: string, receipts: ExecutionReceipt[]) => {
  const base = createBashTool(cwd);
  const execute: typeof base.execute = async (...args) => {
    const [toolCallId, params, signal] = args;
    const id = `bash-${toolCallId}-${randomUUID()}`;
    const startedAt = new Date().toISOString();
    try {
      const result = await base.execute(...args);
      const output = result.content.map(item => item.type === 'text' ? item.text : '').join('\n');
      const { exitCode, failed } = bashStatus(result);
      receipts.push(receipt({ id, command: params.command, cwd, startedAt, status: failed ? 'failed' : 'completed', exitCode, output }));
      return { ...result, content: [...result.content, { type: 'text' as const, text: `QA execution receipt: ${id}` }] };
    } catch (error) {
      const output = error instanceof Error ? error.message : String(error);
      const matched = /Command exited with code (-?\d+)/.exec(output);
      receipts.push(receipt({ id, command: params.command, cwd, startedAt, status: signal?.aborted ? 'canceled' : 'failed', exitCode: matched ? Number(matched[1]) : null, output }));
      throw new Error(`${output}\nQA execution receipt: ${id}`);
    }
  };
  return { ...base, execute };
};

export const bashStatus = (result: unknown): { exitCode: number | null; failed: boolean } => {
  const data = result !== null && typeof result === 'object' ? result : {};
  const metadata = 'structuredContent' in data ? data.structuredContent : undefined;
  const isError = 'isError' in data && data.isError === true;
  const exitCode = metadata && typeof metadata === 'object' && 'exit_code' in metadata && typeof metadata.exit_code === 'number'
    ? metadata.exit_code : isError ? null : 0;
  return { exitCode, failed: isError || exitCode !== 0 };
};

const receipt = (input: Omit<ExecutionReceipt, 'tool' | 'finishedAt' | 'outputHash' | 'outputExcerpt'> & { output: string }): ExecutionReceipt => ({
  id: input.id,
  tool: 'bash',
  command: input.command,
  cwd: input.cwd,
  startedAt: input.startedAt,
  finishedAt: new Date().toISOString(),
  status: input.status,
  exitCode: input.exitCode,
  outputHash: sha256Hex(input.output),
  outputExcerpt: clip(plain(input.output), 4_000),
});
