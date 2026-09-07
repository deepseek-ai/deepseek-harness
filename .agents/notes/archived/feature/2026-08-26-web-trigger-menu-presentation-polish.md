# Agent Note: Web trigger menu presentation polish

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-26-web-trigger-menu-presentation-polish.zh.md)

## Problem

The Web composer's `/` and `@` trigger menu carried several presentation defects that made the reference flow harder to read and operate. Candidate rows spelled their kind as a localized text prefix (`Folder · name/`, `Session · label`) that duplicated the section title and pushed the name right. Pointer hover used a CSS `:hover` tint while keyboard navigation drove the reducer-owned highlight, so two rows could look focused at once. The drillable-folder affordance was a raw `›` text glyph, unlike every other chevron in the composer, and nothing told the user that Tab drills into the highlighted folder. The pending-source state was a bare "Loading…" text row. The editable `@dir/` text a drill leaves behind rendered a folder icon before the `@`, visually double-marking a token that is not a settled chip. The composer placeholders never mentioned that `/` and `@` exist ([#3080](https://github.com/deepseek-harness/deepseek-harness/issues/3080)).

## Decision

Candidate rows lead with a domain icon instead of a text prefix: `InputTriggerCandidate.icon` narrows from `string` to the closed union `InputTriggerCandidateIcon` (`file | folder | session`), the menu view maps it to `ReferenceIcon`, and `ui-reference` emits bare names (`folderx/`, session label). The `candidate.file`/`candidate.folder`/`candidate.session` locale keys are deleted; the session section title is `对话`/`Sessions`. The menu spans the composer card edge to edge (`left: 0; right: 0`), and a pending source renders two breathing skeleton bars in item cell metrics instead of the loading text row.

Pointer and keyboard share one highlight, last input wins: a `hover` MenuEvent parks the reducer-owned highlight on a ready row, `MenuView` routes it from `onMouseMove` (not `mouseenter`, so keyboard-scrolling rows under a resting pointer cannot steal the highlight back), and the CSS `:hover` tint is gone.

The drill affordance on the highlighted folder row is the library `IconChevronRightOutline14` in the quiet `--dsw-alias-label-caption` tint the access-mode chevron uses, preceded by a localized "Browse folder" caption and a `Tab` keycap that reveal only while the row holds the shared highlight.

A token still carrying its trigger character is editable text, not a settled chip: the text-ref decoration colors it and nothing more, and the domain icon belongs exclusively to the settled `ReferenceChipNode`. The former appearance channel (scan `appearance` field, `TextRefNode.__appearance`, `data-ref-appearance` DOM attribute, CSS `::before` icon) is deleted end to end.

Composer placeholders advertise both triggers (`描述你想要构建的内容… / 调用指令 @ 文件或对话` / `Describe what you want to build... / commands, @ files or sessions`), and the zh copy for commands is unified from 命令 to 指令 across `ui-chat`, `ui-conversation`, `ui-goal`, and `ui-input-trigger`.

## Alternatives considered

**Keep the CSS `:hover` tint alongside the keyboard highlight.** Rejected: two rows can look focused at once while `aria-activedescendant` names only one, and Enter acts on the keyboard row while the eye may rest on the hovered one.

**Route hover from `mouseenter`.** Rejected: when arrow keys scroll new rows under a stationary pointer, each row entering the pointer re-fires `mouseenter` and steals the highlight the user just moved; `mousemove` fires only on real pointer motion.

**Keep the folder icon on the editable `@dir/` text.** Rejected: the icon before the trigger character double-marks the token and erases the visual distinction between "still editable text" and "settled chip"; reserving the icon for the chip makes the two states readable at a glance.

**Show the Tab hint on every drillable row.** Rejected: idle rows carrying persistent keycaps add noise; the hint teaches the key exactly when it applies — while that row is the one Tab would act on.

## Consequences

The kind information every row used to spell in text now rides the icon and section title; a future candidate kind must extend `InputTriggerCandidateIcon` and pick an icon rather than pass an arbitrary string. Pointer motion round-trips through the reducer (`hover` is a no-op for the already-highlighted row, so mousemove storms do not churn state). Drill discoverability rests on the highlight: an idle folder row shows only its chevron until hovered or reached by keys. Deferred follow-ups — settle-on-space for exact-match tokens and `name` vs `name/` labels — remain tracked in [#3154](https://github.com/deepseek-harness/deepseek-harness/issues/3154); candidate description content, back navigation after a drill, and reference search latency are settled by the [@ mention discovery and row content note](2026-08-27-web-at-mention-discovery-and-row-content.md).
