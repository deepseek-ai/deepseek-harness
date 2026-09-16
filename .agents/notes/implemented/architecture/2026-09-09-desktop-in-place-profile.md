# Agent Note: Modify the Desktop profile in place

Status: implemented

English | [中文](2026-09-09-desktop-in-place-profile.zh.md)

## Problem

Staging preserves an old plugin installation but adds profile copying, directory moves, a recovery journal, and rollback state. Local plugin changes accept explicit repair after failure instead of this complexity.

## Decision

Application-owned package retention is qualified by the [production cleanup decision](../bug-fix/2026-09-15-desktop-profile-core-cleanup.md).

Desktop stops the Host and modifies the current profile directly. Shared app-boot cleanup detaches its own fallback links before package changes; the Host’s shared profile runner supplies required links on startup. Package locking and configured lifecycle scripts remain. Upgrades refresh module links without copying plugin files.

Package or Host failures retain partial changes for repair and retry. There is no staging profile, activation journal, directory-swap recovery, or automatic rollback. Existing scratch directories are not interpreted or deleted.

This supersedes staging and rollback in [the packaging decision](2026-08-25-electron-desktop-packaging-and-updates.md), [the bundled-runtime decision](2026-09-08-desktop-bundled-runtime-and-external-plugins.md), and [the immediate-window decision](2026-09-09-desktop-immediate-window-and-direct-start.md). Host boot follows the [thin-wrapper decision](2026-09-10-desktop-web-wrapper.md); release, module ownership, and window lifecycle remain separate decisions.

Desktop delegates installation and lifecycle scripts to pnpm, without a pending-operation startup gate, frozen-lockfile reinstall, or automatic rebuild. Failed package operations preserve partial changes and leave disable, remove, and startup retry available. The Host inherits the user environment, and profiles may use directory links. An unchanged legacy Desktop-generated pnpm configuration is replaced with the Web defaults; customized configuration remains user-owned.

## Alternatives considered

Staging protects the previous installation at the cost of copying and crash recovery. Versioned directories still need preparation, selection, and cleanup. Direct writes give up automatic recovery; reintroduction requires an unattended-recovery product requirement that justifies these costs.

## Consequences

Tests cover offline initialization, in-place upgrades, failure before writes, retained changes after Host failure, partial pnpm failure, restored host links, and exclusive package ownership. Signed application and GUI acceptance remain release-environment checks.
