# Changelog

## 0.7.5 — 2026-10-06

- Evaluate execution evidence with the selected Pi model and inherited reasoning through the public SDK. Reuse parent providers; remove automatic TypeSafe routing and credential requirements.

## Unreleased

- QA runs on the session's model and thinking level instead of the smallest available model with thinking off. `qaModel` still overrides the model.
- A non-English mission is rewritten by the session's own model, not the cheapest reachable one.

## 0.7.3

- Fix isolated workspaces breaking every `node_modules/.bin` tool (vite, eslint, tsc…): links inside a dependency tree are now kept as relative links instead of being copied as files, so a tool finds its own files. pnpm stores inside `node_modules` keep their layout too. Links that leave the tree are still copied, never linked back to the checkout.
- Clone dependency files copy-on-write where the filesystem supports it (APFS), so copying `node_modules` is fast and takes no extra disk.
- Verify `.bin` shims after the copy; when the copy is too large, fails, or a shim does not survive it, install from the project's lockfile (`pnpm install --frozen-lockfile`, `bun install`, `yarn install --frozen-lockfile` or `npm ci`) inside the workspace, and say which path was taken.

## 0.7.2

- Change clipboard output into a compact agent handoff containing only FAIL/BLOCKED test cases.
- Omit PASS cases, inferred criteria, evaluator credentials, global artifact lists, and full successful outputs from copied context.
- Include short host-output tails, hashes, exact blockers, unknown receipt IDs, full-report path, and the next action.
- Keep a test case valid when it cites at least one known host receipt; unknown extra IDs become warnings for Jev instead of invalidating all evidence.

## 0.7.1

- Replace the custom setup overlay with the reusable docked `openSecretPrompt` from `pi-tui-kit` 0.2.0.
- Keep secret masking, inline validation, Enter/Esc behavior, and theme styling in the shared UI kit.
- Remove popup-specific UI code from pi-qa.

## 0.7.0

- Keep the single Jev client embedded in the extension; remove the localhost setup server and browser flow completely.
- Capture the global key through a masked Pi `ctx.ui.custom` prompt, validate it through embedded Jev, store it in the OS keyring, and continue the original command.
- Keep isolation only for QA agent sessions/workspaces so they do not inherit emitter context.
- Materialize declared relative local dependencies as isolated siblings for faithful package-manager behavior.
- Let the one strict Jev batch evaluate whether multiple real receipts support each test case.

## 0.6.2

- Preflight the required global evaluator before spending a QA model run; TUI starts one-time setup immediately when missing.
- Materialize relative local dependencies declared by package-lock/package manifests as isolated sibling packages so `npm ci` remains faithful.
- Let Jev judge whether multiple real receipts support a test case instead of requiring the agent's procedure summary to equal one bash command.
- Clean materialized sibling dependencies after the run.

## 0.6.1

- Stream QA tool activity, evaluation, and artifact-persistence phases into the live panel.
- Preserve a short visible activity history so long-running commands never look frozen.
- Pass bounded pi-memory, plan, ticket, and workspace context to the QA agent as untrusted environment briefing.
- Dereference linked dependencies into the isolated workspace instead of preserving broken relative symlinks.
- Explain BLOCKED as missing global evaluator credentials, evaluator error, or incomplete evidence with the correct next action.

## 0.6.0

- Make Jev the sole evaluator after the QA agent finishes collecting evidence.
- Replace request-per-test/criterion fan-out with one bounded `systemOne` batch request containing all test cases and requirements.
- Remove deterministic PASS/FAIL fallback; local code validates provenance only.
- Persist one Jev decision per test case and requirement while keeping evaluator internals out of the TUI.

## 0.5.0

- Select the smallest text model from Pi's client-scoped available model list instead of inheriting the frontier model.
- Add optional global `qaModel` override and keep extended thinking off.
- Evaluate objective test cases deterministically when Jev is unavailable; verified nonzero exits are FAIL, not globally BLOCKED.
- Remove the unpublished `PanelActivation` dependency so clean CI installs compile against the declared pi-tui-kit revision.
- Update architecture documentation to the single QA-agent design.

## 0.4.0

- Replace reviewer + tester with one isolated QA agent focused exclusively on test cases.
- Require every usable case to have sourced expected behavior and verified execution receipts.
- Treat missing or merely inferred expectations as BLOCKED, never PASS.
- Reduce the TUI to test cases, status, expected behavior, procedure, observation, and host evidence.
- Keep Jev internal as the evidence evaluator; remove reviewer findings from verdict logic.

## 0.3.2

- Fix critical keyring adapter bug that stored the account name instead of the TypeSafe secret.
- Store one global TypeSafe credential under `ai.typesafe` / `api-key` for all projects.
- Migrate valid legacy credentials and discard the known corrupted `typesafe-api-key` sentinel.
- Add adapter-level regression tests for argument order and migration.

## 0.3.1

- Resolve “this extension” / “esta extensión” missions automatically to the pi-qa source or installed build.
- Report credential source and fingerprint with Jev failures.
- Never recommend re-evaluating an empty target snapshot.

## 0.3.0

- Add `/qa --target <path> <mission>` for immutable local file/directory QA, including non-Git targets.
- Exclude dependencies, Git metadata, `.env*`, private keys, certificates, and previous QA exports from filesystem target capture.
- Persist explicit target roots in snapshot fingerprints so reevaluation detects real target changes.
- Correct copied prompts: a cited receipt is not labeled verified when the deterministic provenance check failed or the test was skipped.

## 0.2.2

- Add `Copy result as prompt`: sanitized clipboard output with host receipts, outputs, Jev diagnostics, artifacts, and key fingerprint.
- Show the non-secret TypeSafe key fingerprint and clear persisted verification after a server-side 401 without deleting the key.

## 0.2.1

- Bind tester claims to host-generated `bash` and `qa_browser` execution receipts; unverified reports cannot cover criteria or yield `PASS`.
- Give reviewer and tester separate workspaces derived from the same immutable snapshot.
- Return `NOT_VERIFIED` when a supported blocking finding has unresolved impact.
- Make `/qa cancel` and `/qa status` bypass the run queue.
- Preserve contract sanitization problems and avoid reusing unrelated historical user messages.
- Skip loopback/browser integration tests explicitly when the runtime sandbox lacks those capabilities.

## 0.2.0

- `/qa <mission>` is an agnostic QA agent for URLs, files, APIs, builds, tickets, deployed systems, and code changes; an explicit mission no longer requires a Git diff.
- The TUI opens a live `pi-tui-kit` panel before work starts and tracks snapshot, independent reviewer, tester, Jev, evidence, and recommended next action.
- Added tester-only `qa_browser`: stateful Playwright against an installed Chrome/Chromium, textual DOM observations, screenshots, SHA-256 hashes, and trace artifacts.
- Agents collect evidence only. Jev separately evaluates finding support, blocking impact, failed-check cause, coverage, and criteria; deterministic code owns the verdict.
- A failing command without substantiated product evidence is `NOT_VERIFIED`, not an automatic product `FAIL`.
- Every run writes private Markdown, JSON, JUnit, and ticket-comment artifacts. The TUI can explicitly export, prepare a defect, comment a linked ticket through the main Pi MCP flow, resolve blockers, or rerun.
- TypeSafe key verification now persists with the key in the global OS keyring and survives rebuilds/reinstalls.

## 0.1.2

- Renamed the public command from `/pi-qa` to `/qa`; package name and persisted storage paths remain compatible.

## 0.1.1

- Fixed: `git archive` extraction now uses a binary-safe pipe; tar payloads with binary files are no longer corrupted.
- Fixed: `node_modules` and `vendor` are copied (budget-capped) instead of symlinked, so tester commands cannot mutate the user's checkout. `.venv` is never shared.
- Fixed: all `/pi-qa` actions are serialized in one queue, and keyring, intent, and evaluation errors surface as command errors instead of unhandled rejections.
- Consistency with pi-team: `output()` falls back to an RPC custom message plus transcript renderer when there is no TUI; session shutdown aborts and awaits agent completion before closing.
- `FAIL` now also covers any executed check that failed, even if Jev judged the assertion unrelated to a criterion.
- Re-evaluating a stale snapshot writes `report-eval.json` and preserves the original audited `report.json`.
- The fingerprint now covers the staged/unstaged split, so `git add` / `git restore --staged` after capture marks the run `STALE`.
- Contract reclassifications are recorded as `contractProblems` and shown in the report.
- Setup UI: session token no longer appears in the URL; CSP headers added.
- Review findings associate with criteria by token overlap instead of a fragile text-prefix match.

## 0.1.0

- `/pi-qa` captures a git snapshot of the current change, launches a reviewer and a tester, and scores evidence with Jev.
- `/pi-qa status`, `/pi-qa cancel`, `/pi-qa setup`, and `/pi-qa evaluate`.
- TypeSafe API keys live in the OS keyring. `TYPESAFE_API_KEY` is process-only.
