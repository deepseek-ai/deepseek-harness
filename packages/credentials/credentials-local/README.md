---
description: "The file-backed credentials provider for users and maintainers choosing, configuring, or debugging the local credential store and its environment layering."
kind: "package-reference"
---

# @deepseek-ai/dsh-credentials-local

English | [中文](README.zh.md)

## Summary

`dsh-credentials-local` is the product's default on-machine credential store: a private file under your harness home where API keys and other secrets live, written from a configuration UI and reloaded automatically when you edit the file yourself. The file is a versioned document with a `refs` section for key values and a `records` section for durable per-plugin credentials, so an authorization grant or provider environment survives restarts beside the keys. Keys come from four places in one fixed order: the environment you launch in wins, then the stored file, then your project's and your home `.env` files. A key you save takes effect immediately, even when an older key sits in a `.env`. Only your OS user can read the file, and the product never hands the agent the file's path.

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

This package gives a composition a local credential store: save API keys and other secrets once, and every request that names them uses them. The common path is explicit: load the store, save keys through the configuration UI or `ctx.credentials`, and let the product resolve them when needed.

### When to use it

Use it as the default local store: the product's base composition loads it, and a key you save through a configuration UI takes effect immediately. Choose a different store when a deployment must keep provider keys away from its own agent — file permissions cannot do that, because the agent's tool processes run as your OS user (see "Who can read the file").

### Setting it up

```yaml
- name: '@deepseek-ai/dsh-credentials-local'
  config:
    path: /absolute/path/to/.credentials.yaml
```

| Field | Default | Meaning |
|---|---|---|
| `path` | `<harness home>/.credentials.yaml` | Where the credential file lives |
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Harness home used when `path` is omitted |
| `watch` | `true` | Reload the file automatically when it changes on disk |
| `debounceMs` | `100` | Wait this long after a change before reloading, in milliseconds |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-credentials-local) is the exhaustive source for every accepted field and its JSDoc.

### Storing and removing keys

Save a key with `set`, remove it with `unset`, and check whether a key is configured with `describe` — the same operations the credential API provides:

```ts
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

declare const ctx: Context

const ref = credentialRef('DEEPSEEK_API_KEY')
await ctx.credentials.set(ref, 'sk-…')          // save
await ctx.credentials.describe(ref)             // { configured, source?, writable } — never the value
await ctx.credentials.unset(ref)                // remove
```

A key you save is usable by the next request that names it, and `describe` reports whether it is set, where it comes from, and whether you can write to it — never the value itself. Records persist in the same file, addressed by `<owner>/<id>` and managed with the seam's record operations (`readRecord`, `describeRecord`, `listRecords`, `modifyRecord`, `deleteRecord`).

### Where keys come from

Keys are resolved in one fixed order — the first place that has a value wins:

| Place | Writable? | Wins over |
|---|---|---|
| The environment you launched in (`DEEPSEEK_API_KEY=… dsh`) | no | everything |
| The stored file | yes (`set`/`unset`) | both `.env` files |
| Your project's `.env` (`<invocation cwd>/.env`) | not here | your home `.env` |
| Your home `.env` (`$DSH_HOME/.env`) | not here | nothing |

The launching environment wins because a per-run override — `DEEPSEEK_API_KEY=… dsh`, a CI secret, a container `-e` — is this run's explicit intent; it cannot be edited from inside the product, so it is reported read-only and writes to it are refused. Everything else loses to the stored file, which is why a key you save takes effect immediately even when an older key sits in a `.env`; those two `.env` layers resolve when nothing is stored. The environment layer is the launcher's snapshot taken at launch ([environment snapshot](../../util/launch-environment/README.md)), so a variable exported after startup is not seen.

### The credential file

A versioned YAML document with one section per key space, and nothing else:

```yaml
version: 1

refs:
  DEEPSEEK_API_KEY: sk-…
  OPENAI_API_KEY: sk-…

records:
  llm-pi-ai/openai-codex:
    kind: grant
    payload:                    # written verbatim; this provider does not interpret it
      type: oauth
      access: eyJhbGciOi…
      refresh: rft_9f8e7d…
      expires: 1786000000000
  llm-pi-ai/amazon-bedrock:
    kind: api-key               # environment values, no key: this route uses an AWS profile
    env:
      AWS_PROFILE: prod
  llm-pi-ai/amazon-bedrock-dev:
    kind: api-key               # neither: the owner confirmed the ambient credential chain
```

You can edit the file directly — the store reloads it automatically and picks up the change, including a key or record you delete. `refs` holds key values by environment-variable name; `records` holds per-plugin credentials by `<owner>/<id>`, each tagged `api-key` or `grant`, whose grant payload the store keeps verbatim because only its owner can interpret it. Comments and the formatting of untouched entries survive product writes; a comment directly above an entry is that entry's note and is removed with it. The file holds only credentials, so anything else is refused loudly rather than silently ignored: a non-mapping root, an unknown top-level key, a key that is not addressable in its space, a wrong-typed or empty value, an unknown record tag or field, duplicate keys, and malformed YAML all fail at startup, and on a live reload the last good content keeps serving with a warning.

A key's value can be any text, multi-line values included — no quoting tricks needed. An empty value means "no key", which is why an empty string in the file is rejected: removing a key deletes it, it does not blank it. A `grant` payload must survive a JSON round trip, enforced on the way in and on the way out, so the store refuses a value it could not read back exactly as written. If the file on disk no longer parses, saving fails instead of overwriting content the product could not read.

### Who can read the file

Only your OS user can read the file: the product creates it with owner-only permissions, and on POSIX it refuses to load a file that any other user can read — the error tells you to run `chmod 600`. Windows has no mode to inspect, so the check is skipped there rather than faked. The agent is not another user: its tool processes run as you, so they can read the file like any other file you own. The product never hands the agent the file's path and never loads the file into the environment, so reaching a value takes a deliberate read of a path the agent was not given. That is discretion, not a boundary: a deployment that must keep provider keys away from its own agent cannot get there with file permissions.

### What can go wrong

- **A key the launching environment supplies is read-only** — `DEEPSEEK_API_KEY=… dsh` wins for this run; saving or removing it is refused. Clear the variable in the launching shell first.
- **An empty value cannot be saved** — storing an empty string is refused; remove the key instead.
- **The store refuses to load a file it cannot trust** — a file any other user can read, malformed YAML, or an unreachable path fails at startup; on a live reload the last good content keeps serving with a warning.
- **Changes made at the same time are both kept** — if you edit the file while the product writes, your change is folded in rather than overwritten.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **One honest precedence.** The inherited environment wins because it is this run's explicit intent and cannot be edited from inside; everything below it loses to the managed store, so a stored key is never displaced by a stale `.env`.
- **The document holds only credentials.** A versioned document with `refs` and `records` sections rather than a dotenv file: a store the harness owns and never materializes into the environment cannot also serve as the user's environment layer, which would shadow non-secret entries behind its precedence.
- **Writes patch, reloads replace.** Line edits preserve comments and untouched entries under the cross-process writer lock; reloads swap the parsed snapshot wholesale so a deleted entry never lingers in memory.
- **Fail loud where trust is at stake.** Boot and reload reject a document that is unreadable, invalid, or readable beyond its owner; a live reload that fails keeps the last good snapshot and warns rather than taking the process down.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Provider: layer resolution, strict document parse, reference and record write paths under the writer lock, watcher lifecycle, permissions check |
| — | No runtime invariant companion is published; the Service Definition companion (`dsh-credentials/invariant`) owns the `credentials/reference-updated` lifecycle contract; this provider's file/environment layering is asynchronous I/O pinned by its unit suite. |

### Resolution and write paths

`resolve` and `describe` read the inherited environment snapshot, the parsed document snapshot, and the `.env` fallbacks in precedence order. `set`/`unset` queue onto one exclusive operation chain: entry checks reject early (disposed, empty value, environment-shadowed), and the queue re-judges them at run time before a read-modify-write under the writer lock commits and fires `credentials/reference-updated` exactly once.

`modifyRecord` runs on the same chain and lock: it re-reads the document, shows the mutation the record as it stands, admits the result — a non-empty api key, a grant payload that survives a JSON round trip — renders the record wholesale, and commits, firing `credentials/record-updated` once. A composition the product CLI did not boot has only the inherited environment as its layer.

### Reload lifecycle

A watcher event or the ready reconcile queues a refresh behind the same chain. `reconcileFromDisk` re-checks permissions, re-reads the text, replaces both snapshots wholesale when the text differs, and publishes one event per changed reference or record; content equal to the text cache — including the provider's own writes — is a no-op. Disposal sets the closed flag, stops accepting events, closes the watcher, and waits out queued operations so nothing publishes after teardown.

### Document versioning

The document carries `version: 1`, stamped on every write. A boot that recognizes the pre-release flat layout — a bare mapping of reference names with no `version` — upgrades the document in place under the writer lock, nesting the original lines under `refs:` so values, comments, and spellings survive byte for byte; any other unversioned shape is refused by name rather than read as an empty store. A live reload never migrates: a flat document restored mid-run keeps the last good snapshot until the next boot.

### Diagnostics never quote a value

The YAML parser's own message quotes the offending source line, which in this document is the secret itself. Every diagnostic therefore carries only the error code and position — a key name is safe to print, a value is not.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the provider-level contract is not enough. They move from the seam contract to the environment snapshot, the atomic-write primitive, and the boot-time environment layers.

- [Credential-reference seam](../credentials/README.md) — `resolve`, `describe`, `set`, `unset`, the record operations, and the seam's update events.
- [Credentials subsystem reference](../../../docs/subsystems/credentials.md) — `CredentialRef`, per-operation resolution, UI-safe `CredentialInfo`, provider layers.
- [Launch environment snapshot](../../util/launch-environment/README.md) — the frozen layer snapshot resolution reads instead of `process.env`.
- [Atomic write](../../util/atomic-write/README.md) — the writer lock and atomic replacement every write uses.
- [App boot and Harness-home layers](../../boot/app-boot/README.md) — how the product CLI loads `.env` into the snapshot and `process.env`.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the consumers of `ctx.credentials`, which own any model-facing behavior a stored value enables.

#### KV Cache effect

No direct invalidation; stored values never enter a request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Same-reference concurrent writes are last-write-wins** — the writer lock and the read-modify-write keep concurrent writers from dropping each other's entries, but two writers editing one reference still resolve to the later write; there is no revision check.
- **A same-UID process can read the document** — the file-effect sandbox modes do not deny reads, and an OS-keychain provider is deferred.
- **Environment changes are invisible** — the snapshot is frozen at launch, so a variable exported after startup reaches neither resolution nor `describe`; changing an environment-sourced credential takes a restart.
- **Atomic, not crash-durable** — inherited from `dsh-atomic-write`; the store re-reads on boot.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the package code.

An OS-keychain provider — a store the model's processes cannot read — is the deferred answer to the same-UID limitation and belongs beside this provider as a sibling package. The seam shape also leaves room for helper-command- and KMS-backed providers; none is shipped.

</details>
