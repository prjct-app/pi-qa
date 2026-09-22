import { createHash } from 'node:crypto';

/** Strip terminal control sequences from untrusted agent or git text. */
export function plain(text: unknown): string {
  return String(text ?? '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

export function clip(text: string, limit: number): string {
  if (limit <= 0) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 15))}\n…[truncated]`;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
