# Agent Note: Web lane assertions name their input state

Status: implemented
Archived: 2026-09-30

English | [中文](2026-09-27-web-lane-assertions-name-their-input-state.zh.md)

## Problem

Three browser-lane scenarios captured an aria region while a state the golden records was only implied by whatever the pointer, the keyboard, or an in-flight Host read happened to be doing at that instant, so each capture could land on the other state.

[workspace-new-session-folding](../../../../apps/web/tests/workspace-new-session-folding.e2e.ts) captures two goldens of one sidebar. `sidebar.expected.md` records the Workspace row with its row-actions cell revealed, which [Rows.module.css](../../../../packages/client/ui-workspace/src/client/rows/Rows.module.css) does under `.projectRow:hover`; `first-batch.expected.md` records the sixth session that way under `.sessionRow:hover`, the first row the batch reveals. Both captures therefore depend on where the pointer sits, and the scenario's own "Show 11 more sessions" click reflows the list under a stationary pointer. The serial self-hosted master lane failed this scenario with both goldens' requirements unmet — `treeitem "{{workspace}}"` without the actions, and the golden's hovered row rendering its plain relative time — in every one of the nine failing runs observed between 2026-09-24 and 2026-09-27.

[turn-tail-actions](../../../../apps/web/tests/turn-tail-actions.e2e.ts) captures the Copy footer focused twice: `running.expected.md` records a `tooltip "Copy"` beside it, `settled.expected.md` records none. [Tooltip](../../../../packages/client/ui-primitives/src/Tooltip.tsx) ignores focus while the last input came from a pointer, and only a keydown clears that flag, so whether the first capture shows the bubble depends on whether the harness pressed a key after the scenario's last click.

[plugin-install-cancel](../../../../apps/web/tests/plugin-install-cancel.e2e.ts) read the enabled plugin card's `data-plugin-status` once after the highlighted card appeared. The store's `enableInstalled` marks the card and starts the directory reload the Host answers, so the highlight is observable before the reload commits the enabled bundle into the list: the status flipped `disabled` → `running` 61 ms after the highlight in three local runs, and the run that failed read it inside that window.

## Decision

Each capture names the state its golden records before it captures.

The folding scenario hovers the Workspace row before the sidebar capture and the first row the batch reveals before the first-batch capture, so both hovered rows are established rather than inherited from the layout around the Show-more click. The goldens, the folding quota, and the row rendering are unchanged; the scenario now performs the hover a reader of the golden would perform.

The turn-tail scenario clears the pointer flag with a key that moves nothing, focuses the Copy button, and waits for the tooltip the running golden records. The settled capture keeps the plain focus, which is what its golden records once the Stop click has left the pointer owning the last input.

The install-cancel scenario polls the card's status instead of sampling it, so the assertion observes the directory reload that the highlight precedes. The highlight stays the locator that finds the card, because the later `2400 ms` clock advance still asserts the card detaches with it.

## Alternatives considered

**Collapse the hovered and unhovered renderings in the aria normalizer.** The two renderings state different facts — one row is hovered, the others are not — and both goldens deliberately record the row-actions cell and the relative time. Collapsing them would delete the assertion rather than stabilize it, the same trade every lane golden that deliberately records a dated or stateful form already rejects.

**Deliver a blank event and keep the pointer where the click leaves it.** The button moves as the batch inserts, so the row under the pointer still follows layout: the folding negative control below reproduces the failure with the pointer inside the sidebar and no row hovered.

**Disable hover styling or the tooltip modality rule in the scenario.** Both are shipped rendering and interaction behavior the goldens are the evidence for; a scenario-local override would test a page the product does not serve.

**Raise the capture timeout or retry the comparison.** Neither establishes which state was captured; `captureStableAria` already waits for two equal consecutive snapshots, and it was satisfied by the wrong state — the limit the [CI completion decision](2026-09-08-ci-readiness-and-completion.md) and the [connection and compaction fixture preconditions](2026-09-12-connection-and-compaction-fixture-preconditions.md) already record.

## Verification

Two negative controls reproduce the recorded signatures with the shipped assertions. Hovering the New Session row instead of the Workspace row before the folding scenario's first capture fails `sidebar.expected.md` with `treeitem "{{workspace}}"` where the golden records `treeitem "{{workspace}} Workspace actions …"`. A bare mouse press with no key before the turn-tail scenario focuses the Copy button raises no bubble, and the running capture then fails with the missing `tooltip "Copy"` the serial lane recorded. Both controls pass after the change.

Measured locally, one file at a time: `DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/<file>.e2e.ts` → workspace-new-session-folding 15/15 before the change and 20/20 after, turn-tail-actions 8/8 before and 20/20 after, plugin-install-cancel 12/12 before and 20/20 after. The lane configuration `DSH_SNAPSHOT=replay DSH_WEB_SNAPSHOT_WORKERS=16 pnpm run test:web:ci` passes all three files in three consecutive local runs.

The install-cancel scenario also recorded a separate 30 s highlighted-card wait after the enable click closed the dialog: twice on `node 24 / snapshots and artifacts`, and once locally with the pre-change file on the same lane command. The page clock was paused, excluding highlight expiry. The [interceptor-lifetime decision](2026-09-27-plugin-install-interceptor-lifetime.md) owns the diagnosed directory-request stall and its fixture fix. The status poll still covers the read after the card appears.

The WebKit case the serial master lane also failed is not a scenario race and stays out of this change: `declared-reasoning.e2e.ts` launches Playwright's WebKit, the lane's step fetched that browser without its host libraries, and `browserType.launch` failed with "Host system is missing dependencies to run browsers". [ci.yml](../../../../.github/workflows/ci.yml) states the persistent VM image owns Playwright's Linux system packages and installs the dependency set only off the self-hosted pool, so repairing the image or the pool's ownership is a runner change, not a scenario one. Installing WebKit's libraries on a developer machine makes the file's 8 cases pass.

## Consequences

The three scenarios render the aria their goldens record whatever state the harness arrives in, and no golden, product surface, or timeout changed. The input state is now owned by each capture: a scenario that captures a hovered row, a focused Tooltip anchor, or a value published by a later Host read must establish that state itself. `document-preview.e2e.ts`'s spreadsheet-selection read has the same class of defect and stays with its own change.

[The task-detail close note](2026-09-28-detail-close-waits-on-observed-state.md) records the same class in the client unit lane, where the sampled state arrived through a post-commit effect rather than through an unsettled input.
