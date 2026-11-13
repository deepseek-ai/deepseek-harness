---
kind: upgrade-guide
description: "Opting into SQLite imports Session history; retained JSONL files no longer contain new events after import."
---

# Opt into SQLite Session storage

English | [中文](guide.zh.md)

## Change

The `@deepseek-ai/dsh-session-persistence-jsonl` plugin previously wrote Session history to per-session JSONL files. Its `storage` option defaults to `jsonl`. Explicitly setting `storage: sqlite` writes to `<root>/.segments/sessions.sqlite`. First open of supported JSONL history, including read-only open, imports it transactionally and preserves the original files. Subsequent events go to SQLite. Concurrent readers wait for import and then read SQLite alongside its writer.

External tools that read JSONL directly will no longer see new events. Retained JSONL does not provide fallback or downgrade for imported Sessions. Browser Workers explicitly select `storage: jsonl` and `compression: none`.

## Migration

1. Stop all applications writing to the configured `root` and back up the complete root before upgrading. Keep the database, its SQLite sidecar files, routing records, and retained JSONL together in later backups; copy them with writers stopped.
2. Keep the existing plugin and `root` configuration to use SQLite. The `compression` setting controls legacy JSONL encoding, not SQLite. Update external history readers to use the [Session persistence service](../../../../packages/session/session-persistence/README.md).
3. To enable SQLite, explicitly set `storage: sqlite` in the plugin's `config` before opening Sessions. Omit `storage` or select `storage: jsonl` to keep JSONL output without importing history. To change storage after import, use a separate root for new Sessions; retained JSONL lacks later SQLite events.
4. Open an existing Session and confirm its history is readable, append a new turn, and reopen it to confirm that turn persists. For SQLite, confirm the database exists under `.segments`; do not use unchanged legacy JSONL as evidence of lost writes.
