# Agent Note: Web conversation clocks on the fixture day

Status: implemented

English | [中文](2026-09-26-web-conversation-clock-fixture-day.zh.md)

## Problem

Run 36157253018 (job 108144715986, `node 24 / snapshots and artifacts`) failed four browser scenarios in one pass — [steering](../../../../apps/web/tests/steering.e2e.ts), [markdown-images](../../../../apps/web/tests/markdown-images.e2e.ts), [message-actions](../../../../apps/web/tests/message-actions.e2e.ts), and [reference-composer](../../../../apps/web/tests/reference-composer.e2e.ts) — with one aria difference: a message rendered `… and stop. 9/25 23:58` where its golden records `… and stop. {{clock}}`.

[`newEnglishPage`](../../../../apps/web/tests/support.ts) pins the browser to `Asia/Shanghai`, and [`formatMessageClock`](../../../../packages/client/ui-chat/src/client/chat/message-chrome.ts) prefixes `clock.md` / `clock.ymd` to the clock as soon as the message's local calendar day or year differs from the renderer's. These scenarios left both clocks on the wall clock, and their message times are stamped during the run: a live composer send by the Host, a seed whose fixture header carries `createdAt: 0` anchored at `Date.now() - 60_000` by `seedSession`. The failing job started at 15:54Z, six minutes before local midnight, so rows stamped before it were captured after it and rendered a date prefix; the next run of the same scenario passed minutes after midnight.

The lane already carried the remedy — [`WEB_FIXTURE_TIME`](../../../../apps/web/tests/support.ts), documented as the same-day anchor for seeded event times and the `Asia/Shanghai` browser clock, and used by seven other scenarios — but these four scenarios never adopted it.

## Decision

The four scenarios read the fixture day on both clocks.

Live-stamped scenarios pin the Host clock with `pinHostClock()`, a `Date.now` spy advancing from the anchor with real elapsed time, and the browser clock with [`pinBrowserClock(page)`](../../../../apps/web/tests/support.ts). Seeded scenarios anchor the seed through `seedSession`'s `createdAt` argument and pin the browser clock the same way.

The seed anchor is not only the rendered clock: the sidebar's relative ages are computed against the browser clock, so a pinned browser with a live-anchored seed reads `8mo` where the [message-actions](../../../../apps/web/tests/message-actions.e2e.ts) fork golden asserts `now` and `1min`.

`pinBrowserClock` re-applies one frozen instant from the anchor on an interval instead of leaving it at a single value, because product code reads two `Date.now()` values to decide how long a rendered value is held: the step process keeps its previous title for `PROCESS_TITLE_MINIMUM_MS` = 150 ms ([ChatGroupSeat](../../../../packages/client/ui-chat/src/client/chat/ChatGroupSeat.tsx)) and the composer keymap keeps a composition guard 10 ms past `compositionend` ([keymap](../../../../packages/client/ui-conversation/src/client/input/editor/keymap.ts)). Both compute the remaining hold as `Date.now() - previousReading`, which a permanently frozen clock never advances, so the hold never elapses and the golden's settled text stays unrendered. CI run 36179748541 (job 108218939163) caught exactly that on the first revision that froze the clock: `Preparing questions` where the steering mid golden records `Waiting for your action · Ready to continue?`.

The steering mid capture waits for that settled question title before it captures, and the [whole-queue scenario](../../../../apps/web/tests/steering.e2e.ts) calls the queue gesture only after the running turn's Stop control appears, so Enter's queue decision always resolves against an agent that already reports busy.

## Alternatives considered

**Collapse the rendered date prefix in the aria normalizer.** Collapsing `9/25 23:58` to `{{clock}}` in `normalizeAria` fixes the four scenarios with a two-line change, and it was measured: it passed the four files and then failed `cordis-tool-round`, `stats-paged-history`, and `navigation-panes` in one `DSH_WEB_SNAPSHOT_WORKERS=16` lane run, because their goldens deliberately record the dated form (`9/1 {{clock}}` and the year form in the Timing pane), and `skill-tool-row` already tokenizes that form as `{{date}} {{clock}}`. The two renderings state different facts — this row is from another day, this row is from today — so collapsing them deletes assertions instead of stabilizing them.

**Leave the browser clock frozen.** Pinning one instant for the whole scenario is simpler and passed the four files, but it removes elapsed time from every two-reading hold in the page, which is how the `Preparing questions` capture above happened. Re-applying the anchor keeps the calendar pinned without changing how long a held value is held.

**Pin the clocks for the whole lane.** Pinning inside `launchWebScaffold` and `newEnglishPage` would cover every scenario at once, including the ones that fail this way in future. It loses on blast radius: 83 goldens carry a clock and session-tree goldens assert literal relative ages, so a lane-wide now moves every scenario away from its own session and fixture times simultaneously, and each would still need its own anchor to read the buckets it was recorded with.

**Keep scenarios clear of local midnight.** Scheduling or refusing runs near the boundary leaves the dependency in place and fails the run instead of the code under test. The [CI readiness and completion decision](2026-09-08-ci-readiness-and-completion.md) already rejects budgets and retries as substitutes for a controlled observation.

## Verification

Two negative controls pin one clock and leave the other on the wall clock, reproducing the recorded signature exactly: `steering` with the browser clock pinned and the Host clock live fails its two golden tests with `… and stop. 9/26 {{clock}}`, and `message-actions` with the browser clock pinned and a live-anchored seed fails with `9/26 {{clock}}` on every clock line plus `now` where the fork golden asserts `1min`. Pinning both clocks passes both files, and their goldens are unchanged.

The queue scenario's start race is measured, not inferred: with the clocks pinned and no busy observation it failed 10 times in 61 runs of `vitest run … -t "queues two messages"`, all at the same `2 queued messages` wait; `origin/master` without the pins failed 0 of 41; with the observation added, 20 of 20 passed.

CI run 36179748541 (job 108218939163) shows the calendar fix holding under the lane's own topology: the prompt line matches `{{clock}}` where run 36157253018 rendered `9/25 {{clock}}`.

## Consequences

The four scenarios render the same aria line whenever they run, and their goldens keep asserting a clock without a date prefix. The calendar fact is owned per scenario: a scenario that types messages, or seeds a fixture whose header carries `createdAt: 0`, must read the fixture day on both clocks, or it inherits the midnight exposure. Product clock rendering, the `Asia/Shanghai` browser timezone, every committed golden, and the assertions of the scenarios not listed here are unchanged.
