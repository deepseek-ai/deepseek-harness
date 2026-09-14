---
description: "The credential seam for users and maintainers resolving, describing, or storing credentials — reference values and durable records — without putting secret values in configuration."
kind: "package-reference"
---

# @deepseek-ai/dsh-credentials

English | [中文](README.zh.md)

## Summary

`dsh-credentials` keeps secret values out of configuration by letting settings and `cordis.yml` refer to key names such as `DEEPSEEK_API_KEY`. It also stores durable per-plugin credential records, including authorization grants and provider environment values. A rotated stored key applies to the next request without a restart or configuration edit. Configuration UIs can report whether a key or record is set, its source, and whether it is writable without exposing values. Empty key values count as absent, while an empty record remains a deliberate stored credential.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

This package is the part of the product that stores and looks up secret values: store a key once, reference it by name everywhere, and read, check, or remove it at any time. It also keeps durable credential records, so a plugin can store, update, and remove the credentials it holds for its own ids. The product's default composition already includes a credential store; a custom composition loads the local store package with a file path.

### When to use it

Use a credential store whenever configuration must stay free of secret values: settings files that are synced, shared, or rendered in a configuration UI, or teams that rotate keys without editing configuration. Use records when a plugin must keep credentials with no single environment variable — an authorization grant from a sign-in flow, or provider environment values — and when a configuration UI should list what a user is authorized for. A configuration UI can show whether a key or record is set, where it comes from, and whether you can change it — never the value itself. If you only need one fixed environment variable, read that variable directly and skip the store.

### Adding it to your composition

Load the local store package with a document path:

```yaml
- name: '@deepseek-ai/dsh-credentials-local'
  config:
    path: /absolute/path/to/.credentials.yaml
```

The local store README owns the full configuration surface; the generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-credentials-local) is the exhaustive field list.

### Storing, checking, and removing keys

```ts
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

declare const ctx: Context

const ref = credentialRef('DEEPSEEK_API_KEY')          // POSIX shell identifier, branded
const hit = await ctx.credentials.resolve(ref)         // { value, source } | undefined
const info = await ctx.credentials.describe(ref)       // { configured, source?, writable } — never the value
await ctx.credentials.set(ref, 'sk-…')                 // rejects while a read-only source shadows the ref
await ctx.credentials.unset(ref)                       // no-op when absent; same shadowing rule
```

Store a key with `set`, remove it with `unset`, check its status with `describe`, and read the current value with `resolve` when an operation needs it. `describe` reports whether the key is set, where it comes from, and whether you can write to it — it never returns the value.

### Storing, updating, and removing records

A plugin addresses each record by `<scope>/<id>` — its own registered name plus an id it chooses, such as a provider route key — and reads, modifies, or removes what it holds:

```ts
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'

declare const ctx: Context

const key = credentialKey('llm-pi-ai', 'openai-codex')   // <owner>/<id>, branded
const hit = await ctx.credentials.readRecord(key)        // CredentialRecord | undefined
await ctx.credentials.describeRecord(key)                // { configured, kind?, writable } — never the value
await ctx.credentials.listRecords()                      // [{ key, kind }] — never values
await ctx.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: { token: '…' } }))
await ctx.credentials.deleteRecord(key)                  // no-op when absent
```

`modifyRecord` is the only write path: it hands your mutation the record as it stands at the moment the write is exclusive, and returning `undefined` leaves the entry untouched. Records have no empty-value rule — a record carrying neither a key nor environment values states that its owner confirmed ambient authentication — and a configuration UI can enumerate every record to show what you are authorized for and find records a removed plugin left behind.

### Using a key in configuration

A settings section or `cordis.yml` entry names a key instead of containing it — an LLM adapter, for example, takes `apiKeyEnv`:

```yaml
apiKeyEnv: DEEPSEEK_API_KEY
```

Requests that need the key use its current stored value, so rotating the key takes effect on the very next request — no restart and no configuration edit.

### What can go wrong

- **A key the launching environment supplies cannot be overwritten** — `DEEPSEEK_API_KEY=… dsh` (or a CI secret, a container `-e`) wins for this run and is reported read-only; clear the variable in the launching shell before storing a different value.
- **An empty value cannot be stored** — storing an empty string is refused; remove the key instead.
- **Key values never appear in configuration UIs or diagnostics** — the UI shows whether a key is set, where it comes from, and whether you can change it; the value itself stays in the store.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the package and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

One doctrine and four consequences:

- **Configuration carries references, never secrets.** A settings section or `cordis.yml` entry names a credential; the value behind the reference lives with a provider. The settings document stays safe to sync and to render, `describe()` answers without holding a value, and rotating a secret touches no configuration file.
- **Consumers resolve per operation.** Resolution is a per-call read with no cross-operation cache; that read is the hot-update mechanism.
- **An empty stored value is absent.** `resolve` skips it, `describe` reports it unconfigured — a blank can never masquerade as a configured secret.
- **Records are durable, and presence is the fact.** A record is stored per `<scope>/<id>` and survives restarts; the empty-value rule does not apply, so an `api-key` record carrying neither a key nor environment values is a deliberate statement, not a blank.
- **Listener failures are contained.** `notifyUpdated` fans `credentials/reference-updated` out so every listener runs; a sync throw or async rejection is logged without changing the committed operation's outcome, except `INVARIANT`-coded failures, which rethrow after every listener ran.

### The credentials/reference-updated event

`credentials/reference-updated (ref)` fires after a committed change to a provider-managed source — a `set`, an `unset`, or an external edit observed in storage. Ambient process-environment changes are not observable and never emit. Consumers do not need the event (they re-resolve per operation); it exists for configuration UIs refreshing a "configured" badge.

`credentials/record-updated (key)` fires after a committed change to a stored record — a `modifyRecord` that wrote, a `deleteRecord` that removed, or an external edit observed in storage. It stays a separate event because the two key grammars are disjoint: a listener receiving both spaces on one event could not tell which one a subject belongs to.

### Record write and read paths

`modifyRecord` is the only record write path because a correct write depends on the current value: a token refresh is read-decide-replace, and the mutation sees the record as it stands at the moment the write is exclusive — returning `undefined` leaves the entry untouched. Exclusion holds across processes where the backing store supports it, which is what stops two processes rotating one refresh token from losing whichever wrote first. Reads mirror the reference half but never layer: nothing can shadow a record, and a `grant` payload is returned exactly as its owner wrote it, because only the owning plugin can interpret it.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service Definition: the `credentialRef`/`credentialKey` brands, `ResolvedCredential`/`CredentialRecordInfo`, the abstract provider over both key spaces, contained fan-out |
| [`src/types.ts`](src/types.ts) | Client-safe type surface: the `CredentialRef` and `CredentialKey` brands, the stored-record union, the `CredentialInfo` reference view, the `credentials/reference-updated` and `credentials/record-updated` declarations |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: `credentials/reference-updated` only fires while a credentials service is live |

### Client-safe types

The `./types` subpath export holds the event declarations together with the `CredentialRef` and `CredentialKey` brands, the stored-record union they name, and the `CredentialInfo` reference view a configuration surface reads, and the package root re-exports them. A consumer outside the Host compilation face therefore reads the very signature the Host emits instead of restating it.

### Lifecycle

The service is a Cordis `Service` registered by the provider: disposing the mounting fiber removes `ctx.credentials`. The invariant companion checks that `credentials/reference-updated` never fires without a live service — an emission after disposal means a provider leaked work past its teardown quiescence.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared subsystem vocabulary to the shipped store and the capability architecture.

- [Credentials subsystem reference](../../../docs/subsystems/credentials.md) — `CredentialRef`/`CredentialKey`, per-operation resolution, UI-safe info, provider layers, and the generated Cordis surface.
- [Local credentials store](../credentials-local/README.md) — the default on-machine store: where keys and records live and how the environment layers rank.
- [Capability seams](../../../docs/capability-seams.md) — the Service Definition / Service Provider / Consumer split this package follows.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the consuming adapter, which resolves each credential reference and owns every model-facing use a value authorizes.

#### KV Cache effect

No direct invalidation; resolved values never enter a request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this package is a poor fit or needs special care. They are current package constraints, not a task backlog.

- **References have no enumeration** — the seam answers questions about references it is given; configuration surfaces learn them from settings schemas, so a `list()` over that half has no current consumer. Records do enumerate, because they have no schema to be discovered from.
- **References are environment-variable-shaped** — one flat POSIX-identifier namespace, because a reference doubles as the environment name it resolves through. Records carry the richer `<owner>/<id>` addressing.
- **Process-environment changes are invisible** — no notification can fire for a variable changed in the launching shell; a UI only re-reads `describe()` on its own navigation.
- **A record's owner is its scope, and nothing verifies the scope is mounted** — the seam stores what it is given and reports what it stores; recognizing an orphan is the caller's join between `listRecords()` and whatever registry owns that scope, and the seam has no registry of its own to check against.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the package code.

The seam shape leaves room for keyring-, helper-command-, and KMS-backed providers; a remote settings provider never needs to carry secrets. None is shipped, and no current consumer requires one.

</details>
