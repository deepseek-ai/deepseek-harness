# Agent Note: Sidebar default pages

Status: implemented

English | [中文](2026-09-08-sidebar-default-pages.zh.md)

## Problem

A guide with one registered entry adds a click without offering a choice.

## Decision

The Sidebar selects each default page from the registered guide-entry list. Exactly one entry opens that entry's page; zero or multiple entries open the guide. Resource viewers without guide entries do not affect this count. Explicitly adding a guide always opens a guide, and each pane holds at most one.

The [last-tab close rule](2026-09-08-sidebar-last-tab-close-rules.md) owns close protection: the sole docked guide remains open, while any other sole tab closes together with the column. The generic docking kit accepts a presentation callback and has no file-browser or guide policy. Moving tabs still settles empty panes, and layout state remains memory-only.

This replaces default-guide selection in [the shipped types](2026-09-05-sidebar-text-preview-and-file-tree.md) and explicit last-tab closing in [docking infrastructure](2026-09-04-right-sidebar-docking-infrastructure.md). Their registration, content-state, engine and layout ownership decisions remain active.

## Alternatives considered

**Count all registered tab types or currently open tabs.** Neither counts choices available on the guide; resource viewers need not contribute an entry.

## Consequences

One-entry compositions open directly into their registered page without hardcoding Files. Guide selection can still replace its own tab. Store and component tests cover registration counts; the assembled browser scenarios cover default Files, explicit guide creation, and returning to Files after closing a lone tab.
