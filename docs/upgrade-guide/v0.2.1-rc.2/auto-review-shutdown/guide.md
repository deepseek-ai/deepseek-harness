---
kind: upgrade-guide
description: "Auto review Sessions retain their permission preset when the application closes and require the integration when reopened."
---

# Reopen Auto review Sessions after shutdown

English | [中文](guide.zh.md)

## Change

Application shutdown previously could change a live Auto review Session to Full access, depending on disposal order. Shutdown now preserves Auto and its approval policy. Removing the Auto review plugin from a running application still changes its live Auto Sessions to Full access.

A saved Auto Session requires the Auto review integration before it can reopen. This also applies when a headless invocation requests another permission preset: restore validates the saved selection before applying the new flag. Existing policy records are not rewritten.

## Migration

1. Keep the Auto review integration enabled in the profile that reopens the Session. If you loaded it through a one-off `--patch` overlay, pass that overlay again on resume.
2. To change a saved Auto Session to another preset, first reopen it with the integration present, then select the new preset. Headless callers can supply `--session-id <id> --permission-mode <preset>` with the same Auto overlay.
3. Close and reopen the Session with the integration present. Verify that its selected preset remains Auto unless you explicitly changed it.
