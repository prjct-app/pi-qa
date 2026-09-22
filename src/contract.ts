import { checkContract, emptyContract, type CriterionSource, type EvaluationContract, type ContractItem } from './schema.ts';
import { sha256Hex } from './text.ts';

export type IntentContext = {
  /** `english` is what agents read; `text` stays the verbatim source that provenance is checked against. */
  userRequest?: { text: string; ref: string; english?: string };
  plan?: { text: string; items: string[]; ref: string; englishItems?: string[] };
  ticket?: { text: string; dor: string[]; dod: string[]; ac: string[]; ref: string; fingerprint: string };
  memory?: { text: string; ref: string };
};

const INFERRED = 'inferred_from_diff' as const;

/** Validate a model-supplied contract and reclassify inferred items that were relabeled as user requirements. */
export function sanitizeContract(raw: unknown, intent: IntentContext): { contract: EvaluationContract; problems: string[] } {
  if (!checkContract(raw)) {
    return { contract: emptyContract(), problems: ['Contract failed schema validation.'] };
  }
  const problems: string[] = [];
  const items = raw.items.map(item => {
    const next = reclassify(item, intent);
    if (next.source !== item.source) {
      problems.push(`Item ${item.id} was reclassified to ${INFERRED}: its claimed ${item.source} source text is not present in the current session context.`);
    }
    return next;
  });
  const ids = new Set<string>();
  const unique = items.map((item, index) => {
    const id = ids.has(item.id) ? `${item.id}-${index + 1}` : item.id;
    ids.add(id);
    return { ...item, id };
  });
  return {
    contract: {
      ...raw,
      items: unique,
      ticketRef: raw.ticketRef ?? intent.ticket?.ref,
      ticketFingerprint: raw.ticketFingerprint ?? intent.ticket?.fingerprint,
    },
    problems,
  };
}

export function deriveContract(intent: IntentContext, changedPaths: string[], description?: string): EvaluationContract {
  const fromUser = intent.userRequest ? [item('U1', intent.userRequest.english ?? intent.userRequest.text, 'user_request', intent.userRequest.ref, intent.userRequest.text, true, 'Exercise or observe the requested behavior against the target and available evidence.')] : [];
  const fromPlan = (intent.plan?.items ?? []).map((text, index) =>
    item(`P${index + 1}`, intent.plan!.englishItems?.[index] ?? text, 'plan', intent.plan!.ref, text, true, 'Run or observe the plan item against the snapshot.'));
  const fromTicket = [
    ...(intent.ticket?.ac ?? []).map((text, index) => item(`T-AC${index + 1}`, text, 'ticket', intent.ticket!.ref, text, true, 'Assert the acceptance criterion.')),
    ...(intent.ticket?.dor ?? []).map((text, index) => item(`T-DOR${index + 1}`, text, 'ticket', intent.ticket!.ref, text, false, 'Record whether Definition of Ready still holds.')),
    ...(intent.ticket?.dod ?? []).map((text, index) => item(`T-DOD${index + 1}`, text, 'ticket', intent.ticket!.ref, text, true, 'Assert the Definition of Done item.')),
  ];
  const inferred = fromUser.length + fromPlan.length + fromTicket.length === 0
    ? changedPaths.slice(0, 12).map((path, index) => item(
      `I${index + 1}`,
      `The change to ${path} behaves as the diff implements it and does not introduce an obvious regression.`,
      INFERRED,
      path,
      undefined,
      false,
      `Inspect ${path} and run a check that would fail if the new behavior is broken.`,
    ))
    : changedPaths.slice(0, 8).map((path, index) => item(
      `I${index + 1}`,
      `Inferred: ${path} should not regress adjacent behavior.`,
      INFERRED,
      path,
      undefined,
      false,
      `Look for a test or invariant covering ${path}.`,
    ));
  return {
    description: description
      ?? intent.userRequest?.english
      ?? intent.userRequest?.text
      ?? intent.ticket?.text
      ?? intent.plan?.text
      ?? (changedPaths.length ? `Inspect the current diff (${changedPaths.length} path(s)).` : 'No written intent and no diff to evaluate.'),
    items: [...fromUser, ...fromPlan, ...fromTicket, ...inferred],
    invariants: [],
    regressionRisks: inferred.map(entry => entry.text),
    definitionOfReady: intent.ticket?.dor ?? [],
    definitionOfDone: intent.ticket?.dod ?? [],
    ticketRef: intent.ticket?.ref,
    ticketFingerprint: intent.ticket?.fingerprint,
  };
}

export function ticketStale(contract: EvaluationContract, current?: string): boolean {
  if (!contract.ticketFingerprint || !current) return false;
  return contract.ticketFingerprint !== current;
}

export const fingerprintText = (text: string): string => sha256Hex(text);

const item = (id: string, text: string, source: CriterionSource, sourceRef: string, sourceText: string | undefined, required: boolean, observe: string): ContractItem => ({
  id, text: clipItem(text), source, sourceRef, sourceText: sourceText ? clipItem(sourceText) : undefined, required, observe: clipItem(observe),
});

const clipItem = (text: string): string => text.length > 4000 ? `${text.slice(0, 3985)}…` : text;

const reclassify = (entry: ContractItem, intent: IntentContext): ContractItem => {
  if (entry.source !== 'user_request' && entry.source !== 'ticket' && entry.source !== 'plan') return { ...entry, required: entry.source === INFERRED ? false : entry.required };
  const haystack = entry.source === 'user_request' ? intent.userRequest?.text ?? ''
    : entry.source === 'plan' ? `${intent.plan?.text ?? ''}\n${(intent.plan?.items ?? []).join('\n')}`
      : intent.ticket?.text ?? '';
  const matched = haystack.includes(entry.sourceText ?? entry.text) || (entry.sourceText ? haystack.includes(entry.sourceText) : false);
  if (matched) return entry;
  return { ...entry, source: INFERRED, required: false, sourceRef: entry.sourceRef || 'reclassified' };
};
