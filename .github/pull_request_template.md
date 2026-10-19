## Summary

## Official Pi API compliance

- [ ] Uses only APIs documented by Pi 0.85.1
- [ ] Exposes exactly one Pi extension entry point
- [ ] No internal `dist/` imports or prototype patches
- [ ] Pi-provided packages remain peer dependencies

## Safety and provenance

- [ ] No credentials, conversations, private paths, or user configuration
- [ ] Required licenses and provenance notices are included

## Verification

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm pack --dry-run`

## Limitations and manual verification
