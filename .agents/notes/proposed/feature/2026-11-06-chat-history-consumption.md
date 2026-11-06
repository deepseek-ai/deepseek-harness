# Agent Note: Chat history prefetch and safe consumption

Status: proposed

English | [中文](2026-11-06-chat-history-consumption.zh.md)

## Problem

With only a Load earlier button, readers must reach the beginning of loaded history before clicking. Prefetch can reduce interruption, but a request that starts in a suitable state can return during touch dragging, a navigation change, or a fold animation. History prepending must not change the existing fold driver or simulate momentum.

## Proposal

Separate requesting history from consuming it. The Client Session retains at most one unconsumed page, and Chat decides whether and when to publish it. It retains the new page rather than an old window snapshot, so waiting does not block streaming at the tail. Class ownership and calls are described in the [technical details](2026-11-06-chat-history-consumption-details.md).

### Manual and automatic loading

A manual click retains one loading intent: consume an existing page, join an in-flight request, or request a page. Once data is available, the click bypasses automatic motion and input blockers: it uses the first paging anchor at the top, or captures the current reading anchor elsewhere with the paging anchor as fallback, and consumes through existing preservation without waiting for an animation callback. If neither anchor is available, consumption still proceeds without a position guarantee. The operation ends with consumption, confirmed exhaustion, or an explicit failure. A newer Turn jump, return to bottom, view closure, or other navigation or lifecycle change can cancel the earlier reading intent.

Automatic loading requests history after the reader leaves tail following and comes within two viewport heights of the history control. It reuses the existing 500ms reading sample, scroll completion, content commits, and size notifications, without another polling loop or IntersectionObserver. Detection can therefore wait until the next existing sample.

A cached page and an intent to continue automatically are separate facts. Automatic loading falls back to a button on occasional conflicts instead of waiting for every state to recover. Touch and actual inner scrolling retain continuation so mobile readers need not click after every finger release.

| State when data is ready | Automatic intent | Manual intent |
|---|---|---|
| Ordinary outer momentum, with other conditions satisfied | Consume with native browser anchoring | Consume through current-anchor preservation |
| Stationary reading away from the top | Consume with existing reading preservation | Consume with existing reading preservation |
| `scrollTop ≤ 0.5`, with other conditions satisfied | Reuse the paging anchor and correct once after prepend | Consume through current-anchor preservation |
| Folding, revealing, or an existing follow animation | Keep the page and return to the button | Consume the available page through existing preservation |
| A finger held down or actual inner scrolling | Retain intent before testing motion blockers; recheck afterward | Consume the available page through existing preservation |
| A held mouse pointer, scrollbar dragging, or temporarily unavailable positioning | Keep the page and return to the button | Consume the available page; no anchor means no position guarantee |
| Tail following resumes after automatic prefetch | Keep the page and cancel automatic consumption | The click has paused tail following |
| Streaming continues at the tail | Does not itself block consumption | Does not itself block consumption |

After fallback, scrolling, animation completion, and content notifications cannot reactivate that cached page; only a click or explicit navigation can adopt it. Requests and unconsumed pages remain mutually exclusive: no duplicate request for a cached page and no timeout that forces insertion.

### Position and status presentation

The actual conversation scrollport uses `overscroll-behavior-y: none` to suppress vertical boundary bounce and scroll chaining, without implementing a different momentum animation. An automatic prepend at the top reuses the existing paging-position record and correction calculation, applies it once, and releases it; manual consumption and stationary preservation retain their existing persistent lifetime. Both modes restore the screen position captured immediately before consumption with the same formula; they differ only in whether preservation remains active afterward. The one-shot path does not reconstruct intervening reader movement or restart momentum. Consumption completion also settles and clears the one-shot record when the visible Node order does not change; view closure or history failure discards it without applying it.

The history control keeps the same height across states. Loading and Processing remain clickable to join the current request or consume the cached page; only confirmed exhaustion disables the button. A network request shows Loading earlier; an active consumption intent without a held input shows Processing; automatic fallback or a held input shows Load earlier; failure shows Retry loading; consuming the final page shows Start of conversation. The control is excluded from native anchoring. Session `historyWasPartial` records that this instance has displayed incomplete history and survives component remounts and reconnects; a short Session that opens complete has no history row.

### Scope and retained decisions

Do not add `flushSync` or change Conversation publication cadence, fold-batch targets, or ScrollFollow policy. Consumption admission reads only internal state and `scrollTop`; DOM geometry reads belong to distance confirmation and position correction. Do not add an independent persistent head-anchor controller, `batchShift`, or a per-frame compensator.

[One fold motion](../../implemented/architecture/2026-10-13-chat-single-fold-motion.md) and [group-tree exchanges](../../implemented/architecture/2026-10-11-chat-group-tree-exchanges.md) retain ownership of folding and grouping decisions; this proposal does not supersede them.

## Alternatives considered

**Prepend every response immediately and compensate continuously.** That makes pagination take over existing motion; this design corrects once at the top and waits or falls back on conflicts.

**Automatically wait for every unsafe state to recover.** That adds coordination obligations for occasional animations, navigation, and automatic continuation; retain touch continuation and manual completion, but return other automatic conflicts to the button.

**Remove staging entirely or discard conflicting pages.** Conflicts can start during a request, and the transport history cursor may already have advanced; retaining one page is simpler than rolling back that cursor.

**Disable loading whenever a Turn is running.** Readers still need history during long replies, so execution state cannot replace the current presentation conditions.

**Separate IO prefetch wakeups and React synchronous-commit control.** Reuse existing sampling and publication, accepting sample latency; do not add commit scheduling without evidence of a concrete failure.

## Acceptance criteria

- Requests, staging, and consumption never duplicate a page request; tail streaming continues.
- Ordinary events do not revive automatic fallback; touch, inner scrolling, and manual clicks retain their specified continuation.
- Stationary and top-edge prepends preserve old content position; ordinary automatic momentum consumption adds no outer JS scroll write.
- Failure, no progress, exhaustion, reconnect, and explicit navigation have defined outcomes without request loops or stale-page consumption.
- Control states have equal height; existing fold-driver behavior is retained, and browser evidence identifies the current build, simulated inputs, and missing cases.

## Risks

One-shot correction restores a captured screen position rather than estimating reader velocity. Input or browser movement between capture and application can therefore affect the resulting motion; validation must cover the actual browser and input sequence. The shared formula does not add scroll-position deltas that could already include native anchoring. See the [technical risks](2026-11-06-chat-history-consumption-details.md#risks).

CSS feature support alone does not establish that native anchoring can act. Automatic prefetch waits for the first size observation, and the 500ms sample can let fast scrolling reach the top first. The synchronous geometry read after insertion is a cost of one-shot correction; its call site alone does not prove that it adds no layout. Manual consumption without a usable anchor can move visible content. It can also establish persistent preservation during an already active touch gesture, constraining that gesture or its momentum until a new reading input releases the anchor; see the [manual paging limitation](../../../../packages/client/ui-chat/README.md#known-limitations-and-deferred-work).

Audit and measurement are ongoing, so this record remains proposed. Earlier Chrome/Safari manual feedback and headless results from different iterations do not establish a complete matrix pass for the final source; actual scrollbar dragging, same-document reconnect, cross-platform input, and exceptional cleanup paths require separately attributed evidence.
