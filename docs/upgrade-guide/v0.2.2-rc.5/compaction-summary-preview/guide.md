---
kind: upgrade-guide
description: Read a compaction summary from its Session event.
---

# Compaction summary previews

English | [中文](guide.zh.md)

## Change

Chat compaction markers retain counts and the summary event sequence. Their view data no longer includes the Markdown `summary` field.

## Migration

Use the marker’s non-null `summaryEventSeq` and its Session address to read the corresponding `compaction/summary` event. In Chat, select the completed compaction row to read the summary in the sidebar. Switching Sessions retains the open preview. Reloading closes its tab; reopen it from the same row.
