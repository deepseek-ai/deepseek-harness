# Agent Note: Status-driven disclosure for workflow runs

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-11-workflow-run-status-driven-disclosure.zh.md)

## Problem

A durable workflow Chat node updates in place from its running prefix to a terminal record. The renderer must draw attention to new work, abnormal outcomes, and normal completion without repeatedly overriding a user's decision to reclaim conversation space.

The renderer already receives every durable lifecycle fact from the workflow Conversation Node. Disclosure choice therefore belongs to the mounted presentation, but its lifecycle must also preserve nested phase choices when the outer run is hidden and avoid removing content that still contains keyboard focus.

## Decision

`WorkflowRunPanel` owns one local disclosure state for the run and a map keyed by the existing phase key. A phase is clean when every member completed, abnormal when any member failed, was cancelled, or was interrupted, and running otherwise. The run is abnormal when its own status or any phase is abnormal, running when its own status or any phase is running, and clean only when the run and every phase completed normally. A mount opens running and abnormal levels and closes clean levels.

Each level records its current mode, append-only member count, open choice, and any pending clean close. Ordinary updates within a running or abnormal interval preserve the user's choice. A phase transition from clean to activity opens that phase and the outer run once, the first transition into abnormal opens once, and a transition into clean closes once. A member-count change while a phase remains clean represents a complete activity cycle delivered in one render: it closes an open phase review and, while the run remains active, opens the outer run once without adding an activity epoch or durable field. After an automatic action, mouse, Enter, and Space control the level until another defined edge occurs.

Phase state remains in `WorkflowRunPanel` while the outer disclosure hides its children, so closing and reopening the run restores each phase choice. Removing a phase deletes its entry; a renderer remount reconstructs every level from current durable facts rather than restoring an earlier choice.

Normal completion checks whether focus is inside the content before closing. Focused content remains mounted with current completed status and closes after focus leaves. When a navigable member becomes terminal while its button holds focus, `MemberRow` keeps the same button mounted as `aria-disabled` until blur; later terminal review renders the ordinary non-interactive row. This preserves the active DOM target without allowing terminal navigation or adding a focus manager.

The renderer adds no Session events, store, setting, acknowledgement, timer, automatic scrolling, persistent activity identity, or `DisclosureRow` API. It does not change workflow status derivation, phase grouping, member order, navigation eligibility, copy, or visual tokens.

## Verification

Component tests drive one keyed run and its phases through initial running controls, mouse and keyboard choices, ordinary running updates, outer hide and restore, phase completion, run completion, clean review, same-key renewed activity, a fully batched clean cycle, every abnormal status, first-abnormal escalation, later abnormal updates, zero-member completion, focused-member completion, sibling independence, and renderer remount. They also verify terminal navigation remains absent after the deferred focus path settles.

The shipped Web replay exercises the real workflow, worker, Session log, browser plugin graph, and child navigation. It collapses and reopens live run and phase controls, records the live collapsed status summary and ARIA state, verifies normal settlement folds both levels, confirms terminal review cannot navigate the member, and records the folded history reconstructed after reload.

## Alternatives considered

**Force every running or abnormal level open as a static row.** Rejected because it makes the attention state impossible to dismiss and removes truthful mouse, keyboard, and ARIA disclosure semantics.

**Keep one manual state initialized from the first render.** Rejected because later activity, abnormal escalation, and normal completion cannot perform their one-time automatic actions.

**Let each phase own state inside its disclosure content.** Rejected because hiding the outer run unmounts that content and discards independent phase choices during the same mounted workflow record.

**Persist expansion, acknowledgement, or an activity epoch.** Rejected because current workflow facts and the append-only member count provide every required edge. Persistence adds a second durable owner and synchronization semantics that this presentation choice does not need.

## Consequences

Workflow records call attention to lifecycle changes while remaining dismissible in every status. Normal completion reclaims space, current focus remains safe, nested phase choices survive outer hiding, and the same durable record reconstructs a deterministic initial state on refresh or history replay.

The local lifecycle deliberately resets on renderer remount and cannot remember a choice across refresh, devices, or users. Adding that behavior requires a separate persistence and stale-choice decision rather than extending this presentation state implicitly.
