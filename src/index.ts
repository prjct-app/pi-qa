import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { brand, completer, openPanel, repairToolArgs, schemaForModel } from '@prjct.app/pi-tui-kit';
import { COMMAND, CONTRACT_TOOL, CUSTOM_RUN, CUSTOM_STATUS, EvaluationContractSchema, type QaRunRecord } from './schema.ts';
import { keyringStore, resolveKey, type SecretStore } from './credentials.ts';
import { formatReport } from './report.ts';
import type { JevFactory } from './jev.ts';
import type { QaRunner } from './runner.ts';
import type { GitExec } from './git.ts';
import { agentHome, loadSettings, prjctHome, type QaSettings } from './settings.ts';
import { checkContract } from './schema.ts';
import { clip, plain } from './text.ts';
import { qaLivePanelSpec } from './panel.ts';
import { createQaLiveModel, type QaLiveModel } from './progress.ts';
import { selectQaModel } from './model.ts';
import { panelActions, present as presentRecord, registerQaRenderers } from './command-ui.ts';
import { parseArgs, refersToThisExtension, findSelfTarget } from './command-target.ts';

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

/** Loaded on first /qa: see engine.ts. */
const engine = () => import('./engine.ts');

export function installQa(pi: ExtensionAPI, deps: QaDependencies = {}): void {
  repairToolArgs(pi, { pi_qa_tester_report: { truncate: true }, pi_qa_reviewer_report: { truncate: true } });
  const slot: { current: State } = { current: { closed: false } };
  const serialSlot: { serial: Promise<unknown> } = { serial: Promise.resolve() };
  const ctxSlot: { command?: ExtensionContext } = {};
  const get = () => slot.current;
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

  registerQaRenderers(pi);

  const configureGlobalEvaluator = async (ctx: ExtensionCommandContext): Promise<boolean> => {
    const { configureEvaluator, createJevClient } = await engine();
    return configureEvaluator(ctx, {
      store: await secrets(), settings: deps.settings ?? loadSettings(), jevFactory: deps.jevFactory ?? createJevClient, output,
    });
  };

  const present = (ctx: ExtensionCommandContext, record: QaRunRecord): void => presentRecord(ctx, record, output);

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
    // Limits stay out of what the model reads; checkContract validates the full schema below.
    parameters: schemaForModel(EvaluationContractSchema),
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
      const { loadIntent, runQa, createJevClient } = await engine();
      const context = await loadIntent(ctx, runCwd, targetMission);
      const intent = targetMission ? { ...context, userRequest: { text: targetMission, ref: 'command:/qa' } } : context;
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
    const { readLatest, evaluateExisting, createJevClient } = await engine();
    const id = runId ?? get().lastRunId ?? await readLatest(deps.home ?? prjctHome());
    if (!id) {
      output('No captured snapshot. Starting a fresh QA run.');
      await runFresh(ctx);
      return;
    }
    const record = await evaluateExisting(id, {
      cwd: ctx.cwd,
      intent: {},
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : { provider: 'none', id: 'none' },
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

const statusText = (state: State): string => {
  if (state.active) return `QA running (${state.active.runId}). /qa cancel to stop.`;
  if (state.lastRunId) return `Last run ${state.lastRunId}. /qa evaluate re-scores that snapshot.`;
  return 'No QA run in this session.';
};

export { formatReport };
