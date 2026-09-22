# Architecture

`/qa` captures a target, creates one isolated workspace, and launches one QA agent using the smallest available client model.

```
/qa <mission>
  → immutable target snapshot
  → expected behavior from user | ticket | spec | existing test | smoke default
  → isolated QA agent
  → test cases + host execution receipts
  → one Jev batch evaluation after all evidence is collected
  → PASS | FAIL | NOT_VERIFIED | STALE
```

## Test cases

A usable case needs expected behavior, its source, a procedure, and host evidence. Expected behavior is resolved in this order:

1. user request;
2. ticket;
3. spec or documentation;
4. existing test;
5. minimal smoke defaults: load/launch, no crash, primary command or endpoint responds.

Missing or merely inferred expected behavior is `BLOCKED`, never `PASS`.

## Snapshot and workspace

`src/snapshot.ts` captures Git changes or an explicit filesystem target. Files are hashed and copied into an isolated workspace; `.git`, dependencies, environment files, keys, and certificates are excluded from filesystem capture. A changed fingerprint makes the run `STALE`.

Dependency trees (`node_modules`, `vendor`) are copied into the workspace, never linked back to the checkout. Links inside a tree stay relative links, so `.bin` shims and pnpm stores keep working; links that leave the tree are copied. Files are cloned copy-on-write where supported. If the copy exceeds its budget, fails, or leaves a broken `.bin` shim, the workspace installs from the project's lockfile instead, and the QA agent is told which path was taken.

## QA agent

`src/runner.ts` creates one extension-free Pi SDK session. Model selection uses the client's scoped/available model list and prefers the smallest tier; `qaModel` can override it. Extended thinking is disabled.

`bash` and `qa_browser` are host-wrapped. Every execution receives an immutable receipt containing the command, exit status, bounded output, timestamps, and hashes. Agent-written command/output without a matching receipt is not evidence.

## Evaluation

Deterministic code validates expected-source and host-receipt provenance. It does not issue PASS or FAIL. After the QA agent finishes, one bounded Jev `systemOne` request evaluates all valid test cases and requirements together. There is no request-per-test fan-out and no deterministic verdict fallback. Jev remains internal and is not shown in the TUI.

The TUI lists test cases only: status, expected behavior, source, procedure, observation, and receipts.

## Credentials

The TypeSafe key is one global OS-keyring record (`ai.typesafe` / `api-key`) shared by every project. No plaintext fallback exists.
