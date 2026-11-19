---
description: "Right sidebar previews of recorded conversation compaction summaries."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-compaction

English | [中文](README.zh.md)

## Summary

Chat opens a recorded summary with `ctx.compactionPreviews.open(address, summarySeq, signal)`. After reloading the browser, reopen it from its compaction row.

## Table of Contents

- [What it registers](#what-it-registers)
- [Reading a summary](#reading-a-summary)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="what-it-registers"></a>
## What it registers

While document previews are available, the plugin provides the compaction preview service to Chat.

<a id="reading-a-summary"></a>
## Reading a summary

The service reads the exact `compaction/summary` event with the Session address, `throughSeq`, and `maxMessages: 1`. Missing or empty summaries and read failures appear on the requesting row. Cancellation stops navigation.

The service passes the joined Markdown text to `sidebarRight.openContent`. Reopening the same event reuses its tab.

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
