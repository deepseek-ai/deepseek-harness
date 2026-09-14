# Agent Note: Modify the Desktop profile in place

Status: implemented

English | [中文](2026-09-09-desktop-in-place-profile.zh.md)

## Problem

Staging preserves an old plugin installation but adds profile copying, directory moves, a recovery journal, and rollback state. Local plugin changes accept explicit repair after failure instead of this complexity.

## Decision

Desktop stops the Host and modifies the current profile directly. Shared host links are detached for package changes and restored when the operation settles. Package locking, dependency validation, and approved native builds remain. Compatible upgrades refresh links without copying plugin files.

Package or Host failures retain partial changes for repair and retry. There is no staging profile, activation journal, directory-swap recovery, or automatic rollback. Existing scratch directories are not interpreted or deleted.

This supersedes staging and rollback in [2026-08-25-electron-desktop-packaging-and-updates](2026-08-25-electron-desktop-packaging-and-updates.md), [2026-09-08-desktop-bundled-runtime-and-external-plugins](2026-09-08-desktop-bundled-runtime-and-external-plugins.md), [2026-09-09-desktop-immediate-window-and-direct-start](2026-09-09-desktop-immediate-window-and-direct-start.md). Other release, module-identity, and window-lifecycle decisions remain active.

A persistent `desktop-packages-pending` marker precedes package writes or native-runtime rebuilding and is removed only after installation, approved builds, and validation succeed. A later launch with that marker reinstalls the locked graph and retries pending builds even when recorded runtime metadata already matches. Ordinary unchanged startups reuse the profile without scanning the plugin dependency graph; package mutations and runtime reconciliation retain validation.

## Alternatives considered

Staging protects the previous installation at the cost of copying and crash recovery. Versioned directories still need preparation, selection, and cleanup. Direct writes give up automatic recovery; reintroduction requires an unattended-recovery product requirement that justifies these costs.

## Consequences

Tests cover offline initialization, in-place upgrades, failure before writes, retained changes after Host failure, partial pnpm failure, restored host links, and exclusive package ownership. Signed application and GUI acceptance remain release-environment checks.
