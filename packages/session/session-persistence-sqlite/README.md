---
description: "Use SQLite for durable Sessions and import existing JSONL history when opening it."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-sqlite

English | [中文](README.zh.md)

## Summary

Save new Sessions in SQLite and import old JSONL history on first open. Consumers keep using the existing Session persistence API. The source JSONL files remain on disk.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Select this provider in the global `$DSH_HOME/cordis.patch.yml` for profiles based on `dsh-base`:

```yaml
- id: session-persistence-jsonl
  disabled: true
- insert:
    - id: session-persistence-sqlite
      name: '@deepseek-ai/dsh-session-persistence-sqlite'
      config:
        root: !!js dshHomePath('sessions')
```

The standalone `sdk-minimal` profile calls its JSONL entry `sessions`; use that id in its profile patch. The selected provider registers `ctx.sessionPersistence`. The default shipped composition remains JSONL.

| Field | Default | Meaning |
|---|---|---|
| `root` | required | Session root; the database is `<root>/.segments/sessions.sqlite` |
| `compression` | `zstd` | Encoding used by the legacy JSONL reader; SQLite events are uncompressed JSON |
| `listConcurrency` | `3` | Maximum concurrent legacy metadata reads |

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Storage and migration</summary>

The SQLite plugin depends on the JSONL package for history reading and adjacent version migration. Its isolated JSONL reader does not replace the application's SQLite persistence service. `stat()` and `list()` inspect metadata; opening a legacy Session imports its complete logical history into one root Segment. Concurrent readers join the import, and write access retains the existing single-writer ownership rules. Source files stay unchanged.

Provider startup and disposal live in [the plugin entry](src/index.ts); [migration](src/migration.ts) coordinates import, and [persistence](src/persistence.ts) serves the existing API.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Session persistence API](../session-persistence/README.md)
- [JSONL storage](../session-persistence-jsonl/README.md)
- [Historical format migration](../session-format-catalog/README.md)

<a id="model-experience"></a>
## Model Experience

### Persisted history

#### What the model sees

This plugin adds no request content. Session consumers read the stored logical event history through `ctx.sessionPersistence`.

#### Token effect

There is no direct token effect.

#### KV Cache effect

The storage medium does not alter the logical event history or add a model-request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Selecting JSONL again does not export SQLite history back into the retained JSONL files.

### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
