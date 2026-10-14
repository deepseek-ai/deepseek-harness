# Agent Note: Stored credentials take precedence over the launch environment

Status: implemented

English | [中文](2026-10-09-stored-credential-precedence.zh.md)

The [headless environment authentication](2026-10-12-headless-environment-auth.md) decision partially supersedes this note's per-run override policy: the shipped headless profile omits the store. The ordering below remains the store's contract when mounted.

## Problem

[Configuration source ownership](2026-08-04-configuration-source-ownership.md) ranked the inherited process environment above `$DSH_HOME/.credentials.yaml`, and `credentials-local` refused `set` and `unset` for a name the launching shell exported. Two kinds of stored credential then had opposite precedence. pi-ai's resolvers read the credential record stored under `llm-pi-ai/<provider>` before any environment variable, so a stored OAuth grant or `api-key` record won over an exported key. A key that the Models page stored under a reference lost to the same exported name. Which credential a request used therefore depended on the provider family, and the Models page disabled its key field whenever the name was exported (#5527).

## Decision

**A stored credential wins for every provider.** `LocalCredentialProvider` resolves a reference in this order:

```text
$DSH_HOME/.credentials.yaml        (provider-managed, written by set/unset)
> inherited process environment    (fallback; the provider never writes it)
> <invocation cwd>/.env            (fallback; the provider never writes it)
> $DSH_HOME/.env                   (fallback; the provider never writes it)
```

A save always writes the winning layer, so `describe` reports `writable: true` for every reference, and `set` and `unset` never refuse a name because it is exported. `resolve` and `describe` still report the supplying layer as `source` (`file`, `env`, `project-env`, or `user-env`). `authContextFrom` in `llm-pi-ai` answers pi-ai's `env()` from the credential seam before the launch environment, so a pi-ai resolver reads its stored record first, then a stored reference, then the fallbacks in the order above.

The non-secret ordering and the environment restrictions in configuration source ownership are unchanged. This note supersedes only its credential ordering.

## Per-run overrides

The previous order existed so that CI, containers, and a one-shot `DEEPSEEK_API_KEY=… dsh` could override a credential without editing machine state. A fresh CI or container harness home has no `.credentials.yaml`, so its exported secret is still the effective value. A harness home holds a stored key only because someone saved it there, through the Models page or by editing the file. To use an exported value for that name, the user deletes the `refs` entry, or launches with a separate `DSH_HOME`.

## Alternatives considered

**Keep the launch environment on top.** It keeps per-run overrides without touching the store, but it keeps the opposite precedence of stored records and stored references, and the Models page cannot save or replace a key while the launching shell exports the name.

**Refuse a write while only the launch environment supplies the name.** Under the new order such a write takes effect, because the stored value outranks the environment. Refusing it would block the first save of a key for every exported name, and it would keep the read-only field state that the new order removes.

**Warn when a stored value hides an exported variable.** The provider would compare layers on every resolution and report the result for users who keep both values on purpose, such as a shell profile that exports a key for other tools. The Models page help text states the order, and `describe` reports the supplying layer.

## Consequences

- A key left in `.credentials.yaml` overrides an exported variable with the same name, including a CI secret on a machine whose harness home stores a value for that name. The [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-alpha.2/stored-credentials-precedence/guide.md) tells affected users how to keep the exported account.
- The Models page can always save, replace, or remove a key, and it does not disable the key field for an exported name.
- There is no per-run flag above the store. A one-run override takes a separate `DSH_HOME`.
- `packages/credentials/credentials-local/tests/local.spec.ts` covers a store over a launch environment value and its return after `unset`; `packages/llm/llm-pi-ai/tests/auth.spec.ts` covers a stored credential that wins over every launch layer.
