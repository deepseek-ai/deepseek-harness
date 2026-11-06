---
kind: upgrade-guide
description: "Runtime-context log text gains reminder framing, and clear markers record empty snapshot sections."
---

# Runtime-context reminder records

English | [中文](guide.zh.md)

## Change

New `user/message` records with `source.kind: 'runtime-context'` wrap their text in `<system-reminder>`. The first snapshot introduces the current session without asserting that it replaces earlier context; later snapshots explicitly replace context retained in conversation summaries. Clear reminders now carry `form: 'snapshot'` and `sections: []`.

A retained legacy snapshot or clear marker without `source.sections` is refreshed once on the next admitted request. This adds a message without rewriting the existing request prefix. A legacy snapshot with unchanged recorded sections is not refreshed solely for its wording. Session format and the public `renderContextSnapshot()` and `joinContextSections()` helpers remain unchanged.

## Migration

1. Update consumers that match runtime-context text literally to recognize the reminder wrapper and the initial/update introductions. Prefer `source.kind` and available `source.sections` when identifying or inspecting these records.
2. Treat empty sections as cleared context, and retain support for older records without structured sections. Verify both an initial snapshot and a clear reminder in resumed-session output; existing Session files need no rewrite.
