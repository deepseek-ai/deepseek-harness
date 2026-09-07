# Agent Note: Splitting the credential store from the user environment layer

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-04-credentials-yaml-and-user-environment-layer.zh.md)

## Problem

`$DSH_HOME/.env` carried two incompatible jobs. It was the writable secret store of [`credentials-local`](../../../../packages/credentials/credentials-local/README.md), so no surface could hoist it into `process.env` — hoisting would make every stored key read as a read-only launch override and block rotation from the Models page. But its name and dotenv format promise an environment file, so users put non-secrets in it and those values reached nothing: a `DEEPSEEK_BASE_URL` beside a working `DEEPSEEK_API_KEY` in the same file was silently ignored, because only the credential provider read the document and it addresses credential references alone.

One file cannot be both a store the Harness owns and isolates and a layer that propagates by ordinary environment rules. The [request-level credential decision](2026-07-29-request-level-llm-config-credentials.md) chose dotenv to match peer products' home `.env`, and the conflation was not visible until a non-secret needed the same file.

## Decision

The two jobs become two files under the Harness home.

**`.credentials.yaml` is the provider-managed store.** A strict YAML mapping of `CredentialRef` to non-empty string, with no `version` field and no wrapper level:

```yaml
DEEPSEEK_API_KEY: sk-…
OPENAI_API_KEY: sk-…
```

Because the document holds credentials and nothing else, every deviation is a rejection rather than a skipped entry: a non-mapping root, a key that is not a POSIX identifier, a non-string value, an empty string, a duplicate key, and malformed YAML all fail — loud at boot and at a write, warn-and-keep-the-last-good-snapshot on a live reload. A silently ignored key would read as "the secret I stored has no effect", which is the failure this change exists to remove. The dotenv physical-line editor is replaced by a patch of the parsed document, so comments and untouched entries keep their formatting, any string value round-trips (multi-line included), and no entry is unwritable for want of a quoting style. The writer lock, read-modify-write, atomic `0600` write under a `0700` directory, exact-path watcher, content-equality self-write suppression, and quiescent disposal are unchanged.

**`$DSH_HOME/.env` is the user's ordinary environment layer.** `loadLayeredEnv` in [`dsh-app-boot`](../../../../packages/boot/app-boot/README.md) parses the invoking directory's `.env` and then the Harness home's, giving `user < project < inherited` by materializing each accepted value only when the process has no higher-layer value. The Harness home is resolved from the inherited environment *before* either file loads, so a project `.env` cannot redirect which user document is read. Only the product CLI layers these files; SDK and example bins keep loading their own directory through `loadEnv` and must not inherit a developer's `$DSH_HOME`.

Credential precedence distinguishes the inherited environment from discovered files: the inherited value stays the read-only per-run override, the managed document wins next, and project then user `.env` values remain writable fallbacks. A `set` therefore replaces a discovered-file value instead of rejecting a write that only the flattened `process.env` view would consider shadowed.

There is no migration. A key already in `$DSH_HOME/.env` keeps resolving as a fallback, while the managed document wins as soon as the Models page stores that reference.

## Consequences

- Given up: a key left in `$DSH_HOME/.env` is materialized into `process.env`, so it reaches subprocesses under the [subprocess credential scrub](../../../../packages/subprocess/subprocess/README.md) rather than staying inside the provider. It remains a writable fallback below `.credentials.yaml`; a secret the Harness should own and isolate belongs in the managed document, which is never materialized.
- Bought: a non-secret in the user's `.env` finally takes effect, which was the original defect; the document format can reject what it cannot serve; and `0600` covers a file that holds only secrets instead of a file users are told to put ordinary configuration in.
- The `0600` the provider writes is also enforced on what it reads: on POSIX, a document with any group or other permission bit fails the launch before its contents are read, at boot and on every reload, and the diagnostic names the `chmod 600` repair. Windows has no mode to inspect — its ACLs are not expressible here — so the check is skipped rather than faked.
- The `0600` boundary still stops other OS users and not the model, unchanged by this split — the [provider README](../../../../packages/credentials/credentials-local/README.md) owns that limit and the keychain-provider deferral.

## Alternatives considered

**Keep one `$DSH_HOME/.env` and teach the CLI to hoist it.** Rejected: hoisting the store is precisely what makes stored keys unrotatable, which is why [app-boot documented the exclusion](../../../../packages/boot/app-boot/README.md) in the first place. The conflict is the file's two jobs, not the loader.

**`$DSH_HOME/.credentials.env` — a second dotenv file.** Rejected: dotenv suits an environment layer but cannot express "a managed document indexed by credential reference". It cannot reject a non-string or an unaddressable key, and its line editor already refused values it could not quote, leaving entries readable but unwritable.

**Add a `version` field to the new document.** Rejected: the format is one schema-constrained string mapping with no historical variant to discriminate. While the product is unreleased, changing the structure and rejecting the old one beats promising a migration protocol.

**Migrate credential-shaped keys out of `$DSH_HOME/.env` on first run.** Rejected: migration code turns a short-lived format into a long-lived maintenance surface, and classifying which keys in an unknown file are secrets is exactly the ambiguity this split removes. The old file keeps working as environment, which is a truthful outcome rather than a silent one.

**Drop the user `.env` layer entirely and keep only the inherited environment.** Rejected here as out of scope: it is a coherent design (fewer layers, one place per value), but it removes a workflow users have, and the layering question belongs with the deferred precedence decision rather than with this split.
