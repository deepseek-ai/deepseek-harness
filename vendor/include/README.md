# @cordisjs/plugin-include

File-backed loader tree for Cordis. The include plugin reads a YAML or JSON
file, turns it into loader entries, and writes updates back when the file is
writable.

## Usage

```ts
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Include from '@cordisjs/plugin-include'

const root = new Context()
await root.plugin(Loader, { baseUrl: import.meta.url })
await root.plugin(Include, {
  path: './cordis.yml',
  initial: [],
  enableLogs: true,
})
```

Example `cordis.yml`:

```yaml
- id: timer
  name: '@cordisjs/plugin-timer'
- id: app
  name: ./plugins/app
  config:
    message: hello
```

## Config

| Field | Description |
| --- | --- |
| `path` | YAML or JSON file path resolved from `ctx.baseUrl`. |
| `initial` | Entry list written when the file is missing. |
| `patches` | Runtime patches applied after reading the file. |
| `enableLogs` | Enables loader apply, reload, and unload logs. |

Patches can insert entries or override fields on entries with a matching `id`.

## Patch composition and persistence

`applyEntryPatches(data, patches, warn)` uses the same upstream algorithm as mounting. It clones file entries even without patches and clones inserted entry lists before indexing them, so later patches can address inserted rows without mutating those input lists. `parseEntryYaml(content)` and `stringifyEntryYaml(value, options)` read and write Include’s YAML dialect for configuration tools, and `entryYamlErrorPosition(error)` locates a parse error. `stringifyEntryYaml` writes repeated references in full instead of as aliases. Nested entry expressions remain literal until their owning Loader entry evaluates them.

Tree mutations arrive through `commit(change)` and enter a journal. Include merges them with the latest file before writing; file edits win conflicts on the same fields and produce a diagnostic. Patch-owned fields and inserted entries update the parent Include’s patches instead of the included file. Invalid, missing or read-only files leave unsaved changes in memory.

`flush()` waits for this Include’s pending file operations and tree reconciliation, retries outstanding writes, and rejects if changes remain unsaved. Successful persistence clears previous errors. `refresh()` rereads the file and exposes the same completion result. To persist patch-owned changes, flush the child and then its parent. `stop()` makes a final attempt and always stops child entries, even when it rejects; ordinary Fiber disposal still contains cleanup errors. File writes use an atomic rename with bounded retries for transient destination locks.

Ids that Include generates for anonymous inserted rows are written into the patch objects of its own configuration. When the parent tree re-creates that configuration from a file, for example after the parent Include writes, those ids are generated again and the inserted rows restart; give inserted rows explicit ids where their instance state matters.
