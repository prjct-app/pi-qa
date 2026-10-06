# Security

- QA sessions and semantic evaluation use the selected model through Pi's public SDK and existing authentication.
- No auxiliary classifier credentials, setup prompt, or credential migration exists.
- Outbound SDK context and provider payloads use the pi-secrets privacy guard, including tool-discovered data.
- Tests use isolated Pi/prjct directories and reject native keychain access.
- Run records: `0700` directories, `0600` files, under `~/.prjct/pi-qa/runs/`.
- Reports omit credentials. Session custom entries store run id, verdict, fingerprint.
- Git: allowlisted read commands on the user checkout. Mutations only in the isolated worktree.
- Reviewer has no `bash` / `edit` / `write`. Tester `bash` is not a sandbox.
