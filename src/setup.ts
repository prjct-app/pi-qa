import { noul } from '@typesafe-ai/sdk';
import { createJevClient, type JevFactory } from './jev.ts';
import type { QaSettings } from './settings.ts';
import { clip } from './text.ts';

/** Validate one global TypeSafe key through the Jev client embedded in the extension. */
export const verifyEvaluatorKey = async (
  key: string,
  settings: QaSettings,
  factory: JevFactory = createJevClient,
): Promise<string | undefined> => {
  try {
    const client = factory(key, settings);
    await client.systemOne({
      model: settings.jevModel,
      state: { ping: 'pi-qa evaluator setup' },
      questions: { ok: noul('Is this a live TypeSafe connection check?') },
    });
    return undefined;
  } catch (error) {
    return clip(error instanceof Error ? error.message : String(error), 300);
  }
};
