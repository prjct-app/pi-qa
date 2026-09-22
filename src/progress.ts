import type { AgentOutcome, AgentRole, QaRunRecord } from './schema.ts';

export type QaProgressEvent =
  | { kind: 'stage'; stage: QaStage; message: string }
  | { kind: 'snapshot'; fingerprint: string; paths: number }
  | { kind: 'agent'; role: AgentRole; status: 'running' | AgentOutcome['status']; latencyMs?: number; error?: string }
  | { kind: 'jev'; status: 'running' | 'completed' | 'unavailable'; message: string }
  | { kind: 'complete'; record: QaRunRecord }
  | { kind: 'error'; message: string };

export type QaStage = 'starting' | 'capturing' | 'materializing' | 'agents' | 'staleness' | 'jev' | 'persisting' | 'complete' | 'failed';
export type LiveStatus = 'pending' | 'running' | 'completed' | 'failed' | 'canceled' | 'timed_out' | 'unavailable';

export type QaLiveState = {
  runId: string;
  mission: string;
  startedAt: number;
  stage: QaStage;
  message: string;
  snapshot?: { fingerprint: string; paths: number };
  agents: Record<AgentRole, { status: LiveStatus; latencyMs?: number; error?: string }>;
  jev: { status: LiveStatus; message?: string };
  record?: QaRunRecord;
  error?: string;
  activity: string[];
};

export type QaLiveModel = {
  state: QaLiveState;
  update: (event: QaProgressEvent) => void;
  subscribe: (changed: () => void) => () => void;
};

export const createQaLiveModel = (runId: string, mission: string): QaLiveModel => {
  const state: QaLiveState = {
    runId,
    mission,
    startedAt: Date.now(),
    stage: 'starting',
    message: 'Preparing QA run…',
    agents: { reviewer: { status: 'pending' }, tester: { status: 'pending' } },
    jev: { status: 'pending' },
    activity: ['Preparing QA run…'],
  };
  const listeners = new Set<() => void>();
  const notify = (): void => { for (const listener of listeners) listener(); };
  const update = (event: QaProgressEvent): void => {
    if (event.kind === 'stage') {
      state.stage = event.stage;
      state.message = event.message;
      state.activity = [...state.activity, event.message].slice(-8);
    } else if (event.kind === 'snapshot') state.snapshot = { fingerprint: event.fingerprint, paths: event.paths };
    else if (event.kind === 'agent') state.agents[event.role] = { status: event.status === 'timeout' ? 'timed_out' : event.status, latencyMs: event.latencyMs, error: event.error };
    else if (event.kind === 'jev') {
      state.stage = 'jev';
      state.message = event.status === 'running' ? 'Evaluating all test cases…' : event.message;
      state.jev = { status: event.status, message: event.message };
      state.activity = [...state.activity, state.message].slice(-8);
    }
    else if (event.kind === 'complete') {
      state.stage = 'complete';
      state.message = event.record.explanation;
      state.record = event.record;
    } else {
      state.stage = 'failed';
      state.message = event.message;
      state.error = event.message;
    }
    notify();
  };
  return {
    state,
    update,
    subscribe: changed => { listeners.add(changed); return () => listeners.delete(changed); },
  };
};
