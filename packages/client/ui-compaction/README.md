---
description: "Right sidebar previews of recorded conversation compaction summaries."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-compaction

English | [中文](README.zh.md)

## Summary

Chat opens a recorded summary with `ctx.compactionPreviews.open(address, summarySeq, signal)`. The sidebar persists the `dsh-resource://compaction/` address and reloads the Markdown from Session history when the tab is restored.

## Table of Contents

- [What it registers](#what-it-registers)
- [Reading a summary](#reading-a-summary)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="what-it-registers"></a>
## What it registers

The plugin registers a `compaction` resource provider. While document previews are loaded, it registers the summary tab, its title and body, and the Session navigation service.

<a id="reading-a-summary"></a>
## Reading a summary

The address identifies the Session and summary sequence. For a subagent it includes the parent, child, and mode. The tab reads the exact `compaction/summary` event with `throughSeq` and `maxMessages: 1`. Missing or empty summaries and read failures appear in the tab. An aborted opener skips navigation, and closing the tab releases its resource subscription.

Summary text blocks are joined in order and displayed with the same Markdown tab icon, preview header, and renderer controls as plans. Reopening the same address reuses the tab.

<a id="model-experience"></a>
## Model Experience

None, as the package displays a logged summary and registers no tool, prompt section, or session event.

#### KV Cache effect

No direct effect on model requests or caching.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>
- **Partial history.** The preview button is disabled while the associated summary event is outside the loaded history.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
