# Agent Note: Keep shell-environment declarations focused on key ownership

Status: proposed

English | [中文](2026-09-19-shell-env-key-declarations.zh.md)

## Problem

The [shell-environment registry](../../../../packages/shell/shell-env/src/index.ts) requires a description for every declared variable and exposes `list()` to enumerate it. Runtime collection uses only contributor identity, declared keys, and resolved values. [Bash](../../../../packages/shell/tool-bash/src/index.ts) and [PowerShell](../../../../packages/shell/tool-pwsh/src/index.ts) call `collect`; the [Web bundle](../../../../packages/bundle/web-app/src/index.ts) contributes `DSH_WEB_URL`. Searches found no fixed production caller of `list()` or consumer of its descriptions.

The method is nevertheless discoverable through the [Cordis inspection provider](../../../../packages/extensions/tool-cordis/src/providers.ts), so this is an explicit API contraction, not unreachable-code removal. The [original identity-and-log-location record](../../archived/feature/2026-07-10-agent-session-identity-and-log-location.md) anticipated diagnostics and future prompt/UI consumers. The current TODO and [README limitation](../../../../packages/shell/shell-env/README.md) still describe an incomplete catalog that omits built-in variables.

## Proposal

Represent a contributor's declaration as an explicit readonly collection of keys. Remove description objects, `BashEnvVariable`, `BashEnvVariableInfo`, `list()`, description-only validation, and the exhaustive-catalog TODO. Update the Web contributor, README pair, and generated service/type declarations together.

Keep `register`, `collect`, reserved keys, ownership conflicts, undeclared-output refusal, deterministic environment output, and effect disposal. The [PowerShell parity decision](../../implemented/feature/2026-08-02-pwsh-tool-bash-parity.md) continues to own the shared registry and both shell consumers. The proposal removes one public method, two metadata types, and their validation/enumeration tests; roughly 32 identified source lines disappear before the small key-membership adaptation.

## Alternatives considered

**Finish the diagnostics catalog.** That would add built-in metadata and a consumer capability without an identified current product requirement. The proposal instead gives up declarative environment descriptions and enumeration; actual shell environment values remain available through execution.

**Keep descriptions after deleting `list()`.** Rejected because they would have no remaining reader while still burdening every contributor. Preserve the key ownership declaration independently of presentation metadata.

## Acceptance criteria

- Recheck fixed callers, recordings, generic inspection, and current product requirements before implementation; retain the API if an actual diagnostics consumer now needs it.
- Contributors declare keys without description objects. Duplicate names, reserved keys, cross-contributor conflicts, undeclared outputs, and disposal retain their behavior.
- Bash and PowerShell receive equivalent environment maps, including Web URL and Session identity; no secret-handling or ambient-environment policy changes.
- Run registry, Web contributor, and shell integration tests; regenerate and validate inspection catalogs and any affected recorded inspection output; update both READMEs and run typecheck, doc-sync, and lint.

## Risks

Model-written and external plugins can already discover and call `list()`. They lose enumeration without resolver execution and must change contributor declarations. This pre-stable API loss is acceptable only while the anticipated diagnostics capability remains unowned; `collect()` is not advertised as an equivalent diagnostic replacement.
