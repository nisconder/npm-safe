## Summary

Describe the problem and the approach taken.

## Security Impact

Explain whether this changes detection behavior, command execution, network
access, file access, credential handling, or trust boundaries. Write "None" if
it does not.

## Validation

- [ ] Tests cover new or changed behavior.
- [ ] `pnpm -F @npm-safe/core exec tsc --noEmit` passes.
- [ ] `pnpm -F @npm-safe/core test` passes.
- [ ] User-facing behavior and scanner rules are documented.
- [ ] No secrets, generated databases, or local configuration files are included.

## Related Issues

Closes #
