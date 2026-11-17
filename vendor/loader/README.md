# @cordisjs/plugin-loader

Runtime plugin loader for Cordis. The loader owns an `EntryTree`, imports plugin
modules by name, applies their config, and keeps the running plugin graph in
sync with entry updates.

## Usage

```ts
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'

const root = new Context()
await root.plugin(Loader, { baseUrl: import.meta.url })

const id = await root.loader.create({
  name: './plugins/example',
  config: { enabled: true },
})

await root.loader.await()
root.loader.update(id, { config: { enabled: false } })
```

## Entry Options

| Field | Description |
| --- | --- |
| `id` | Stable id for resolving, updating, and removing the entry. |
| `name` | Module specifier imported by the loader. |
| `config` | Config passed to the plugin. |
| `group` | Marks the entry as a group whose `config` is a child entry list. |
| `disabled` | Stops the entry and prevents it from starting. |
| `inject` | Adds required services or intercept config for this entry. |

## API

| API | Description |
| --- | --- |
| `loader.create(options, parent?, position?)` | Add and start an entry. |
| `loader.update(id, options, parent?, position?)` | Update, move, and restart an entry. |
| `loader.remove(id)` | Stop and delete an entry. |
| `loader.resolve(id)` | Resolve an entry by id, including nested `a:b` ids. |
| `loader.resolve(id).moduleNamespace` | Raw import result before export normalization; HMR updates it after a successful reload. |
| `loader.resolveGroup(id)` | Resolve the root group or a nested group. |
| `loader.await()` | Wait for pending entry imports and fiber reloads. |
| `loader.locate(fiber?)` | Return the loader entry id that owns a fiber. |

For file-backed trees, use `@cordisjs/plugin-include`.

## Entry validation and source positions

`create()` and `update()` check the resulting options with `validateOptions()` before the tree changes and reject with `EntryValidationError`, whose `issues` list each rejected path. `id` and `name` must be strings, and `name` is required; `group` must be a boolean; `disabled` a boolean or `!!js` expression; an entry with `group: true` requires a `config` array, which may be empty; `inject` a string array or a mapping; `intercept` and `isolate` mappings, with each `isolate` value `true` or a string. `create()` and `update()` also check the entries of a group's `config`. A group checks each entry again as it creates it; an invalid entry is logged, any running entry with its id is disposed, and its siblings still start. Explicit ids may contain `:`.

`EntryTree.getLocation(id, path)` returns where an entry option is written; the base tree returns `undefined`, and Include implements it. Config validation errors and entry option errors of an entry with a source list each issue with its `file:line:column`, and their stack frames name the entry ids from the innermost tree outward. A config passed at runtime has no source position, so its validation errors keep their original message.

## Module resolution

Without Node module internals, Loader resolves bare specifiers, package imports and self-references in the nearest package scope containing the configuration file. Relative specifiers use the configuration URL directly, and `cordis:` builtins bypass filesystem resolution. Other specifiers, including `node:` builtins and absolute URLs, initialize an ignored `.cordis/resolve.mjs` helper in that scope to preserve native ESM import conditions.

If no scope exists or writing the helper files fails, Loader uses its native import fallback. This fallback emits no diagnostic of its own; project-only dependencies can remain unavailable, and the resulting import error can name the Loader module rather than the configuration project. Failure to import a written helper propagates to the caller without this fallback.

A successful initialization is cached for the lifetime of the resolver module, and so is a rejected helper import. A scope whose helper files cannot be written is not cached, so a later import retries the initialization. A helper file that already holds the expected content is not rewritten, and a rename blocked by a transient `EACCES`, `EPERM` or `EBUSY` lock is retried with a bounded backoff. Concurrent initialization through filesystem aliases of the same package can contend for the temporary helper files and cause a write failure.

On Windows, an entry `name` that is a drive-letter path such as `C:\app\plugin.js` is imported as its file URL. When the entry's own module cannot be found, the import rejects with `ModuleNotFoundError`, whose `specifier` is the entry `name` and whose message keeps Node's description and hints without the importer; an entry with a source position reports it as `(at name, file:line:column)`. A missing module imported by the plugin propagates Node's original error.

Node module internals are classified by their available APIs, including the v1 API used by Node 24.0–24.11.

## Volatile configuration

`Entry.update` compares raw entry options strictly; when only `config` changed on an active fiber in an unchanged context, the pure `equalExceptVolatile` function in `config/diff.ts` compares the raw configs using Schemastery metadata. It ignores volatile fields at fixed object paths without executing expressions, validators or `internal/config` hooks. Object nodes use their declared defaults for null or absent values, including objects without volatile fields; equivalent defaults skip updates. Other ordinary values, parent expressions and unknown fields retain raw comparison. Recursive schema backedges use raw comparison. Entry passes the actual plugin schema; a non-Schemastery schema compares raw. Context changes, other option changes and pending fibers use ordinary updates. A volatile-only change retains the raw Fiber config for later activation, then `_commitVolatile` parses it through the fiber's `internal/config` hook and schema, commits the new values into the running references when every ordinary effective value still matches, and emits `loader/volatile-update` to the owning fiber with the changed paths. A changed ordinary effective value uses the ordinary remount with a debug log naming the entry; because strict comparison treats class instances other than URL, Date and RegExp by identity, an ordinary field whose transform builds a fresh instance on every parse always takes that remount. An invalid candidate is logged and leaves the running references unchanged. A throwing `loader/volatile-update` listener is logged and does not fail the update; the values are already committed. Group/Include retain child dispatch, and programmatic Fiber updates preserve saving and `noSave`; `simplify` is called with its schema receiver so saved config contains plain values.

## Update completion

Entry updates await `loader/patch-context`, the Fiber update waterfall and disabled-entry disposal. Combined context/config changes refresh required bindings before restarting. Group and Include updates expose completion of their child updates; file persistence completes through Include’s `flush()`.

## Tree mutation reports

`EntryTree.commit(change)` receives each mutation made through `EntryTree` methods synchronously after options and group membership change; file-driven `EntryGroup` reconciliation does not report. A missing `legacy` means creation; missing `options` means removal. Updates carry both, with `from` naming the previous group after a move within the tree; a move into another tree transfers the registrations of the entry and its group members, reports a removal to the source tree and a creation to the destination tree, and is rejected when the destination tree already holds the id. Explicit Fiber saves report their simplified configuration. File-driven reconciliation, parent teardown and Loader removal do not produce spurious self-disable reports. In-memory trees implement a no-op; Include journals the reports and reconciles them with file edits. Explicit entry ids may contain `:`; `resolve()` cannot address such entries by nested path, because `:` separates nested tree paths.
