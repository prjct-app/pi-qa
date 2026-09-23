# @prjct.app/pi-qa

Pi QA agent for code changes, tickets, deployed systems, smoke tests, artifacts, and other explicit evaluation targets.

`/qa <mission>` launches one isolated QA agent that designs and executes test cases. Jev evaluates evidence internally. Results are `PASS`, `FAIL`, `NOT_VERIFIED`, or `STALE`.

## Install

For the published package, add it to Pi and restart:

```json
{ "packages": ["@prjct.app/pi-qa"] }
```

For the local checkout used by this workspace:

```sh
cd /Users/jj/Apps/pi
./install-local.sh pi-qa
```

The script builds `~/.pi/agent/builds/pi-qa`; add `builds/pi-qa` to the Pi package list (or use the existing local settings) and restart Pi.

## Commands

| Command | Action |
|---|---|
| `/qa <mission>` | Evaluate an explicit target, for example `/qa smoke test https://app.example.com/login` |
| `/qa --target <path> <mission>` | Capture and evaluate an explicit local file or directory, including non-Git targets |
| `/qa` | Derive the mission from the current Pi request or current diff |
| `/qa --base <ref>` | Add a local Git comparison base. Remotes are not fetched |
| `/qa status` | Active or last run |
| `/qa cancel` | Abort the active run; keep partial evidence |
| `/qa setup` | Masked global TypeSafe key prompt inside Pi |
| `/qa evaluate [runId]` | Re-score an unchanged snapshot after configuring Jev. Agents are not rerun |

The TUI shows only test cases: expected behavior, source, status, procedure, observation, and host receipts. While QA runs, it streams the current tool/command, evaluation phase, elapsed time, and a short activity history so the UI never appears frozen. Jev, snapshots, agents, tokens, and internal criteria are not UI concepts.

## What gets snapshotted

Staged changes, unstaged tracked changes, and untracked files. The run records base, HEAD, paths, content hashes, and a fingerprint.

If the working tree is clean, QA diffs unique commits against a local base (`--base`, existing `@{upstream}`, or local `main` / `master` / `develop`). It never fetches. If no trustworthy base exists, the report explains what to pass instead of claiming a clean pass.

Binary files, large files, symlinks, and submodules are listed as unsupported evidence. They are not silently dropped.

QA never runs destructive git commands against your checkout. The QA agent uses an isolated workspace. Declared relative local dependencies are copied as isolated siblings, so package-manager installs resolve the same topology without linking back to the checkout.

## Contract

Tickets are included only when the current request names a ticket number (for example, `/qa test ticket 07`) or an explicit `docs/tickets/<name>.md` path. The referenced file supplies acceptance criteria, DoR, and DoD. QA never reads `.pi/ticket.md` or copies it into a QA workspace; contracts and snapshots live under `~/.prjct/pi-qa/runs/<id>/`.

For local artifacts, use an explicit path: `/qa --target ./pi-qa smoke test this extension`. Dependencies, Git metadata, `.env*`, private keys, certificates, and prior QA exports are excluded from filesystem target capture.

The command text becomes a required `user_request` criterion. Without command text, QA uses the latest conversational entry only when it is actually from the user; a plan is considered only when no current user request exists. It never searches backward for an unrelated old request or implicitly loads a project ticket. Every item is `user_request`, `ticket`, `plan`, or `inferred_from_diff`; inferred items never prove unstated intent. Sanitization problems remain in the run record.

The main model may submit a contract with the `pi_qa_contract` tool before `/qa`. Relabeled inferred items are reclassified.

## QA agent

One isolated Pi session designs and executes the smallest relevant set of test cases. Every case records expected behavior, its source, procedure, observation, execution receipts, and artifacts. The agent receives captured changes and the explicitly selected ticket when available; other context is untrusted and must not override the requested task.

Expected behavior comes from the user, ticket, spec, or existing tests. A default smoke expectation is limited to successful load/launch, no crash, and a responding primary command or endpoint. If none is defensible, the case is `BLOCKED`; QA does not invent PASS.

Host wrappers around `bash` and `qa_browser` issue immutable execution receipts. Agent-written output without a matching receipt is not evidence. Playwright can capture DOM text, screenshots, hashes, and traces.

The QA session reuses the current Pi model authentication. No extra model API key is needed.

## Jev

Jev is the sole evaluator. It does not appear in the TUI, write test cases, pick commands, or decide the workflow. After the QA agent finishes, pi-qa sends one bounded `systemOne` request containing every provenance-verified test case and requirement. Jev returns `supports` / `contradicts` / `insufficient_evidence` for the whole batch.

Default model pin: `jev-1.13.0` (`prjct-qa.json` → `jevModel`). There is no deterministic verdict fallback: missing credentials, low confidence, or timeout leaves cases `BLOCKED`. Deterministic code validates receipts before the single Jev request.

After `/qa setup`, `/qa evaluate` scores the last snapshot if the fingerprint is unchanged.

## TypeSafe key

Jev is an optional evaluator, not a precondition. `/qa` checks for the global key before starting and, when it is missing in TUI, opens the shared docked `openSecretPrompt` from `pi-tui-kit`, validates the embedded Jev client, and stores one credential for every project in the global OS keyring (`ai.typesafe` / `api-key`). Declining the prompt does not cancel the command: the run still designs test cases and captures evidence, reports `NOT_VERIFIED`, and says so up front. `/qa evaluate <runId>` scores that snapshot once a key exists, without re-running the agents.

`/qa evaluate` is the one exception and still requires the key, because scoring a snapshot with Jev is the whole of what it does.

The credential store, the record format and the keyring account live in `pi-tui-kit`, so a key saved here is the same key `pi-memory` reads. No HTTP server or browser is started. The legacy pi-qa entry migrates automatically. There is no plaintext-file fallback.

`TYPESAFE_API_KEY` is valid for the process only and is not copied into the keyring.

The key is never placed in URLs, logs, session transcripts, git files, browser storage, or QA reports. TypeSafe SDK debug logging is off.

## Verdict

- **PASS** — every required behavior has a sourced expected result, verified execution evidence, and evaluator support.
- **FAIL** — a verified test case contradicts required behavior or demonstrates failure.
- **NOT_VERIFIED** — expected behavior, target, execution provenance, evidence, or internal evaluation is unavailable or uncertain.
- **STALE** — the worktree or ticket changed after capture.

A green command without a sourced expected result and matching receipt is `BLOCKED`, never `PASS`.

Reports are written under `~/.prjct/pi-qa/runs/<id>/` with mode `0700`. Every run includes `report.json` plus private `artifacts/report.md`, `test-results.json`, `junit.xml`, and `ticket-comment.md`; browser runs add screenshots and `trace.zip`.

Panel shortcut `p` copies a compact agent handoff containing only FAIL/BLOCKED cases; PASS cases and full outputs are omitted. Other shortcuts export/open artifacts, rerun, or cancel. Test cases remain the only list content.

## Settings

`~/.pi/agent/prjct-qa.json`:

```json
{
  "qaModel": "provider/optional-small-model",
  "jevModel": "jev-1.13.0",
  "confidenceThreshold": 0.8,
  "noulThreshold": 0.8,
  "timeoutMs": 600000,
  "jevTimeoutMs": 30000
}
```

`qaModel` is optional. Without it, QA chooses the smallest model from Pi's client-scoped available list. No secrets belong in this file.

## Limitations

- Tester `bash` is not a sandbox. Isolation is the extra worktree plus a prompt; a determined command could still touch the original tree.
- Dependency trees (`node_modules`, `vendor`) are copied into the isolated workspace, never linked, so tester writes cannot reach the user's checkout. Copies are capped at 60,000 files / 2 GiB; beyond the budget the tester must install dependencies itself.
- The current browser driver uses an installed Chrome, Chromium, or Edge through `playwright-core`; it does not download a browser. If none exists, browser coverage is `NOT_VERIFIED` with the missing capability.
- Screenshots are sent to the vision-capable tester and stored with SHA-256, but Jev accepts text only; every visual claim still requires a textual DOM/behavior observation.
- `pi-memory`, Linear, and Jira are optional. A memory entry is never proof that the current target passed.
- Calibrate thresholds against labeled examples before treating them as final.
- A failed command alone is not a product verdict. Without Jev-substantiated product evidence it remains `NOT_VERIFIED` and produces a diagnostic next action.
