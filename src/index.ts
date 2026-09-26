import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { Container, Text } from '@earendil-works/pi-tui';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import type { IntentContext } from './contract.ts';
import { SYMBOL, brand, completer, sessionComplete, openPanel, openSecretPrompt, row, toEnglishInstructions, type Complete, type PanelAction } from '@prjct.app/pi-tui-kit';
import { COMMAND, CONTRACT_TOOL, CUSTOM_RUN, CUSTOM_STATUS, EvaluationContractSchema, type QaRunRecord } from './schema.ts';
import { loadIntent } from './context.ts';
import { keyHasValidShape, keyringStore, resolveKey, saveKey, type SecretStore } from './credentials.ts';
import { evaluateExisting, readLatest, runQa } from './orchestrate.ts';
import { boundedReport, formatReport } from './report.ts';
import { createJevClient, type JevFactory } from './jev.ts';
import type { QaRunner } from './runner.ts';
import type { GitExec } from './git.ts';
import { agentHome, loadSettings, prjctHome, type QaSettings } from './settings.ts';
import { verifyEvaluatorKey } from './setup.ts';
import { checkContract } from './schema.ts';
import { clip, plain } from './text.ts';
import { qaLivePanelSpec, qaPanelSpec } from './panel.ts';
import { createQaLiveModel, type QaLiveModel } from './progress.ts';
import { selectQaModel } from './model.ts';
import { copyToClipboard, openArtifactDirectory, qaPrompt, writeArtifacts } from './export.ts';

export type QaDependencies = {
  store?: SecretStore;
  runner?: QaRunner;
  jevFactory?: JevFactory;
  git?: GitExec;
  settings?: QaSettings;
  home?: string;
  extensionPaths?: string[];
  env?: NodeJS.ProcessEnv;
  selfTarget?: string;
  /** Rewrites a non-English mission for the QA agents. Defaults to the session's own model. */
  complete?: Complete;
};

type State = {
  closed: boolean;
  pendingContract?: unknown;
  active?: { runId: string; controller: AbortController; live?: QaLiveModel; done?: Promise<unknown> };
  lastRunId?: string;
  lastRecord?: QaRunRecord;
  store?: SecretStore;
};

const ACTIONS = [
  { value: 'run', description: 'design and execute QA test cases' },
  { value: 'status', description: 'show the active or last QA run' },
  { value: 'cancel', description: 'cancel the active QA run' },
  { value: 'setup', description: 'open the local TypeSafe key UI' },
  { value: 'evaluate', description: 're-evaluate a captured snapshot with Jev (no agent rerun)' },
] as const;

const OUTPUT_LIMIT = 16_384;

export function installQa(pi: ExtensionAPI, deps: QaDependencies = {}): void {
  const slot: { current: State } = { current: { closed: false } };
  const serialSlot: { serial: Promise<unknown> } = { serial: Promise.resolve() };
  const ctxSlot: { command?: ExtensionContext } = {};
  const get = () => slot.current;
  /**
   * QA agents read English. The mission and plan items are rewritten when they
   * are not; the originals stay as the verbatim source provenance is checked against.
   */
  const inEnglish = async (intent: IntentContext, ctx: ExtensionContext): Promise<IntentContext> => {
    const complete = deps.complete ?? sessionComplete(ctx);
    const [english, englishItems] = await Promise.all([
      intent.userRequest ? toEnglishInstructions(intent.userRequest.text, complete) : undefined,
      intent.plan ? Promise.all(intent.plan.items.map(item => toEnglishInstructions(item, complete))) : undefined,
    ]);
    return {
      ...intent,
      ...(intent.userRequest ? { userRequest: { ...intent.userRequest, english } } : {}),
      ...(intent.plan ? { plan: { ...intent.plan, englishItems } } : {}),
    };
  };
  const set = (update: Partial<State>) => { slot.current = { ...get(), ...update }; };

  /** Serialized like pi-team commands: handlers never interleave. */
  const queue = <T>(action: () => Promise<T>): Promise<T> => {
    const next = serialSlot.serial.then(action);
    serialSlot.serial = next.catch(() => undefined);
    return next;
  };

  /** TUI gets notify; RPC (and print/json) get a custom next-turn message. */
  const output = (text: string, level: 'info' | 'error' = 'info'): void => {
    const safe = clip(plain(text), OUTPUT_LIMIT);
    const ctx = ctxSlot.command;
    if (ctx?.hasUI) ctx.ui.notify(safe, level);
    else pi.sendMessage({ customType: CUSTOM_STATUS, content: safe, display: true }, { triggerTurn: false, deliverAs: 'nextTurn' });
  };

  pi.registerMessageRenderer?.(CUSTOM_STATUS, (message: unknown, _expanded: unknown, theme: Theme) => {
    const text = String((message as { content?: string }).content ?? '');
    const container = new Container();
    container.addChild(row(theme, { symbol: text.includes('FAIL') ? SYMBOL.error : SYMBOL.ok, tone: text.includes('FAIL') ? 'error' : 'accent', verb: 'QA', target: 'status', meta: text.split('\n')[0] ?? '' }));
    container.addChild(new Text(theme.fg('dim', text), 2, 0));
    return container;
  });

  pi.registerMessageRenderer?.(CUSTOM_RUN, (message: unknown, _expanded: unknown, theme: Theme) => {
    const data = message as { content?: { runId?: string; verdict?: string; fingerprint?: string; kind?: string; description?: string } };
    const container = new Container();
    const line = data.content?.kind === 'contract'
      ? `contract stored: ${data.content.description ?? ''}`
      : `${data.content?.verdict ?? ''}  run ${data.content?.runId ?? ''}  snapshot ${data.content?.fingerprint?.slice(0, 12) ?? ''}`;
    container.addChild(row(theme, { symbol: data.content?.verdict === 'FAIL' ? SYMBOL.error : SYMBOL.ok, tone: data.content?.verdict === 'FAIL' ? 'error' : 'accent', verb: 'QA', target: data.content?.kind === 'contract' ? 'contract' : 'run', meta: line }));
    return container;
  });

  const configureGlobalEvaluator = async (ctx: ExtensionCommandContext): Promise<boolean> => {
    if (ctx.mode !== 'tui' || !ctx.hasUI) {
      output('Set TYPESAFE_API_KEY for RPC/print mode, or run /qa setup in TUI.', 'error');
      return false;
    }
    const store = await secrets();
    const settings = deps.settings ?? loadSettings();
    const key = await openSecretPrompt(ctx, {
      title: 'Global evaluator key',
      message: 'Stored once in the OS keyring for every project.',
      label: 'key',
      placeholder: 'paste TypeSafe key',
      validate: async value => {
        if (!keyHasValidShape(value)) return 'That value is not a valid TypeSafe API key.';
        ctx.ui.setStatus?.('qa', 'Validating global evaluator…');
        try {
          const error = await verifyEvaluatorKey(value, settings, deps.jevFactory ?? createJevClient);
          if (error) return error;
          await saveKey(store, value, true);
          return undefined;
        } finally {
          ctx.ui.setStatus?.('qa', undefined);
        }
      },
    });
    return Boolean(key);
  };

  const panelActions = (ctx: ExtensionCommandContext, live: QaLiveModel, controller: AbortController): PanelAction[] => [
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

  const present = (ctx: ExtensionCommandContext, record: Awaited<ReturnType<typeof runQa>>): void => {
    if (ctx.mode === 'tui' && ctx.hasUI) {
      const live = createQaLiveModel(record.runId, record.contract.description);
      live.update({ kind: 'complete', record });
      const actions = panelActions(ctx, live, new AbortController());
      void openPanel(ctx, qaLivePanelSpec(live, actions)).catch(error => output(error instanceof Error ? error.message : String(error), 'error'));
      return;
    }
    output(boundedReport(record));
  };

  const secrets = async (): Promise<SecretStore> => {
    if (deps.store) return deps.store;
    if (!get().store) set({ store: await keyringStore() });
    return get().store!;
  };

  pi.registerCommand(COMMAND, {
    description: brand('evaluate any QA target with two Pi agents and Jev'),
    getArgumentCompletions: completer([...ACTIONS, { value: '--base', description: 'local git ref to diff against when the tree is clean' }]),
    handler: async (args, ctx) => {
      ctxSlot.command = ctx;
      const parsed = parseArgs(args);
      if (parsed.action === 'cancel') {
        const active = get().active;
        active?.controller.abort();
        output(active ? `Canceling ${active.runId}.` : 'No active QA run.');
        return;
      }
      if (parsed.action === 'status') {
        const active = get().active;
        if (active?.live && ctx.mode === 'tui' && ctx.hasUI) {
          const actions = panelActions(ctx, active.live, active.controller);
          void openPanel(ctx, qaLivePanelSpec(active.live, actions)).catch(error => output(String(error), 'error'));
        } else if (get().lastRecord) present(ctx, get().lastRecord!);
        else output(statusText(get()));
        return;
      }
      return queue(async () => {
        try {
          if (get().closed) {
            output('QA session is closed.');
            return;
          }
        if (parsed.action === 'setup') {
          await configureGlobalEvaluator(ctx);
          return;
        }
        if (parsed.action === 'evaluate') {
          await runEvaluate(ctx, parsed.runId);
          return;
        }
        await runFresh(ctx, parsed.base, parsed.request, parsed.target);
        } catch (error) {
          ctx.ui.setStatus?.('qa', undefined);
          output(error instanceof Error ? error.message : String(error), 'error');
        }
      });
    },
  });

  pi.registerTool({
    name: CONTRACT_TOOL,
    label: 'QA contract',
    description: 'Submit a dynamic evaluation contract for the next /qa run. Inferred items must use source inferred_from_diff; do not relabel them as user requirements. '
      + `Write description, text and observe in plain, simple English, even when the person wrote in another language; sourceText stays a verbatim quote.`,
    parameters: EvaluationContractSchema,
    execute: async (_id, params) => {
      if (!checkContract(params)) {
        return { content: [{ type: 'text' as const, text: 'Contract rejected: schema validation failed.' }], details: {} };
      }
      set({ pendingContract: params });
      pi.appendEntry(CUSTOM_RUN, { kind: 'contract', description: params.description, items: params.items.length });
      return { content: [{ type: 'text' as const, text: `Contract stored (${params.items.length} items) for the next /qa run.` }], details: {} };
    },
  });

  pi.on('session_shutdown', async () => {
    set({ closed: true });
    get().active?.controller.abort();
    await queue(async () => {
      const active = get().active;
      await active?.done?.catch(() => undefined);
      set({ active: undefined });
    });
  });

  const runFresh = async (ctx: ExtensionCommandContext, base?: string, request?: string, target?: string) => {
    const running = get().active;
    if (running) {
      output(`QA already running (${running.runId}). Use /qa status or /qa cancel.`);
      return;
    }
    const settings = deps.settings ?? loadSettings();
    const store = await secrets();
    const credential = await resolveKey(store, deps.env);
    if (credential.state !== 'usable') {
      // Jev is an optional evaluator, not a precondition for QA. A run without
      // it still designs test cases and captures evidence, and /qa evaluate
      // scores that snapshot afterwards without re-running the agents, so
      // refusing to start only threw the work away. The cost is stated up
      // front rather than discovered at the verdict.
      const configured = credential.state === 'missing' && ctx.mode === 'tui' && ctx.hasUI
        && await configureGlobalEvaluator(ctx);
      if (!configured) {
        output(`${credential.detail} This run captures test cases and evidence but cannot reach a verdict; add a key, then re-score it with /qa evaluate.`);
      }
    }
    const availableModels = ctx.scopedModels?.length
      ? ctx.scopedModels.map(entry => entry.model)
      : ctx.modelRegistry?.getAvailable?.() ?? [];
    const textModels = availableModels.filter(model => model.input.includes('text'));
    const selectedModel = selectQaModel(textModels, ctx.model, settings.qaModel);
    if (!selectedModel) {
      output('No authenticated model is available for the QA agent.');
      return;
    }
    const model = { provider: selectedModel.provider, id: selectedModel.id };
    const runId = randomUUID();
    const controller = new AbortController();
    const inferredSelfTarget = !target && request && refersToThisExtension(request)
      ? deps.selfTarget ?? await findSelfTarget(ctx.cwd)
      : undefined;
    const targetPath = target ? resolve(ctx.cwd, target) : inferredSelfTarget;
    const targetStat = targetPath ? await lstat(targetPath).catch(() => undefined) : undefined;
    if (targetPath && !targetStat) throw new Error(`QA target does not exist: ${targetPath}`);
    const runCwd = targetPath && targetStat?.isFile() ? dirname(targetPath) : targetPath ?? ctx.cwd;
    const targetPaths = targetPath ? [targetStat?.isFile() ? basename(targetPath) : '.'] : undefined;
    const targetMission = request ?? (targetPath ? `Evaluate the explicit target ${targetPath}.` : undefined);
    const live = createQaLiveModel(runId, targetMission ?? 'Deriving QA mission from the current Pi context…');
    set({ active: { runId, controller, live } });
    if (ctx.mode === 'tui' && ctx.hasUI) {
      const actions = panelActions(ctx, live, controller);
      void openPanel(ctx, qaLivePanelSpec(live, actions)).catch(error => output(error instanceof Error ? error.message : String(error), 'error'));
    }
    ctx.ui.setStatus?.('qa', request ? 'capturing QA target…' : 'capturing snapshot…');
    try {
      const context = await loadIntent(ctx, runCwd, targetMission);
      const intent = await inEnglish(targetMission ? { ...context, userRequest: { text: targetMission, ref: 'command:/qa' } } : context, ctx);
      live.state.mission = intent.userRequest?.english ?? intent.userRequest?.text ?? 'Inspect the available target and identify what cannot be established.';
      const record = await runQa({
        cwd: runCwd,
        intent,
        pendingContract: get().pendingContract,
        base,
        model,
        thinkingLevel: ctx.thinkingLevel ?? pi.getThinkingLevel?.(),
        agentDir: agentHome(),
        store,
        settings,
        runner: deps.runner,
        jevFactory: deps.jevFactory ?? createJevClient,
        git: deps.git,
        env: deps.env,
        signal: controller.signal,
        home: deps.home ?? prjctHome(),
        extensionPaths: deps.extensionPaths,
        runId,
        scope: request || targetPath ? 'target' : 'change',
        filesystemTarget: Boolean(targetPath),
        targetPaths,
        onProgress: live.update,
        onActive: update => {
          const active = get().active;
          if (active?.runId === runId) set({ active: { ...active, runId: update.runId, done: update.done } });
        },
      });
      set({ lastRunId: record.runId, lastRecord: record, pendingContract: undefined });
      ctx.ui.setStatus?.('qa', `${record.verdict}`);
      if (!(ctx.mode === 'tui' && ctx.hasUI)) present(ctx, record);
      pi.appendEntry(CUSTOM_RUN, { runId: record.runId, verdict: record.verdict, fingerprint: record.snapshot.fingerprint });
    } catch (error) {
      live.update({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      if (get().active?.runId === runId) set({ active: undefined });
    }
  };

  const runEvaluate = async (ctx: ExtensionCommandContext, runId?: string) => {
    const store = await secrets();
    const credential = await resolveKey(store, deps.env);
    if (credential.state !== 'usable') {
      // Unlike /qa, this command exists only to score a captured snapshot with
      // Jev. Without a key there is nothing for it to do, so saying so beats
      // re-reading the snapshot to produce the same NOT_VERIFIED it already has.
      if (credential.state === 'missing') {
        if (!(await configureGlobalEvaluator(ctx))) return;
      } else {
        output(`${credential.detail} Replace it with /qa setup.`, 'error');
        return;
      }
    }
    const id = runId ?? get().lastRunId ?? await readLatest(deps.home ?? prjctHome());
    if (!id) {
      output('No captured snapshot. Starting a fresh QA run.');
      await runFresh(ctx);
      return;
    }
    const record = await evaluateExisting(id, {
      cwd: ctx.cwd,
      intent: {},
      model: parentModel(ctx) ?? { provider: 'none', id: 'none' },
      store,
      settings: deps.settings ?? loadSettings(),
      jevFactory: deps.jevFactory ?? createJevClient,
      git: deps.git,
      env: deps.env,
      home: deps.home ?? prjctHome(),
    });
    set({ lastRunId: record.runId, lastRecord: record });
    ctx.ui.setStatus?.('qa', `${record.verdict}`);
    present(ctx, record);
  };

}

export default (pi: ExtensionAPI): void => installQa(pi);

const parentModel = (ctx: ExtensionContext): { provider: string; id: string } | undefined => {
  const model = ctx.model;
  if (!model) return undefined;
  return { provider: model.provider, id: model.id };
};

type ParsedArgs = { action: 'run' | 'status' | 'cancel' | 'setup' | 'evaluate'; base?: string; target?: string; runId?: string; request?: string };

const parseArgs = (args: string): ParsedArgs => {
  const tokens = (args.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(token => token.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2')).filter(Boolean);
  const exact = tokens.join(' ');
  if (exact === 'status' || exact === 'cancel' || exact === 'setup') return { action: exact };
  if (tokens[0] === 'evaluate' && (tokens.length === 1 || (tokens.length === 2 && UUID.test(tokens[1] ?? '')))) {
    return { action: 'evaluate', runId: tokens[1] };
  }
  const collected = tokens.reduce<{ values: string[]; base?: string; target?: string; skip: boolean }>((acc, token, index, all) => {
    if (acc.skip) return { ...acc, skip: false };
    if (token === '--base' && all[index + 1]) return { ...acc, base: all[index + 1], skip: true };
    if (token === '--target' && all[index + 1]) return { ...acc, target: all[index + 1], skip: true };
    return { ...acc, values: [...acc.values, token] };
  }, { values: [], skip: false });
  const values = collected.values[0] === 'run' ? collected.values.slice(1) : collected.values;
  return { action: 'run', base: collected.base, target: collected.target, request: values.join(' ').trim() || undefined };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const refersToThisExtension = (request: string): boolean => /(?:\bpi-qa\b|\b(?:esta|this|la)\s+extensi[oó]n\b|\bextension\b|\bextensi[oó]n\b)/i.test(request);

const findSelfTarget = async (cwd: string): Promise<string | undefined> => {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [...new Set([join(cwd, 'pi-qa'), cwd, dirname(moduleDir), moduleDir])];
  const matched = await Promise.all(candidates.map(async candidate => {
    try {
      const manifest = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8')) as { name?: string; pi?: unknown };
      return manifest.name === '@prjct.app/pi-qa' ? candidate : undefined;
    } catch {
      return undefined;
    }
  }));
  return matched.find(Boolean);
};

const statusText = (state: State): string => {
  if (state.active) return `QA running (${state.active.runId}). /qa cancel to stop.`;
  if (state.lastRunId) return `Last run ${state.lastRunId}. /qa evaluate re-scores that snapshot.`;
  return 'No QA run in this session.';
};

export { formatReport };
