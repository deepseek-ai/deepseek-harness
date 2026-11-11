---
kind: upgrade-guide
description: "macOS mouseMove requires AX alternate UI by default and returns HOVER_UNAVAILABLE instead of moving the user's cursor."
---

# macOS hover keeps the system pointer in place by default

English | [中文](guide.zh.md)

## Change

On macOS, `win.mouseMove(target)` uses an enabled element or ancestor that advertises both `AXShowAlternateUI` and `AXShowDefaultUI`. Without that route, previous versions moved the visible system cursor. The default now returns `HOVER_UNAVAILABLE` before sending input. By default, explicitly requesting the system pointer asks the user for this session.

## Migration

1. For an available control, use its advertised action or click it directly. Use browser tools for web content that requires page hover.
2. If your profile sets `helperPath`, rebuild the custom helper to support the per-request `useSystemPointer` field and restart the profile.
3. When the task requires physical movement, call `win.mouseMove(target, { useSystemPointer: true })` on an unobscured foreground target. After approval this move reports `systemPointerMoved: true`. Pass `useSystemPointer: true` again for each subsequent physical move. Closing the session or restarting DSH clears approval.
