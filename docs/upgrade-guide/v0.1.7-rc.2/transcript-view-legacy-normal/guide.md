---
kind: upgrade-guide
description: "The legacy ui-chat.transcriptView value normal, and an unset value in non-Desktop Web, now display Detailed instead of Standard."
---

# Legacy `normal` work details display as Detailed

English | [中文](guide.zh.md)

## Change

The Host setting `ui-chat.transcriptView` selects Settings → General → Work details. In v0.1.7-rc.2 the client displayed the legacy saved value `normal` as `standard`, and every client used `standard` when the setting was missing, `null`, or invalid.

From the next release:

- A saved `normal` displays as `detailed` on Desktop and Web. The saved value on disk is not rewritten.
- A missing, `null`, or invalid value displays as `detailed` in non-Desktop Web (the npm `dsh web` install). Desktop still uses `standard`.
- Saved `compact`, `standard`, `detailed`, and `verbose` values are unchanged.

Users who relied on the old reading see running Turns with process-group bodies expanded instead of collapsed summaries.

## Migration

1. To keep the previous presentation, open Settings → General → Work details and choose Standard. The client saves `standard` to `ui-chat.transcriptView`, which every later default change leaves untouched.
2. Confirm: start a Turn that calls tools and check that its process group shows a collapsed summary with live task detail.
