# Agent Note: The busy Send button follows the Enter setting

Status: implemented

English | [中文](2026-09-04-busy-send-button-follows-enter-setting.zh.md)

## Problem

The Web composer offers one user-facing choice for submitting while the agent is running: the `ui-conversation.busyEnter` setting selects Queue or Steer. [Running drafts take the primary Send action](../../archived/bug-fix/2026-08-20-running-draft-primary-send.md) (archived) gave a running draft a pointer Send button, deliberately kept it off the preference to avoid an invisible mode on a button labeled only Send, and routed every click through the public `InputActions.submit()` face, which `SessionInputShell.actions` fixes to `'queue'`. A user who chose Steer in Settings got Steer from Enter and Queue from the button beside the same draft, with the button labeled only "Send message". Nothing in the composer explained the divergence, and the Settings row's title and description named only the Enter key, so the setting looked broken rather than deliberately partial.

## Decision

The running Send button delivers through the same mode as plain Enter. `InputBar` computes `resolveSubmitMode(busyEnter, running, 'enter', steeringAvailable)` once per render, where `steeringAvailable` is the same ordinary-Session-or-continuable-child predicate the keyboard path uses, applies it to the primary click through `ComposerKeyboard.submit(mode)`, and applies it to the primary label exactly when the click would deliver a plain message: the composer is running and steer-capable, the button is enabled (no file upload still pending), and the draft is non-empty, unclaimed, and not a `/` line headed for command adjudication. That state shows `input.send.queue` ("Queue message" / "排队发送") or `input.send.steer` ("Steer message" / "插话发送") as both the tooltip and the accessible name; every other state in which the seat is a Send button — idle sessions, one-shot children, locked composers, a continuable child's empty draft, drafts with a pending upload, and command drafts whose click executes the command rather than delivering a message — keeps `input.send` ("Send message"); an ordinary running session with an empty or owner-blocked draft shows Stop in that seat instead. Cmd/Ctrl+Enter still resolves to the opposite mode, and the empty-draft accelerated gesture still steers the whole queue. The [continuable subagent interrupt note](../feature/2026-08-06-continuable-subagent-interrupt.md) describes the child's Send with this delivery.

The composer bar's inject face carries the live preference instead of a resolver closure. `ComposerBarInjected.hooks.busyEnter` publishes `ComposerSubmissionPolicy.busyEnter`, so the bar receives a `useBusyEnter` selector hook and re-renders the label when the Settings row or a Host settings update changes the value. `resolveSubmitMode` is a pure exported function in `submission-policy.ts` taking the preference explicitly; the policy class keeps only the store and its Host adoption and write-through.

The Settings row is retitled to cover both inputs: "Send behavior while busy" / "繁忙时的发送行为", described as what Enter and the Send button do while the agent is running, with the Cmd/Ctrl+Enter opposite-mode note retained. The `busyEnter` field name, its `queue` default, and the Host schema are unchanged, so existing `settings.yaml` documents keep their meaning.

## Verification

`input-bar.client.spec.tsx` asserts that a running draft's button is labeled by mode and submits with that mode under both preferences, that flipping the preference store re-labels the mounted button before the next click, that idle Send keeps the plain label and Queue delivery regardless of the preference, that a continuable subagent's Send follows the same mode and label as an ordinary Session while its empty-draft disabled button and a one-shot child keep plain Send, and that a `/` line, a claimed command, and a draft with a still-uploading file keep plain Send while running. `submission-policy.client.spec.ts` pins `resolveSubmitMode` for every preference, running, gesture, and steering-availability combination. `enter-behavior-row.client.spec.tsx` and the `settings-chrome` ARIA goldens carry the new Settings copy. The keyless `live-interactions` Web scenario waits for "Queue message" on the parked running draft and asserts that no "Send message" button exists at that moment, and its `running-draft.expected.md` golden records the new name.

## Alternatives considered

**Keep the button on Queue and only reword the Settings row.** This preserves the earlier decision but leaves the composer with two submission paths for one draft under one setting. A user who prefers Steer still cannot get it by pointer, and the reworded row would have to document a keyboard-only scope that no other composer control shares.

**Add a second running button, one per mode.** Both delivery modes become reachable by pointer without a hidden state, but the ordinary session has one primary seat that already alternates between Stop and Send; a permanent second control spends space and introduces a hierarchy the draft itself does not need. The single setting already expresses the user's default, and Cmd/Ctrl+Enter remains the per-message override.

**Thread the mode through `InputActions.submit(mode)`.** Widening the public provide-channel face would let any session-scope slot pick a delivery mode, which no other consumer needs, and would move a composer presentation decision into the machine's public contract. The package-private `ComposerKeyboard.submit(mode)` already exists for exactly this purpose, so the button uses it.

**Keep `resolveSubmitMode` as a closure on the inject face and add a separate `busyEnter` hook only for the label.** Two sources for one fact invite drift between what the label says and what the click does. Publishing the preference once and resolving it in the bar keeps label and delivery derived from the same value in the same render.

## Consequences

The setting governs every busy-state submission a user can trigger with a message, and the button announces which delivery it performs, so choosing Steer no longer produces a Queue row from the button beside the draft. Users who relied on the button as an always-Queue escape while their setting selected Steer now use Cmd/Ctrl+Enter for that. The running Send label changes for every user, including under the default Queue preference, which the Web e2e scenarios that click Send during a running turn account for; idle-session flows and one-shot subagent composers see no change. The archived running-draft note's clause that the pointer action ignores the preference is reversed here; its primary-seat, owner-block, and subagent-control decisions stand as shipped and are described by the `ui-conversation` README.
