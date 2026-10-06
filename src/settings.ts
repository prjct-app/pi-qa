import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export type QaSettings = {
  qaModel?: string;
  confidenceThreshold: number;
  timeoutMs: number;
  evaluationTimeoutMs: number;
  excerptChars: number;
  largeFileBytes: number;
  patchChars: number;
};

export const defaultSettings = (): QaSettings => ({
  confidenceThreshold: 0.8,
  timeoutMs: 10 * 60_000,
  evaluationTimeoutMs: 30_000,
  excerptChars: 4_000,
  largeFileBytes: 262_144,
  patchChars: 200_000,
});

export const agentHome = (): string => {
  try { return getAgentDir(); } catch { return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'); }
};

export const prjctHome = (): string => process.env.PRJCT_HOME ?? join(homedir(), '.prjct');

export const settingsPath = (home = agentHome()): string => join(home, 'prjct-qa.json');

/** Invalid fields keep the previous layer. Secrets are never read from this file. */
export function loadSettings(home = agentHome(), warn: (text: string) => void = () => undefined): QaSettings {
  const file = settingsPath(home);
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected an object');
    return Object.entries(raw).reduce((settings, [key, value]) => {
      if (key === 'qaModel' && typeof value === 'string' && value.trim().length > 0 && value.length <= 256) return { ...settings, qaModel: value.trim() };
      if (key === 'confidenceThreshold' && isUnit(value)) return { ...settings, confidenceThreshold: value };
      if (key === 'timeoutMs' && isPositiveInt(value, 60_000, 24 * 60 * 60_000)) return { ...settings, timeoutMs: value };
      if (key === 'evaluationTimeoutMs' && isPositiveInt(value, 1_000, 120_000)) return { ...settings, evaluationTimeoutMs: value };
      if (key === 'excerptChars' && isPositiveInt(value, 500, 16_000)) return { ...settings, excerptChars: value };
      if (key === 'largeFileBytes' && isPositiveInt(value, 8_192, 2_000_000)) return { ...settings, largeFileBytes: value };
      if (key === 'patchChars' && isPositiveInt(value, 4_000, 1_000_000)) return { ...settings, patchChars: value };
      warn(`${file}: invalid ${key}; keeping the previous value.`);
      return settings;
    }, defaultSettings());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn(`${file}: ${String(error)}`);
    return defaultSettings();
  }
}

const isUnit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0.5 && value <= 0.99;
const isPositiveInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
