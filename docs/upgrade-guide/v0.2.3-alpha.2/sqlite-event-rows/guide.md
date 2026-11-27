---
kind: upgrade-guide
description: "The opt-in SQLite Session store now holds one row per event: the frameEvents setting is removed, and an existing database is upgraded on first open and can no longer be opened by earlier releases."
---

# SQLite Session store with one row per event

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-session-persistence-sqlite` previously stored events as compressed frames of up to `frameEvents` events. It now stores one row per event, with the event's sequence, type and time as columns, and keeps derived tables for model calls, tool calls and compactions. The `frameEvents` setting no longer exists.

A database written by an earlier release has schema version 1. The first open upgrades it to version 3 in one transaction; a failed upgrade leaves the file unchanged. Earlier releases refuse a version 3 database. Only profiles that replaced the default JSONL provider with this package are affected. Unshared Sessions idle for 30 days now move to [cold archives](../../../../packages/session/session-persistence-sqlite/README.md#archiving-idle-sessions) by default (`coldAfterDays: 30`; set `0` to keep all payloads inline).

The provider also gains a `recovery` setting. It defaults to `replace`: an open that finds a damaged database moves the file aside to `<name>.unreadable-<timestamp>` beside it and starts an empty one, so the Sessions stay available and no stored byte is deleted. Set `recovery: report` to keep the earlier refusal and repair the storage root by hand. A database another process holds locked is never replaced; it fails with the new `SESSION_STORAGE_LOCKED` after the busy timeout, and closing that process is the remedy.

## Migration

1. Stop every DSH process that uses the storage root.
2. Copy `<root>/.segments/sessions.sqlite` and any `sessions.sqlite-wal` and `sessions.sqlite-shm` files beside it to a backup location. This copy is the only way back to an earlier release.
3. Remove `frameEvents` from the provider's `config` in your `cordis.yml` or patch. A leftover value is ignored.
4. Start DSH. The upgrade runs before the first Session opens and blocks the process meanwhile, about four seconds per 100 MB of database in our measurement; the log names it when it starts. The upgraded file holds both layouts until SQLite reuses the freed pages, so expect about 2.5 times the earlier size at first; offline `VACUUM` shrinks it to roughly 45% more than the frame layout. A warning names any frame that holds unreadable data: reads fail where they failed before, and the frame's bytes are kept in the `frames_set_aside` table. If the upgrade fails with `SESSION_STORAGE_UPGRADE`, the file is unchanged: restore the backup or keep using the earlier release.
5. Confirm the result with `sqlite3 <root>/.segments/sessions.sqlite "PRAGMA user_version; SELECT count(*) FROM session_summary;"`. It prints `3` and the number of stored Sessions.
