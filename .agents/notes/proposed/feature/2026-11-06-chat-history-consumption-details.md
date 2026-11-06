# Agent Note: Chat history consumption classes and interactions

Status: proposed

English | [中文](2026-11-06-chat-history-consumption-details.zh.md)

## Problem

Session owns a history page's network lifetime, while Chat owns whether that page can safely enter the current view. Two-phase loading must reuse existing publication and scrolling capabilities without copying business data, consumption intent, and DOM preservation state into one owner.

## Proposal

[History prefetch and safe consumption](2026-11-06-chat-history-consumption.md) defines user-visible behavior and trade-offs. This note defines class interactions and lifetimes without adding an independent scroll animation or React commit manager.

### Owners and interfaces

| Owner | Data and operations |
|---|---|
| [Session](../../../../packages/api/session-controller/src/client/sessions/session.ts) | `loadOlder({ deferConsumption?: boolean })` prepares and optionally consumes a page; `consumeOlder()` synchronously publishes a valid staged page; `historyLoadStatus` is idle/loading/pendingConsumption/error, and `loadingOlder` derives from loading, including Turn jumps |
| Session request record | Holds generation, starting cursor, page entries, hasMore, Promise, and consumption/invalidation flags; staging does not advance the visible window cursor |
| [ChatNavigation](../../../../packages/client/ui-chat/src/client/chat/use-chat-navigation.ts) | Owns none/auto/manual consumption intent and request exclusion; waits or falls back by blocker; only manual consumption registers a fold-completion callback |
| [ChatViewport](../../../../packages/client/ui-chat/src/client/chat/use-chat-viewport.ts) | Reads internal input/motion state and scrollTop, returns a blocker or native/preserve/prepend, and performs distance measurement and existing anchor algorithms |
| [useChatScroll](../../../../packages/client/ui-chat/src/client/chat/use-chat-scroll.ts) | Connects existing reading, scroll, content, and size notifications to consumption checks and settles a pending one-shot correction during commit handling |
| [ChatView](../../../../packages/client/ui-chat/src/client/chat/ChatView.tsx) | Requests and consumes through injected callbacks and reads state through useSession; renders a fixed-height history control without retaining Session history data or accumulating historyWasPartial |

```text
ChatNavigation.checkHistory
  ├─ pendingConsumption + intent=none → retain page until clicked
  ├─ pendingConsumption + intent=auto/manual → viewport.historyConsumption
  │    ├─ touch/inner-scroll → retain consumption intent
  │    ├─ motion/pointer/unavailable → auto falls back, manual waits
  │    ├─ native → consumeOlder
  │    ├─ prepend → capture paging position → consumeOlder → correct once after commit
  │    └─ preserve → beginPreserving → consumeOlder
  ├─ loading → no duplicate request
  ├─ error → wait for explicit retry
  └─ idle + hasMore + (manual intent or near top without following) → request a page

Session.loadOlder
  → prepareOlder reuses or creates the request
  → await the captured request Promise
  → consumeOlder when request identity remains valid and consumption is not deferred

Session.prepareOlder
  → network prepend → capture the page without publishing eventSource
  → validate progress → pendingConsumption or error

Session.consumeOlder
  → check generation/cursor/consuming
  → synchronous eventSource.prepend → existing Conversation merge and flush
  → clear the request record and publish final status
```

### Data lifetimes

`isOpen` means only that Session `openState === 'open'`; it is independent of whether a page is `pendingConsumption`. `historyWasPartial` is monotonic for one Client Session instance: once its visible window has `hasMore=true`, the fact remains until the instance ends, across component remounts and reconnects, without entering the persistent log.

`prepareOlder()` returns an existing request or creates one, and `loadOlder()` rechecks identity after awaiting that captured request Promise. An obsolete Promise cannot consume a newer page. A default call consumes the prepared page; `deferConsumption` retains a valid nonempty page, while an empty terminal page can immediately confirm exhaustion. Consumption retains the request record and sets `consuming` to prevent synchronous subscriber reentry without borrowing the network loading state.

An ordinary request captures the transport page first. It can be consumed only after the request succeeds and its cursor advances, or an empty page explicitly confirms exhaustion. Failures and empty pages that still claim more history enter error without automatic retry. Window replacement, reconnect, and disposal invalidate old pages; when an in-flight request may have advanced the transport cursor, the existing stream restart restores a baseline before another page is allowed.

`loadThrough(seq)` is explicit navigation: it first adopts a staged page and then uses existing Turn-aligned paging. An ordinary in-flight request remains exclusive, and the caller continues after it settles. A jump publishes its successful prefix once at completion or a later failure, without delaying live appends. `loadingOlder` always equals `historyLoadStatus === 'loading'`.

### Consumption intent and wakeups

An automatic request records auto intent; a click records manual intent. Successful consumption, failure, exhaustion, or navigation cancellation clears the intent. A cached page with none intent is neither measured nor consumed by ordinary events; its button records manual intent without requesting it again. Motion, pointer, or unavailable positioning returns auto to none; touch and inner-scroll retain auto. Manual intent waits through these blockers rather than treating deferral as success.

Prefetch reuses the existing 500ms reading sample, scrollend, content commits, and size notifications, coalescing them into one rAF check. It uses no IntersectionObserver or additional sample timer and measures nothing in the raw scroll event. Only a ResizeObserver entry for the scroller itself refreshes cached clientHeight during the callback's read phase; column growth does not reread viewport height. Once internal state permits an automatic request, it reads the history control's distance from the viewport and compares it with two cached viewport heights.

`historyConsumption()` does not query DOM nodes or measure sizes. `FlowMotion.active()` exposes existing running, batchScheduled, batch, and settling state as a read-only query; passive listeners maintain input state. Size observation removes detached scrolling targets. Finger release, inner scroll completion, transition completion/cancellation, and existing notifications can wake retained intent; fold-completion callbacks are registered only for manual intent. Without consumption intent, these notifications do not revive an abandoned automatic page.

### Shared anchors and layout reads

At `scrollTop ≤ 0.5`, selection uses `beginPaging`'s first paging-anchor rule without a reading-position hit test. `measurePaging()` only captures a `PagingPosition`; `retainPaging()` separately owns persistent preservation and inner-size observation. Stationary preservation and one-shot correction share remount resolution in `resolvePaging()` and inner/outer calculations in `applyPaging()`.

Persistent preservation restores the captured screen position. One-shot correction retains inner and outer scrolling since capture and compensates only layout displacement; it neither enters paging state nor subscribes to inner-size changes, and releases after one application. `finishHistoryPrepend()` returns the actual landing, and commit handling immediately saves it through `reading.preservePosition()` rather than waiting for a later scroll event. The actual conversation scrollport uses `overscroll-behavior-y: none`, without creating smooth scrolling or a new momentum animation.

Distance confirmation still needs current geometry, and one-shot correction after prepend still needs the new position. These reads serve correctness, but placement inside rAF, ResizeObserver, or commit handling alone does not prove they add no layout. Read frequency, read/write ordering, and actual Layout/Paint costs require separate verification; position stability is not performance evidence.

## Alternatives considered

**Pause publication globally in Conversation.** That also blocks live tail output and expands the cross-view impact.

**Retain a complete window snapshot in Chat.** That copies business data and can overwrite messages received while waiting.

**Store separate coordinates and continuously track the first row for one-shot correction.** That duplicates existing paging anchors and can expand scroll ownership; share the position record and calculations while keeping lifetimes separate.

## Acceptance criteria

- Default single-stage calls, deferred consumption, and Turn jumps coexist; an old request cannot consume or overwrite a new one.
- Ordinary events do not revive automatic fallback; touch/inner-scroll continuation, manual completion, and unmount cleanup have focused verification.
- One-shot correction does not register persistent observation or undo intervening reader movement; existing persistent and inner preservation do not regress.
- Distance checks use cached viewport height; raw scroll listeners and consumption admission perform no layout reads.

## Risks

**Known issue: `preserveMovement` cannot distinguish native anchoring from reader input.** The shared correction adds changes in the outer and inner scroll positions since capture. A deterministic geometry model confirms duplicate compensation when the browser has already anchored the same prepend: an outer `scrollTop` of `0.5`, or outer `0` with inner `40`, enters the one-shot path and treats the native adjustment as movement to preserve. The resulting additional displacement is an algorithmic limitation, not evidence that every browser exhibits it. Code remains unchanged for this report-only finding; independent actual-browser verification is pending.

Explicit navigation and multiple views share a Session, so Chat's automatic waiting policy must not move into the global event source. Manual intent can still wait if usable positioning never becomes available; actual views need cancellation, reconnect, and anchorless-structure verification. One-shot geometry measurement, native inner anchoring, and asynchronous content growth need browser evidence from the current build.

Reports must identify source/artifact versions, real or synthetic inputs, missing conditions, and cleanup results. V8 function or range hits are not TypeScript line/branch percentages; earlier iteration recordings, Chrome/Safari manual feedback, or a successful build do not establish a complete matrix pass for this proposal.
