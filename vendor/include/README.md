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

`applyEntryPatches(data, patches, warn)` uses the same upstream algorithm as mounting. It clones file entries even without patches and clones inserted entry lists before indexing them, so later patches can address inserted rows without mutating those input lists. `entryListSchema` exposes Include’s YAML dialect to configuration tools. Nested entry expressions remain literal until their owning Loader entry evaluates them.

Tree mutations arrive through `commit(change)` and schedule the existing debounced writer. The imported journal helpers support patch ownership; runtime file reconciliation still uses `refresh()` and the existing write queue.
