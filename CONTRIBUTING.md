# Contributing

Integration branch is `develop`. Open pull requests against `develop`.

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run check:package
```

Do not add `let` in `src/`. Do not store the TypeSafe key in files, logs, or reports. Automated tests must mock TypeSafe; do not make live paid API calls in CI.

Pi packages stay peer dependencies. Use public Pi 0.85.1 APIs only.
