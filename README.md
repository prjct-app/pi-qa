# @prjct.app/pi-qa

[![pi-qa — for PI Agent](https://raw.githubusercontent.com/prjct-app/pi-qa/main/docs/cover.png)](https://pi.dev)

Pi QA agent for code changes, tickets, deployed systems, smoke tests, artifacts, and other explicit evaluation targets.

`/qa <mission>` launches one isolated QA agent that designs and executes test cases. Jev evaluates evidence internally. Results are `PASS`, `FAIL`, `NOT_VERIFIED`, or `STALE`.

## Install

Install the published package and reload Pi:

```sh
pi install npm:@prjct.app/pi-qa
```

For a project-only installation, add `--local`.

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

Tickets resolve from an explicit ID or Markdown path, the active task exchange, or the current feature branch. `/qa PRJ-T315` finds matching documents under local or sibling `docs`, `project`, and `tickets` directories, including `docs/project/work/tasks`; legacy `ticket 07` references still work. Missing or ambiguous references block the run. The document supplies AC, DoR and DoD and is fingerprinted for staleness. Ambient `.pi/ticket.md` files and symbolic links are excluded.

For local artifacts, use an explicit path: `/qa --target ./pi-qa smoke test this extension`. Dependencies, Git metadata, `.env*`, private keys, certificates, and prior QA exports are excluded from filesystem target capture.

The command text becomes a required `user_request` criterion. Without it, QA retains the latest actual user request after assistant/tool messages. Generic testing follow-ups also consider the immediately preceding task exchange; older unrelated exchanges and tool results are ignored. Every item is `user_request`, `ticket`, `plan`, or `inferred_from_diff`; inferred items never prove unstated intent.

The main model may submit a contract with the `pi_qa_contract` tool before `/qa`. Relabeled inferred items are reclassified.

## QA agent

One isolated Pi session performs behavioral QA, not code review. It exercises browser journeys for web applications, real endpoint requests and regression scenarios for backends, or the public interface of non-web products. Developer checks (unit tests, typecheck, lint and builds) are supplemental and cannot alone yield PASS. Missing runtime access is a blocker, not permission to substitute code inspection.

Instructions and agent reports are in English. Source requests and ticket quotes remain verbatim; there is no separate translation-model call. QA tests the captured branch and worktree; base refs are comparison points, not merge targets. Every case records expected behavior, its source, procedure, observation, receipts and artifacts.

Expected behavior comes from the user, ticket, spec, or existing tests. A default smoke expectation is limited to successful load/launch, no crash, and a responding primary command or endpoint. If none is defensible, the case is `BLOCKED`; QA does not invent PASS.

Host wrappers around `bash` and `qa_browser` issue immutable execution receipts. Agent-written output without a matching receipt is not evidence. Playwright can capture DOM text, screenshots, hashes, and traces.

### WebMCP

`qa_browser` launches Chrome with WebMCP on (`--enable-features=WebMCPTesting`, Chrome 149+; the Playwright Chromium qualifies). When the page under test registers [WebMCP](https://webmachinelearning.github.io/webmcp/) tools on `document.modelContext`, the QA agent can use them next to clicks:

- `tools` lists the tools the open page registers (name, description, input schema, annotations such as `readOnly` or `consequential`) and saves that manifest as a hashed artifact.
- `call_tool` runs one tool by `name` with `input` as JSON object text. It reports the tool's output, whether it threw, how the input compares to the tool's schema, whether the page text changed, and the page afterwards.

The agent drives state through tools but confirms every effect in the page text or a screenshot, never from tool output alone. It also tests the tools: registration, descriptions and schemas, the happy path, missing or mistyped input (Chrome does not validate inputs against the schema, so the page must), and read-only tools leaving the page unchanged. A tool that throws is an observation with a completed receipt, so negative cases have evidence; a tool the page never registered fails the call. Chrome reports a throwing tool as `UnknownError: Tool was executed but the invocation failed`, without the page's own message. Pages without WebMCP tools are tested with open, click, fill and press as before.

### MCP Apps

`qa_browser` is also a test host for [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) (the MCP UI extension, formerly MCP-UI): servers whose tools declare a `ui://` resource that Claude, ChatGPT and other hosts render as an interactive view.

- `app_connect` starts a stdio MCP server (`command` and `args`, run in the QA workspace) or connects to a streamable HTTP `url`. The client advertises the `io.modelcontextprotocol/ui` extension.
- `app_tools` lists the server's tools with their `ui://` resource and visibility, and saves the list as a hashed artifact.
- `app_open` calls a tool by `name` with `input`, reads its UI resource, and renders it in a sandboxed iframe (`allow-scripts allow-forms`) with the CSP a spec-following host derives from the resource's `_meta.ui.csp`. The official `AppBridge` runs in Node: it completes `ui/initialize`, sends the tool input and result, and relays the app's `tools/call` and resource reads to the server. The served HTML is saved as evidence.
- After `app_open`, `click`, `fill`, `press`, `snapshot` and `screenshot` act inside the app until the next `open` or `app_open`.
- `app_log` shows every message between app and host, chat messages, link and display-mode requests, model-context updates, CSP violations, console errors, and the server's stderr.

A missing handshake within 10 seconds, a tool without a UI, or an unknown tool fails the call.

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
  "qaModel": "provider/model-id",
  "jevModel": "jev-1.13.0",
  "confidenceThreshold": 0.8,
  "noulThreshold": 0.8,
  "timeoutMs": 600000,
  "jevTimeoutMs": 30000
}
```

`qaModel` is optional. Without it, QA runs on the model and thinking level of the session that started it. No secrets belong in this file.

## Limitations

- Tester `bash` is not a sandbox. Isolation is the extra worktree plus a prompt; a determined command could still touch the original tree.
- Dependency trees (`node_modules`, `vendor`) are copied into the isolated workspace, never linked, so tester writes cannot reach the user's checkout. Copies are capped at 60,000 files / 2 GiB; beyond the budget the tester must install dependencies itself.
- The current browser driver uses an installed Chrome, Chromium, or Edge through `playwright-core`; it does not download a browser. If none exists, browser coverage is `NOT_VERIFIED` with the missing capability.
- Screenshots are sent to the vision-capable tester and stored with SHA-256, but Jev accepts text only; every visual claim still requires a textual DOM/behavior observation.
- `pi-memory`, Linear, and Jira are optional. A memory entry is never proof that the current target passed.
- Calibrate thresholds against labeled examples before treating them as final.
- A failed command alone is not a product verdict. Without Jev-substantiated product evidence it remains `NOT_VERIFIED` and produces a diagnostic next action.
