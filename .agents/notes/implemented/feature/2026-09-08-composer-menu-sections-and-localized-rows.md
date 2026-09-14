# Agent Note: Composer menu sections, localized rows, and the File row

Status: implemented

English | [中文](2026-09-08-composer-menu-sections-and-localized-rows.zh.md)

## Problem

The composer's `+` button and a typed `/` listed every command in Host registration order as `name description`, all lowercase, with no glyphs and no grouping, beside a separate paperclip button for files. Under Chinese the rows stayed English because Host descriptors carry English text only, and a user who knew a command by its Chinese title could neither find it by that title nor see what to type. Issue #3567 and the design doc for it ask for two sections in usage order, a glyph and a left-aligned title per row with the description right-aligned, capitalized English titles, Chinese titles and descriptions that stay searchable in both languages and show the English command name, a Chinese fill for the Plan and Goal claims, and a File entry inside the menu.

## Decision

`ui-commands` owns the menu's presentation in `src/client/presentation.ts`: an Add section (`file`, `goal`, `plan`, `feedback`) and a Commands section (`compact`, `permission`, `model`, `export`), each in usage order, with rows outside both lists closing Commands in catalog order. The section lists are keyed by name; an empty query returns the sectioned rows, and a typed query returns the flat ranking of every visible row so the best match is always first.

The six built-in Host commands get their localized title, description, glyph, and claim token from the client. Stable identity selection and input resolution follow the [command identity decision](../architecture/2026-09-10-command-identities-and-composer-file-action.md). Contributions carry `label()`, `description()`, and `icon`, read on every candidate pass, so the `/model` row localizes without re-registration.

A menu pick fills the locale's claim token: under Chinese, picking Plan fills `/计划 ` and the submission executes `/plan `. A typed token keeps its typed spelling as the claim, because the composer reads the arguments after the token it holds. The effective Session catalog resolves Chinese and English aliases through the same input path in every locale.

The File row is an `action` contribution: a bare invocation consumes the trigger token and runs a client callback without submitting a message. Conversation owns that registration, its live availability, and the hidden file input. The menu replaces the separate paperclip button; the `+` button's accessible name and tooltip read "Add files or run commands".

`ui-input-trigger` renders the new row anatomy: `InputTriggerCandidate.label` is the title and a second search key of the shared `rankByName`, the name renders as a trailing alias when the label differs from it, `icon` accepts an icon component beside the reference glyph tokens, and the description is right-aligned. `ui-primitives` gains the Plan glyph from the design doc, a static ring for Compact, and the permission shield contour.

The menu uses a 400 px border-box height cap, which fits both headings and the eight built-in rows before the viewport clamp reduces it. A real overflow keeps a 10 px draggable WebKit rail around a 4 px visible thumb, insets the track from the rounded ends, and shows a bottom fade until the viewport reaches the final row; Firefox keeps its standard thin scrollbar.

## Alternatives considered

**Release a claim when its separator is deleted.** The complete command name still identifies the selected command. Keeping the claim until the name changes preserves its highlight through argument replacement and avoids relying on an IME-generated space to run ordinary keydown adjudication. The shared input machine applies this rule to every command token, including failure recovery; neither the command name nor the locale selects a separate implementation.

**Restore placeholders directly on native composition end.** Browsers can deliver that event before Lexical reconciles the final text. The shared editor binding keeps command hints and ordinary placeholders hidden while either native or editor composition remains active, and reevaluates visibility after an editor commit, including a cancellation that changes no text. Keyboard submit guards retain their separate post-composition window.

**Localize descriptions on the Host.** The Host has no locale and its catalog is shared by every client; localized product copy belongs to the client.

**Keep sections under a typed query.** Ranking inside sections put a prefix hit in Commands below weaker matches in Add (typing `e` listed Feedback and File above Export); a flat ranking keeps the best match first, and the headings only carry information while the list is complete.

**Keep the paperclip beside the menu.** The design doc and the issue's acceptance criteria integrate the entry into the menu and forbid the old icon from showing twice; the hidden file input and the drop gate stay where they were.

**A contribution-owned copy for the built-in Host rows.** Host packages have no client half to register from, so the copy has to live on the client; one table keyed by name in the package that already owns the `/` source keeps the design decision in one place.

**A `token` alias only under the active locale.** Resolving through every dictionary costs nothing and lets a draft persisted under one locale submit under another.

## Consequences

The menu and localized presentation remain client-owned, while the Host owns effective command definitions. Adding a localized first-party command requires its identity mapping, dictionary entries, icon, and menu position. Session-driven browser scenarios and owner-local ARIA expectations cover the menu. Unrelated same-name definitions keep their own copy and no first-party glyph. The command identity decision owns this distinction and the File action's lifecycle.
