# Security

- TypeSafe API key and verification timestamp: one versioned record in the global OS keyring (`ai.typesafe` / `api-key`) for every project. Builds and installs do not touch it. The legacy pi-qa entry migrates automatically; the known corrupted account-name value is discarded. No file fallback.
- `TYPESAFE_API_KEY` is process env. It is not copied to the keyring.
- Setup uses the shared masked, docked `openSecretPrompt` from `pi-tui-kit`. It is not a popup. No browser or HTTP server is started.
- The key is validated by the Jev client embedded in the extension, then written directly to the global OS keyring.
- SDK `logLevel: 'off'` so request bodies (code excerpts) are not logged.
- Run records: `0700` directories, `0600` files, under `~/.prjct/pi-qa/runs/`.
- Reports omit credentials. Session custom entries store run id, verdict, fingerprint.
- Git: allowlisted read commands on the user checkout. Mutations only in the isolated worktree.
- Reviewer has no `bash` / `edit` / `write`. Tester `bash` is not a sandbox.
