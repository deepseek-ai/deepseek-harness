# Agent Note: Keep plugin-install interception for the page lifetime

Status: implemented
Archived: 2026-09-30

English | [中文](2026-09-27-plugin-install-interceptor-lifetime.zh.md)

## Problem

The [plugin-install scenario](../../../../apps/web/tests/plugin-install-cancel.e2e.ts) can leave a directory read pending after cancelling an installation. The Host emits invalidations that trigger background reads while the scenario removes its Playwright routes between installation phases. A stalled read keeps the installed package out of the list, so enabling it closes the dialog but never exposes the highlighted card.

## Decision

The scenario registers its `installBundle` and `cancelInstall` interceptors before navigation and retains them until the browser closes. Each interceptor calls a typed handler that the scenario replaces when it changes phases. The delivery and cancellation barriers retain their ordering, and `activeReplySettled` joins the lost-response handler before the next installation starts. Ordinary requests still reach the real Host.

The [scenario](../../../../apps/web/tests/plugin-install-cancel.e2e.ts) separately waits for the highlighted card's status to become `running`. Keeping interception active lets the directory read complete; polling its result still establishes the state the golden records.

## Alternatives considered

**Remove routes with `unrouteAll({ behavior: 'wait' })`.** Waiting for matched handlers does not settle unrelated browser requests. A captured Chromium protocol trace shows `Fetch.disable` immediately followed by a `pluginManager/listPlugins` request with no response or failure before teardown. The Host's inventory and plugin methods still answer direct calls.

**Advance the browser clock or extend the locator timeout.** Advancing the paused clock does not release the stalled request. The 2.4-second highlight expiry is not responsible for a package that never reaches the directory.

**Add a general route-switching helper.** Two endpoint handlers in one scenario do not need another fixture API. Their local delegates preserve the existing cancellation and lost-response cases without changing the browser's interception configuration.

## Verification

The unchanged scenario passes alone and fails at the same highlighted-card locator in one of four concurrent independent processes. Instrumented failures place the unanswered directory request inside the second `unrouteAll` interval; advancing the page clock leaves it unanswered, while direct Host reads complete. The protocol trace identifies the interception transition independently of the DOM assertion.

`DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/plugin-install-cancel.e2e.ts` passes in four concurrent independent processes (1/1 each). One protocol capture observes one `Fetch.enable`, no `Fetch.disable`, and responses for all 33 directory requests. The existing goldens cover cancellation before delivery, cancellation of the running child, manifest and lockfile restoration, retry, enabled-card status, both themes and motion preferences, highlight expiry, and lost-result recovery.

## Consequences

The browser retains two narrowly matched interceptors for its lifetime. The scenario controls their behavior without interrupting concurrent directory reads, and browser closure owns their cleanup. Product code, goldens, test deadlines, and CI worker counts are unchanged.

Live-page `unrouteAll` calls also remain in [sidebar-terminal](../../../../apps/web/tests/sidebar-terminal.e2e.ts), [queue-image](../../../../apps/web/tests/queue-image.e2e.ts), [subagent-conversation](../../../../apps/web/tests/subagent-conversation.e2e.ts), and [subagent-interrupt-ui](../../../../apps/web/tests/subagent-interrupt-ui.e2e.ts). These are candidates for separate overlap investigations; this scenario's reproduction does not establish the cause of failures in those tests.
