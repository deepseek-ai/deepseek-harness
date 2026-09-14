# Agent Note: Guide start page and stat pill refinements

Status: implemented

English | [中文](2026-09-10-guide-start-page-and-stat-pill-refinements.zh.md)

## Problem

The right Sidebar's guide tab was a bare list of entry capsules: no visual anchor above them, a capsule could only say its title, and an entry whose type registered no glyph rendered with no icon at all, so a mixed list read as broken rather than sparse. Separately, the session token-usage dialog under the composer printed a `Cache write 0 tok` row for sessions that never wrote cache.

## Decision

**The guide is a compass over self-describing capsules.** This refines the guide contracts in [Right Sidebar tab types and navigation](../architecture/2026-09-05-sidebar-tab-types-and-navigation.md) and [Sidebar text preview and file tree](2026-09-05-sidebar-text-preview-and-file-tree.md). [GuideBody.tsx](../../../../packages/client/ui-sidebar-right/src/client/tabs/guide/GuideBody.tsx) draws a muted 56px compass hero over the entry capsules and no heading, as a browser start page shows its doors without a caption. [`SidebarRightGuideEntry`](../../../../packages/client/ui-sidebar-right/src/client/tab-registry.ts) gains an optional thunked `description` — read fresh on every render like `title`, so language changes need no re-registration. A capsule shows its description under the title only while the guide lists at most `MAX_DESCRIBED_ENTRIES` (4) entries; a longer list drops every description to stay light, so a type must stand on its title. The glyph rides the capsule's height: 22px beside a bare title, 26px beside two lines.

**Icon-less entries fall back to a shipped cube placeholder.** The fallback is decided at the render site (`entry.icon ?? CubeGlyph`), not at registration, so every contributor — builtin or extension — gets it uniformly and a chain replacement of the body replaces the rule with it. `CubeGlyph` lives beside `CompassGlyph` in [GuideTitle.tsx](../../../../packages/client/ui-sidebar-right/src/client/tabs/guide/GuideTitle.tsx): an isometric box in 1.1px straight strokes with rounded joins on `currentColor`, drawn on `--dsw-alias-label-tertiary` — one step quieter than a registered glyph's ink — to mark the slot as unclaimed. The files type registers a description and the shared folder glyph in [definition.tsx](../../../../packages/client/ui-sidebar-files/src/client/definition.tsx).

**The session usage dialog drops the zero cache-write row.** This refines [Composer session stats](2026-09-07-composer-session-stats-pills.md). [StatsPills.tsx](../../../../packages/client/ui-chat/src/client/chat/StatsPills.tsx) renders the `Cache write` row only when `cacheWriteTokens !== 0`, as the per-turn panel already drops its absent optional fields; the always-present buckets (input, cache read, output) keep their rows.

## Alternatives considered

**Register the cube in `ui-primitives`.** Its `icons/index.tsx` is the imported figma `ic_ds_*` set, and the cube has a single consumer; `CompassGlyph` set the precedent of package-local guide glyphs.

**Default the icon at registration time.** A `?? default` inside the registry would hide the fallback from the body and make "registered no glyph" undetectable, losing the quieter placeholder ink; explicit render-site fallback keeps registrations honest.

**Show `Cache write 0`.** A session on a provider that never writes cache would carry the row forever; zero here means "not a thing", not a measurement.

## Consequences

`description` is new pre-stable registry API; every consumer was updated (the files entry registers one). The 4-entry threshold is a shipped constant of the guide body, not configuration. Guide-body specs cover the placeholder (size and ink), the description threshold on both sides, and the registered-glyph path; chat-stats specs cover the dropped and present cache-write row. The `ui-sidebar-right` and `ui-sidebar-files` READMEs restate the guide rules.
