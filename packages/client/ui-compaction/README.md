---
description: "Right Sidebar previews of compaction checkpoints: the replacement message the model reads after a compact, shown as Markdown in the content tab."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-compaction

English | [中文](README.zh.md)

## Summary

Open a checkpoint replacement message in the shared sidebar content preview. Chat asks `ctx.compactionPreviews.open(address, seq, signal)` to read the exact checkpoint when a compact row is clicked; the plugin passes its Markdown directly to `ctx.contentPreviews.open`.

## Table of Contents

- [What it registers](#what-it-registers)
- [Reading a checkpoint](#reading-a-checkpoint)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="what-it-registers"></a>
## What it registers

The plugin injects `locale`, `remote`, and `remote.session`, registers its locale dictionaries, and provides `compactionPreviews` while the optional `contentPreviews` service is available. Disposal removes its service and dictionaries. It contributes no tab type or resource protocol.

<a id="reading-a-checkpoint"></a>
## Reading a checkpoint

The caller supplies the complete ordinary or subagent `SessionAddress` and the replacement-message sequence number. One `remote.session.events` request uses `throughSeq: seq` and `maxMessages: 1`; the reader locates that exact sequence and requires a checkpoint `user/message`. Missing checkpoints and read failures return a localized failure line. The requesting row owns cancellation; cancelled or disposed requests never open a preview.

Text blocks concatenate without separators, matching model-adapter behavior. Non-text blocks become localized labels. The shared content preview receives Markdown and the localized title with a Session-scoped checkpoint key. Repeated opens reuse the preview; browser reload expires its transient input.

<a id="model-experience"></a>
## Model Experience

None, as the package only displays a checkpoint the model has already read and registers no tool, prompt section, or session event.

#### KV Cache effect

No direct effect; reading a checkpoint does not assemble or change a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>
- **Non-text blocks show only a label.** Images, files, and other non-text blocks in the replacement message appear as a localized placeholder, not their content.
- **Backend framing shows verbatim.** Each compaction backend wraps its summary in its own fixed instructions and tags; the preview shows them as written, so the text around the summary differs between backends.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
