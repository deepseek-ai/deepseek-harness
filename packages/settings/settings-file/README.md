---
description: "The file-backed settings provider for users and maintainers choosing, configuring, or debugging the YAML/JSON settings document and its hot reload."
kind: "package-reference"
---

# @deepseek-ai/dsh-settings-file

English | [中文](README.zh.md)

## Summary

`dsh-settings-file` keeps every namespace's user settings in one YAML or JSON document, by default `settings.yaml` under the harness home: users can edit the document directly — changes take effect live — or write through the service, which merges concurrent edits safely. YAML writes preserve comments, anchors, and formatting on every untouched node, and a section owned by a plugin that is not loaded is never dropped. Boot fails loud on an invalid document; a live reload that fails keeps the last good sections and warns rather than taking the process down.

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

Mount this provider when a composition wants one user-editable settings document. The common path is explicit: mount the provider, register namespaces through `ctx.settings`, and let users edit the document or a configuration UI write through the service.

### When to choose it

Choose it as the default user-settings store: one human-readable document that users can open in any editor, with changes taking effect without a restart. Choose it when comments and formatting in that document matter, because writes preserve them. A non-file store, such as a remote settings backend, is not shipped here; that would need another provider.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-settings-file'
  config:
    path: /absolute/path/to/settings.yaml
```

| Field | Default | Meaning |
|---|---|---|
| `path` | `<harness home>/settings.yaml` | Settings document path; the extension picks the format (`.yaml`, `.yml`, or `.json`) |
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Harness home used when `path` is omitted |
| `watch` | `true` | Watch the document and hot-publish external edits |
| `debounceMs` | `100` | Watcher write-settle window, in milliseconds |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-settings-file) is the exhaustive source for every accepted field and its JSDoc.

### Editing the document

The document is a YAML or JSON mapping of namespace to user section. Users can edit it directly: any change takes effect automatically, and deleting the file resets every namespace to defaults and `base`. A document that exists but is invalid fails plugin load at boot — the provider never silently ignores or overwrites it. Once live, an unreadable or unparsable edit warns and keeps the last good sections, so a hand-edit mistake cannot take the process down.

### Writing through the service

Writes through `ctx.settings` never lose concurrent changes: an external edit still in flight, a change the watcher missed, or another process's write is merged into the document before the write lands. YAML edits are leaf-level diffs: only changed values are set and only removed keys deleted, so comments, anchors, and formatting survive on every untouched node and on the key of every changed pair; a changed array or other non-map value replaces wholesale. JSON documents re-serialize without comments. If the on-disk document turned invalid, the write fails loud instead of overwriting the user's manual edit.

The lock has a 2-second acquisition deadline with exponential backoff; a contender that times out leaves the existing lock in place, because lock age cannot distinguish a crashed owner from a paused live writer — orphan lock recovery is an operator action. The document is created `0600` under an owner-only `0700` directory and replaced atomically through a random-suffix temp sibling that never follows a planted symlink.

### Failures and recovery

- An unsupported extension fails at load — the format comes from the extension (`.yaml`, `.yml`, `.json`).
- A missing document is an empty store; deleting the file returns to that state.
- An invalid on-disk document at runtime blocks nothing but keeps the last good sections; a write refuses to overwrite it.
- `prepareDocument()` materializes an absent document as an empty owner-only file before a native editor opens it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **One explicit defaulting step.** `resolveSpec(config)` resolves the filename, format, watch flag, and debounce window in one step, so programmatic construction that bypasses Schemastery normalization gets the same defaults.
- **Boot fails loud, reload keeps last good.** An existing-but-invalid document fails plugin load; once live, an unreadable or unparsable edit warns and keeps the last good sections.
- **Every write is a read-modify-write.** A persist first reconciles from disk and publishes any difference into the seam, then renders against that fresh text, so a write can never resurrect a stale document or drop an unobserved sibling section.
- **Writes hold a cross-process writer lock.** The read-render-rename cycle runs under a `wx`-created `<file>.lock` sibling with exponential backoff and a 2-second acquisition deadline; readers never take the lock because the rename commit is atomic.
- **YAML edits are leaf-level diffs.** Only changed values are set and only removed keys deleted, preserving comments, anchors, and formatting on untouched nodes.
- **Reloads and writes share one operation chain.** Watcher refreshes and persists from every namespace queue run one at a time in queue order; each render sees the text the previous operation committed.
- **Self-write suppression by content.** The provider caches the last good text; a watcher event whose content equals the cache — its own write included — is a no-op.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Provider: spec resolution, load/parse, read-modify-write under the writer lock, watcher lifecycle, YAML/JSON rendering |
| — | No runtime invariant companion is published; this provider's contracts are file round-trip, watcher timing, and atomic-write behavior — IO effects proven by package tests; the in-process commit relation is owned by `@deepseek-ai/dsh-settings`. |

### Document lifecycle

The base service init loads and publishes the document before the service becomes injectable; the provider then starts the watcher and reconciles once at ready to close the startup gap in which a change written between the initial read and the watcher becoming active never fires an event. Every watcher event and every persist queues onto one exclusive operation chain. `reconcileFromDisk` compares on-disk text against the cache, publishes any difference (including absence as the empty document), and throws only on a parse failure so each caller picks its policy — a reload warns and keeps the last good document, a write fails loud. Disposal marks the provider closed, closes the watcher, and waits out every queued or in-flight operation so nothing publishes after teardown.

### Render paths

YAML renders by parsing the cached text into a mutable comment-preserving tree and patching one namespace with leaf-level edits; JSON renders by replacing one namespace key and re-serializing with two-space indentation. Before Chokidar opens the target, the provider realpaths its deepest existing ancestor and restores any missing suffix, so Windows cannot mix an 8.3 alias with long-form event paths inside libuv.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the provider-level contract is not enough. They move from the seam contract to the atomic-write primitive and the exhaustive configuration surface.

- [User-settings service](../settings/README.md) — namespace registration, layered resolution, writes, and the events this provider feeds.
- [Settings subsystem reference](../../../docs/subsystems/settings.md) — namespaces, resolution order, descriptors, and change commits.
- [Settings package map](../README.md) — the two packages of the user-settings capability.
- [Atomic write](../../util/atomic-write/README.md) — the writer lock and atomic replacement every write uses.
- [Home paths](../../util/home-paths/README.md) — `$DSH_HOME` resolution and canonical watch paths.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-settings-file) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the consumers of `ctx.settings`, which own any model-facing behavior fed by a stored value; the file provider only stores and publishes namespace sections and registers nothing model-facing itself.

#### KV Cache effect

No direct invalidation; the consuming plugin owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Same-namespace conflicts stay last-write-wins** — the writer lock and read-modify-write keep concurrent writers from dropping each other's namespaces, but two writers editing one namespace still resolve to the later write; there is no per-value merge or revision check.
- **A missed watcher event stays unseen until the next signal** — reads never re-stat the file, so a change the watcher fails to report is only folded in by the next event, the next write, or a restart.
- **Comment preservation is YAML-only and map-shaped** — JSON documents re-serialize without comments, and comments inside a changed array, or attached inline to a changed scalar value, go with the value they described.
- **No value indirection** — sections hold literal values; `${env:VAR}`-style references for secrets are a deferred seam-level feature.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: deferred directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above and the package code. Deferred directions: `${env:VAR}`-style value indirection is a seam-level feature — it belongs with the settings service contract when it lands, not with this provider. Orphan lock recovery remains an operator action by design, because lock age cannot distinguish a crashed owner from a paused live writer.

</details>
