# Agent Note: GUI Full access risk confirmation

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-31-gui-full-access-confirmation.zh.md)

## Problem

Switching the web client to `danger-full-access` was a single click on a permission picker, with the preset shown as the title-cased machine name `Danger Full Access`. Full access reduces confirmation steps and lets the agent run sensitive operations, modify files, or execute external commands, so an accidental pick armed the most dangerous preset with no deliberate acknowledgement step.

## Decision

**Every permission picker gates `danger-full-access` behind the shared in-page `RiskConfirmation` dialog whose enabling action stays disabled until an explicit acknowledgement checkbox is checked; the preset renders under its locale-owned product label; every dismissal path submits nothing.**

- `RiskConfirmation` (ui-primitives) is a controlled Modal composition: title, description, acknowledgement checkbox, cancel, and a confirm button disabled until `acknowledged`. It stays an in-page dialog — the Modal portals to this document's body and never opens a native or separate browser window that could land on another display. `Modal` gains a `contentClassName` seat so the warning body scrolls inside constrained mobile/landscape viewports while the action row stays fixed.
- The composer chip (`PermissionSelect`, ui-conversation) intercepts a Full-access pick before the `/permission` submit: `confirmation`/`acknowledged` component state opens the dialog, confirm submits `/permission danger-full-access` through the same injected `command` path as every other pick, and cancel/Escape/close/mask leave the current preset untouched with the checkbox reset. The confirmation revokes itself when the session locks (`locked`/value-absent effect) and resets across task switches (`key={sessionId}` remount). Copy rides the standard `conversation` locale seat as `access.confirm.*` keys.
- The `/permission` popup (ui-permission over the ui-commands shell) gates through data, not a second dialog implementation: `SelectOption` grows an optional `confirmation` payload, the popup controller owns the `confirming`/`acknowledged` state transitions, and `PopupSelectView` swaps the picker card for the same `RiskConfirmation` while a gated option is pending.
- The General-settings Permission row uses the same controlled `RiskConfirmation` before persisting Full access as the default for later sessions. Its warning names that future-session lifetime; cancel, Escape, close, and mask dismissal leave the stored default untouched.
- Canonical built-in preset names render through each picker's locale dictionary (`Full access` in English and `完全权限` in Chinese), while explicit host labels remain unchanged. Command and Settings writes keep the machine name on the wire, and each warning body remains locale-aware in Chinese and English.

## Alternatives considered

**A native/OS or separate-window confirmation.** Rejected: the dialog must stay inside the current WebUI window; a second window can appear on another display and detaches the decision from the page state it guards.

**One shared locale namespace for every surface's safety copy.** Rejected: the ui-permission bundle and ui-conversation load independently, while the Settings warning names a different future-session lifetime. Each bundle owns its copy, and ui-permission keeps the popup and Settings dictionaries separate rather than importing across bundle boundaries.

**Gating in the host/permission backend.** Out of scope by design: the change is browser-client confirmation flow only; backend permission semantics, defaults, and the safer presets' one-click behavior are unchanged.

## Consequences

Every visible GUI path into Full access requires a deliberate, informed acknowledgement, at the cost of one extra dialog step for users who genuinely want the preset. New pickers reuse the shared dialog through their owning state machine or attach a `confirmation` payload to the popup path. Acceptance: the composer flow's gated cases in `input-bar.spec.tsx`, the popup gate in `popup-view.spec.tsx` and `popup.spec.ts`, the default-setting gate in `permission-row.spec.tsx`, the Modal/RiskConfirmation contract in `atoms.spec.tsx`, and the assembled Web replays.
