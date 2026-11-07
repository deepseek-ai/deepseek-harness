---
kind: upgrade-guide
description: "macOS mouseMove requires AX alternate UI by default and returns HOVER_UNAVAILABLE instead of moving the user's cursor."
---

# macOS hover keeps the system pointer in place by default

English | [中文](guide.zh.md)

## Change

On macOS, `win.mouseMove(target)` uses an enabled element or ancestor that advertises both `AXShowAlternateUI` and `AXShowDefaultUI`. Without that route, previous versions moved the visible system cursor. The default now returns `HOVER_UNAVAILABLE` before sending input.

## Migration

1. For an available control, use its advertised action or click it directly. Use browser tools for web content that requires page hover.
2. To restore visible pointer movement, set `systemPointerHover: true` in the `config` of the macOS provider entry (`id: cua`) in your profile's `cordis.patch.yml`. Preserve the entry's other settings. If you set `helperPath`, rebuild the custom helper so it accepts `systemPointerHover` in the connection handshake. Restart the profile.
3. Call `win.mouseMove` on a foreground, unobscured control without AX alternate UI. The opt-in result reports `hoverRoute: "system-pointer"` and `systemPointerMoved: true`. Keep the default to avoid disturbing the user's cursor.
