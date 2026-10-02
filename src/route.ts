import { resolveKey, type SecretStore } from './credentials.ts';
import { createJevClient, type JevClient, type JevFactory } from './jev.ts';
import { selectQaModel } from './model.ts';
import type { QaSettings } from './settings.ts';
import type { QaModel } from './model.ts';

/**
 * Which of this session's models a QA agent runs on, when the operator
 * says nothing about it.
 *
 * QA is judgement work, and the default stays on the model the person is
 * using; the audit's "QA judges work, so it runs on the model the person
 * is using" line in model.ts is deliberate and is preserved here. This
 * module is the opt-in: when the setting turns it on, Jev reads the
 * mission the /qa command was given, rates what level of model it needs,
 * and picks from the session's enabled models, cheapest first. The
 * router logs nothing here; the existing QA record already carries what
 * the agent ran on and at what cost.
 *
 * Every way the call can fail lands on the session's own model: no key,
 * a slow answer, an unknown level, or low trust. QA judgement costs more
 * than the cheaper model saves when the call is wrong, so the threshold
 * is the same one pi-subagents uses for delegations.
 */

export const TASK_LEVELS = ['reading', 'implementation', 'reasoning'] as const;
export type TaskLevel = (typeof TASK_LEVELS)[number];

export const ROUTE_QUESTION = {
  level: {
    type: 'choice' as const,
    instructions: 'What level of model does the QA `task` need? Judge the task itself: a QA agent runs test cases or reviews a snapshot against criteria.',
    criteria: {
      reading: 'Reading and mapping: review a snapshot, read files, list findings. One reader with plain tool use answers it.',
      implementation: 'Bounded implementation: run specific test cases against a UI or filesystem; the scope and what success means are stated in the task.',
      reasoning: 'Hard reasoning: the QA work is a judgement call across criteria that are not enumerated. A wrong call costs more than the cheaper model saved.',
    },
  },
};

/** Below this, the session's own model: the same line pi-subagents draws. */
export const ROUTE_MIN = 0.6;

export type RouteChoice = { provider: string; modelId: string };

export type Routing = {
  /** Absent when nothing was routed: no judge, no answer worth trusting, no choice. */
  level?: TaskLevel;
  confidence?: number;
  /** The model the picker chose; absent means the session's own. */
  wanted?: string;
  basis: 'routed' | 'session';
};

/** Cheapest for reading, strongest for reasoning, the middle for the rest. */
export function modelFor(level: TaskLevel, choices: readonly RouteChoice[]): string | undefined {
  if (choices.length === 0) return undefined;
  const index = level === 'reading'
    ? 0
    : level === 'reasoning'
      ? choices.length - 1
      : Math.ceil((choices.length - 1) / 2);
  return choices[index]?.modelId;
}

const fallback = (): Routing => ({ basis: 'session' });

/** One QA agent's model. Anything unanswerable is a decision to use the session's own. */
export async function routeFor(
  task: { subject: string; task: string },
  choices: readonly RouteChoice[],
  client: JevClient | undefined,
): Promise<Routing> {
  if (!client || choices.length === 0) return fallback();
  try {
    const result = await client.systemOne({
      state: { subject: task.subject.slice(0, 400), task: task.task.slice(0, 8000) },
      questions: { level: ROUTE_QUESTION.level },
    });
    const answer = result.answers.level;
    const level = answer?.choice && (TASK_LEVELS as readonly string[]).includes(answer.choice)
      ? answer.choice as TaskLevel
      : undefined;
    const confidence = Number.isFinite(answer?.confidence) ? (answer?.confidence ?? 0) : 0;
    if (!level || confidence < ROUTE_MIN) return fallback();
    const wanted = modelFor(level, choices);
    return wanted ? { level, confidence, wanted, basis: 'routed' } : fallback();
  } catch {
    return fallback();
  }
}

export type PickInput = {
  textModels: readonly QaModel[];
  current: QaModel | undefined;
  override?: string;
  /** When true, route through Jev based on the mission. */
  routeEnabled: boolean;
  /** The QA mission text from the /qa command; absent means use the current model. */
  mission: string | undefined;
  store: SecretStore;
  env: NodeJS.ProcessEnv;
  settings: QaSettings;
  jevFactory?: JevFactory;
};

export type PickResult = { model: QaModel | undefined; routing?: Routing };

/** Pick the model the QA agent runs on. Routing is opt-in and falls back to the current model. */
export async function pickQaModel(input: PickInput): Promise<PickResult> {
  const current = selectQaModel(input.textModels, input.current, input.override);
  if (!input.routeEnabled || !input.mission || !current) {
    return { model: current, routing: undefined };
  }
  const ranked = [...input.textModels].sort(byCost);
  const client = await clientFor(input);
  const choices = ranked.map(m => ({ provider: m.provider, modelId: m.id }));
  const routing = await routeFor({ subject: input.mission.slice(0, 400), task: input.mission.slice(0, 8000) }, choices, client);
  if (routing.basis !== 'routed' || !routing.wanted) return { model: current, routing };
  const routed = ranked.find(m => m.id === routing.wanted);
  return { model: routed ?? current, routing };
}

const byCost = (a: QaModel, b: QaModel): number =>
  (a.cost.input + a.cost.output) - (b.cost.input + b.cost.output) || a.id.localeCompare(b.id);

const clientFor = async (input: PickInput): Promise<JevClient | undefined> => {
  if (!input.jevFactory) return undefined;
  const resolved = await resolveKey(input.store, input.env).catch(() => ({ key: undefined }));
  if (!resolved.key) return undefined;
  return input.jevFactory(resolved.key, input.settings);
};