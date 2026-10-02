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

## Runtime security audit

CI audits an isolated installation of the package’s normal and optional runtime dependencies, with host peers suppressed exactly as in `pi install`. Development tools and the Pi-supplied SDK are outside this package’s audit boundary. Installation or audit findings in the package’s own runtime graph still fail CI.

The Pi 1.0.0 development host currently pins a vulnerable `brace-expansion` through its shrinkwrap. Track that upstream host limitation separately; passing this package audit does not claim that the host is vulnerability-free.
