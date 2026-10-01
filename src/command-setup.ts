import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { openSecretPrompt } from '@prjct.app/pi-tui-kit';
import { keyHasValidShape, saveKey, type SecretStore } from './credentials.ts';
import { verifyEvaluatorKey } from './setup.ts';
import type { JevFactory } from './jev.ts';
import type { QaSettings } from './settings.ts';

export async function configureEvaluator(ctx: ExtensionCommandContext, input: {
  store: SecretStore;
  settings: QaSettings;
  jevFactory: JevFactory;
  output: (text: string, level?: 'info' | 'error') => void;
}): Promise<boolean> {
  if (ctx.mode !== 'tui' || !ctx.hasUI) {
    input.output('Set TYPESAFE_API_KEY for RPC/print mode, or run /qa setup in TUI.', 'error');
    return false;
  }
  const key = await openSecretPrompt(ctx, {
    title: 'Global evaluator key',
    message: 'Stored once in the OS keyring for every project.',
    label: 'key',
    placeholder: 'paste TypeSafe key',
    validate: async value => {
      if (!keyHasValidShape(value)) return 'That value is not a valid TypeSafe API key.';
      ctx.ui.setStatus?.('qa', 'Validating global evaluator…');
      try {
        const error = await verifyEvaluatorKey(value, input.settings, input.jevFactory);
        if (error) return error;
        await saveKey(input.store, value, true);
        return undefined;
      } finally {
        ctx.ui.setStatus?.('qa', undefined);
      }
    },
  });
  return Boolean(key);
}
