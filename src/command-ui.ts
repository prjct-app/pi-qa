import { join } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext, Theme } from '@earendil-works/pi-coding-agent';
import { Container, Text } from '@earendil-works/pi-tui';
import { openPanel, SYMBOL, row, type PanelAction } from '@prjct.app/pi-tui-kit';
import { copyToClipboard, openArtifactDirectory, qaPrompt, writeArtifacts } from './export.ts';
import { qaLivePanelSpec } from './panel.ts';
import { createQaLiveModel, type QaLiveModel } from './progress.ts';
import { CUSTOM_RUN, CUSTOM_STATUS, type QaRunRecord } from './schema.ts';
import { boundedReport } from './report.ts';

export const registerQaRenderers = (pi: ExtensionAPI): void => {
  pi.registerMessageRenderer?.(CUSTOM_STATUS, (message: unknown, _expanded: unknown, theme: Theme) => {
    const data = record(message);
    const text = String(data.content ?? '');
    const container = new Container();
    container.addChild(row(theme, { symbol: text.includes('FAIL') ? SYMBOL.error : SYMBOL.ok, tone: text.includes('FAIL') ? 'error' : 'accent', verb: 'QA', target: 'status', meta: text.split('\n')[0] ?? '' }));
    container.addChild(new Text(theme.fg('dim', text), 2, 0));
    return container;
  });
  pi.registerMessageRenderer?.(CUSTOM_RUN, (message: unknown, _expanded: unknown, theme: Theme) => {
    const data = record(record(message).content);
    const line = data.kind === 'contract'
      ? `contract stored: ${String(data.description ?? '')}`
      : `${String(data.verdict ?? '')}  run ${String(data.runId ?? '')}  snapshot ${String(data.fingerprint ?? '').slice(0, 12)}`;
    const container = new Container();
    container.addChild(row(theme, { symbol: data.verdict === 'FAIL' ? SYMBOL.error : SYMBOL.ok, tone: data.verdict === 'FAIL' ? 'error' : 'accent', verb: 'QA', target: data.kind === 'contract' ? 'contract' : 'run', meta: line }));
    return container;
  });
};

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value)) : {};

export const panelActions = (ctx: ExtensionCommandContext, live: QaLiveModel, controller: AbortController): PanelAction[] => [
  {
    key: 'x', label: 'cancel run', when: () => !live.state.record,
    run: async (_item, panel) => { controller.abort(); panel.notice('Cancel requested. Preserving partial evidence.', 'warning'); },
  },
  {
    key: 'e', label: 'export artifacts', when: () => Boolean(live.state.record), confirm: true,
    run: async (_item, panel) => {
      const record = live.state.record!;
      const destination = join(record.snapshot.cwd, 'qa-results', record.runId);
      const exported = await writeArtifacts(record, destination);
      panel.notice(`Exported ${exported.files.length} files to ${exported.directory}`, 'success');
    },
  },
  {
    key: 'p', label: 'copy non-passing', when: () => Boolean(live.state.record),
    run: async (_item, panel) => {
      const prompt = qaPrompt(live.state.record!);
      await copyToClipboard(prompt);
      panel.notice(`Copied ${prompt.length.toLocaleString()} characters to clipboard.`, 'success');
    },
  },
  {
    key: 'o', label: 'open artifacts', when: () => Boolean(live.state.record?.exports?.directory),
    run: async (_item, panel) => {
      const directory = live.state.record!.exports!.directory;
      await openArtifactDirectory(directory);
      panel.notice(`Opened ${directory}`, 'success');
    },
  },
  {
    key: 'r', label: 'run again', when: () => Boolean(live.state.record),
    run: async (_item, panel) => {
      const record = live.state.record!;
      const mission = record.contract.items.find(item => item.source === 'user_request')?.sourceText
        ?? record.contract.items.find(item => item.source === 'user_request')?.text
        ?? record.contract.description;
      panel.close();
      ctx.ui.setEditorText(`/qa ${mission}`);
    },
  },
];

export const present = (ctx: ExtensionCommandContext, record: QaRunRecord, output: (text: string, level?: 'info' | 'error') => void): void => {
  if (ctx.mode === 'tui' && ctx.hasUI) {
    const live = createQaLiveModel(record.runId, record.contract.description);
    live.update({ kind: 'complete', record });
    const actions = panelActions(ctx, live, new AbortController());
    void openPanel(ctx, qaLivePanelSpec(live, actions)).catch(error => output(error instanceof Error ? error.message : String(error), 'error'));
    return;
  }
  output(boundedReport(record));
};
