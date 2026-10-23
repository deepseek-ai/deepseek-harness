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

## Module resolution

Without Node module internals, Loader resolves bare specifiers, package imports and self-references in the nearest package scope containing the configuration file. Relative specifiers use the configuration URL directly, and `cordis:` builtins bypass filesystem resolution. Other specifiers, including `node:` builtins and absolute URLs, initialize an ignored `.cordis/resolve.mjs` helper in that scope to preserve native ESM import conditions.

If no scope exists or writing the helper files fails, Loader uses its native import fallback. This fallback emits no diagnostic of its own; project-only dependencies can remain unavailable, and the resulting import error can name the Loader module rather than the configuration project. Failure to import a written helper propagates to the caller without this fallback.

Initialization results are cached for the lifetime of the resolver module, including failed writes and rejected helper imports. Fixing the filesystem does not retry initialization for an already cached scope. Concurrent initialization through filesystem aliases of the same package can contend for the temporary helper files and cause a write failure.

Node module internals are classified by their available APIs, including the v1 API used by Node 24.0–24.11.

## Volatile configuration

`Entry.update` compares raw entry options strictly; when only `config` changed on an active fiber in an unchanged context, the pure `equalExceptVolatile` function in `config/diff.ts` compares the raw configs using Schemastery metadata. It ignores volatile fields at fixed object paths without executing expressions, validators or `internal/config` hooks. Object nodes use their declared defaults for null or absent values, including objects without volatile fields; equivalent defaults skip updates. Other ordinary values, parent expressions and unknown fields retain raw comparison. Recursive schema backedges use raw comparison. Entry passes the actual plugin schema; a non-Schemastery schema compares raw. Context changes, other option changes and pending fibers use ordinary updates. A volatile-only change retains the raw Fiber config for later activation, then `_commitVolatile` parses it through the fiber's `internal/config` hook and schema, commits the new values into the running references when every ordinary effective value still matches, and emits `loader/volatile-update` to the owning fiber with the changed paths. A changed ordinary effective value uses the ordinary remount with a debug log naming the entry; because strict comparison treats class instances other than URL, Date and RegExp by identity, an ordinary field whose transform builds a fresh instance on every parse always takes that remount. An invalid candidate is logged and leaves the running references unchanged. A throwing `loader/volatile-update` listener is logged and does not fail the update; the values are already committed. Group/Include retain child dispatch, and programmatic Fiber updates preserve saving and `noSave`; `simplify` is called with its schema receiver so saved config contains plain values.
