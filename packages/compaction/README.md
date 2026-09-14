---
description: "Package map for the conversation-condensing feature family: automatic compaction, the on-demand /compact command, and tool-output trimming."
kind: "package-group"
---

# compaction/ — compaction capability family

English | [中文](README.zh.md)

## Summary

The `compaction/` group keeps long agent conversations working near the model's context limit: older history is condensed into a summary automatically as token pressure builds, on demand with `/compact`, oversized tool outputs can be trimmed first so there is less to condense, and images an image-capable route can no longer send are replaced with placeholders. The shipped `dsh` base enables the feature by default — mount the packages explicitly to tune when and how condensation happens. The token measurement that decides when to condense lives in a separate LLM-family service.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Each package below provides one piece of the feature; open a package page for how to use it.

| Package | Role | ctx key |
|---|---|---|
| [`compaction/`](compaction/README.md) | The shared condensation contract: the operations and summary format every backend and trigger use | `ctx.compaction` |
| [`compaction-basic/`](compaction-basic/README.md) | Automatic condensation of older history into a summary as token pressure builds | registers `ctx.compaction` |
| [`compaction-tool-result-pruner/`](compaction-tool-result-pruner/README.md) | Trims oversized tool outputs so less history needs condensing | `ctx.toolResultPruner` |
| [`compaction-image-offload/`](compaction-image-offload/README.md) | Replaces over-budget request images with placeholders when an image-capable route rejects a request | listens to `agent/request-error` |
| [`command-compact/`](command-compact/README.md) | The `/compact` command to condense history on demand | registers on `ctx.commands` |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the subsystem reference for the shared vocabulary, then read the two Agent Notes for the design rationale.

- [Compaction subsystem reference](../../docs/subsystems/compaction.md) — the condensation vocabulary, results, and service behavior.
- [Compaction capability-seam Agent Note](../../.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.md) — how the family is split and why it depends on session and LLM vocabulary.
- [Queued manual compaction Agent Note](../../.agents/notes/implemented/feature/2026-07-30-queued-manual-compaction.md) — how on-demand `/compact` serializes against running turns.
- [Capability seams](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md) — the Service Definition / Service Provider / Consumer split this family follows.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
