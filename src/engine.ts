/**
 * The QA engine: orchestration, agents, browser and snapshots. It is most of
 * this extension's code and none of it is needed until /qa runs, so the entry
 * loads it on first use. Pi transforms every file it loads on the first start
 * after a build; this kept 2.2 s out of that start.
 */
export { evaluateExisting, readLatest, runQa } from './orchestrate.ts';
export { loadIntent } from './context.ts';
