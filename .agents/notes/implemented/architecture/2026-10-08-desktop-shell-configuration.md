# Agent Note: Desktop shell configuration independent of the Host

Status: implemented

English | [中文](2026-10-08-desktop-shell-configuration.zh.md)

## Problem

Desktop updates and native recovery can run before the Host starts or while it is unavailable. Depending on Host configuration prevents these functions from resolving their preferences when needed. A shared settings page does not identify which process owns each preference.

## Decision

Electron main owns `userData/desktop/settings.json` independently of Host startup and Cordis evaluation. The test authentication popup switch uses this file; the [Desktop reference](../../../../apps/desktop/README.md#local-desktop-settings) owns its fields and behavior.

Ownership follows runtime dependencies: Electron-owned functions needing configuration before Host startup or while the Host is unavailable use shell configuration. Host plugin settings, including shared Web/Desktop preferences, continue to use Cordis. Displaying a setting in Desktop alone does not justify shell ownership. A unified settings interface can use separate storage owners.

The `desktop` subdirectory groups shell configuration without relocating existing files. The [shortcut decision](2026-09-20-device-local-shortcut-preferences.md) retains ownership of `userData/keybindings.json` and its persistence semantics. The [shared Web application decision](2026-09-10-desktop-web-wrapper.md) still governs Host composition and profile configuration.

## Alternatives considered

**Put every preference in Cordis.** This requires a working Host. Reading `cordis.patch.yml` directly in Electron duplicates configuration evaluation; a patch alone omits plugin defaults and other configuration layers.

**Move every setting shown in Desktop.** Interface placement does not imply a Host-independent requirement. This splits shared Web/Desktop preferences and moves configuration away from its consuming plugins.

## Consequences

Shell and Host configuration have separate owners. Each setting needs documented ownership and effective timing. Independent shell configuration supports additional Host-independent functions without introducing a second application backend.

Existing settings are candidates for individual evaluation when their functionality changes or a Host-independent use is required. This is an evaluation direction, not a scheduled migration or predefined list. A migration must identify a single authoritative source, transfer existing values and define when changes take effect, without ambiguous precedence between two stores. Shared Host-managed settings remain in Cordis unless their ownership requirements change.
