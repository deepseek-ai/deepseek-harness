# Agent Note: Shared Subagent settings card

Status: implemented

English | [中文](2026-09-16-shared-subagent-settings-card.zh.md)

## Problem

Delegation limits and model authorization describe the same Subagent workflow, but separate settings cards make users locate and save them independently.

## Decision

One Subagent page groups delegation limits and model selection, with one save button. Leaving the page discards both drafts. Both existing controllers retain ownership of their drafts, validation and namespace writes. The card blocks saving if either draft is invalid or conflicted, disables both sections during saving, and stays open after both settle successfully. A failed section retains its draft for retry. Limit explanations stay behind information buttons beside the field labels, with concrete depth examples and counting rules. Validation errors remain visible so disclosure does not hide a blocked save.

The plugin registers one `plugins.item` entry while either namespace is served. Its component renders only the available sections, preserving limits-only and model-only deployments without teaching the Plugins page about Subagent grouping.

## Alternatives considered

**Keep separate cards.** Independent controls obscure the relationship between delegation policy and model authorization and require separate save gestures.

**Merge Host namespaces.** UI grouping needs no change to persisted settings, namespace revisions or the different times these policies take effect. The existing namespace controllers preserve those contracts.

## Consequences

The user reviews both sections in one place. A save remains separate namespace writes, so partial success is possible; successful drafts clear while rejected drafts remain visible and retryable. Model authorization still writes its switch and routes atomically within its own namespace. The [package reference](../../../../packages/client/ui-settings-plugins/README.md) describes the controls and their applicability.

## Verification

Focused component and controller tests cover shared validation, save, discard on leaving, pending writes, partial failure and deployments serving either namespace. The assembled Web scenario saves both sections through one button and reads back the settings document.
