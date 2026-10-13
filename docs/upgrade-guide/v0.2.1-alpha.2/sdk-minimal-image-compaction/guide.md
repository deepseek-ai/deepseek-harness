---
kind: upgrade-guide
description: "The sdk-minimal default tool roster adds read_image and automatically summarizes older context."
---

# SDK-minimal image reading and automatic compaction

English | [中文](guide.zh.md)

## Change

`sdk-minimal` advertises `read_image` alongside its persistent shell and `working_directory`. Automatic compaction sends an additional model request to summarize older history when context pressure reaches the configured threshold. The complete Session log remains stored as uncompressed JSONL. Images that exceed the route budget are permanently replaced by attachment/path placeholders so the request can retry. SDK prompt text does not execute `/compact`.

Clients that pin tool names, benchmark prompt size, or count model requests must account for these defaults. Image reading requires an adapter route that declares image input. See the [bundle reference](../../../../packages/bundle/sdk-minimal/README.md) for configuration and model effects.

## Migration

1. Accept the new defaults, or place this patch in `$DSH_HOME/profiles/sdk-minimal/cordis.patch.yml` to retain the previous default tools and disable automatic compaction:

```yaml
- id: tool-fs
  config:
    read: false
    readImage: false
    write: false
    edit: false
- id: compaction-basic
  config:
    auto: false
```

2. Launch a fresh SDK runtime. Without additional user plugins, its model requests contain the persistent `bash` or `pwsh` tool and `working_directory`; it sends no automatic summarization requests.
