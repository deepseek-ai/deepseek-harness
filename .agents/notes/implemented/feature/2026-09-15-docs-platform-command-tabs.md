# Agent Note: Platform command tabs in the Python SDK guide

Status: implemented

English | [中文](2026-09-15-docs-platform-command-tabs.zh.md)

## Problem

The [Python SDK guide](../../../../docs/user/guide/python-sdk.md) gives different commands for POSIX shells and Windows PowerShell. Showing both versions in sequence makes readers skip an alternative at each step and can make alternative commands look cumulative.

## Decision

Each of the four platform-dependent steps uses VitePress's native `code-group`: Linux/macOS first, Windows PowerShell second. Each group selects independently and starts on Linux/macOS. Credential setup and running the example remain separate sequential steps. Shared Python and YAML examples stay directly visible.

Both languages retain every command in canonical Markdown. The documentation projector preserves the groups and their code in the website's raw Markdown. Explicit anchors before each group preserve the former platform heading targets; following a platform anchor locates the group without selecting a tab.

The theme adds a visible keyboard focus outline to native radio labels and displays both command blocks in search excerpts, whose tab controls are unavailable. A Markdown renderer adapter makes each native tab strip a form with submission prevented. Local search copies a section's rendered HTML, including radio names; separate form owners stop those copies from clearing the page's selection. VitePress owns selection, syntax highlighting, and copying the active code block. MPA builds omit those client handlers, so build-only styles display both command blocks and hide the tab strip and copy buttons. There is no shared selection state or stored preference.

## Alternatives considered

**Keep vertically repeated platform sections.** Both versions are immediately visible, but the repeated alternatives interrupt the guide's ordered steps.

**Build a custom tab component with shared or persistent selection.** A Windows reader could select once, but shared state couples independent examples and introduces selection and lifecycle code beyond the required presentation. Native groups keep the interaction local.

## Consequences

SPA readers see one command version per step while MPA, repository, and raw-Markdown readers retain both. Windows readers select PowerShell in each group. Existing platform links still reach the corresponding step, although the platform names leave the page outline.

Verification covers command preservation, bilingual pairing, projected and raw Markdown, and actual browser switching, copying, keyboard focus, search, themes, and narrow layouts. Framework-owned interaction is exercised on the running site; session replay is inapplicable to this documentation-only presentation.

The focused renderer regression checks radio ownership when local search duplicates a section. The adapter depends on VitePress's native tab-strip markup and fails the build if that markup changes; a framework upgrade must retain the search isolation and browser checks.
