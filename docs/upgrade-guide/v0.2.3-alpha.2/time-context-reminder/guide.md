---
kind: upgrade-guide
description: "Time-context log text gains a system-reminder frame."
---

# Time-context reminder records

English | [中文](guide.zh.md)

## Change

New `user/message` records with `source.kind: 'time-context'` wrap their three-line reading in `<system-reminder>` and `</system-reminder>` lines, so the model reads the reading as injected context rather than user input. `source.sections[0].text` keeps the reading without the frame. Existing records are not rewritten, so a resumed Session log can contain both framed and unframed readings. Session format is unchanged.

## Migration

1. Update consumers that match time-context text literally, for example by the `Time sampled while preparing` prefix of `content[0].text`, to identify these records by `source.kind` and read the reading from `source.sections[0].text`.
2. Keep accepting older records whose `content[0].text` has no frame. Confirm by reading a resumed Session that holds a reading from before and after the upgrade; both should be recognized.
