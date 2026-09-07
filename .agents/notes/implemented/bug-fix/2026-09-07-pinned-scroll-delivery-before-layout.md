# Agent Note: Settle pinned scroll deliveries before layout changes

Status: implemented

English | [中文](2026-09-07-pinned-scroll-delivery-before-layout.zh.md)

## Problem

A delayed scroll sample compares positions from different layouts. While Chat is pinned, a composer or transcript shrink can move the browser floor; subsequent growth can move the browser position again before `scrollend` or the sampling timer. Deferring follow during that interval leaves the observed-top ledger stale and can classify browser layout movement as reader input, disabling follow without a reader gesture.

## Decision

[ChatView](../../../../packages/client/ui-chat/src/client/chat/ChatView.tsx) uses the existing observed-top comparison to sample non-reader pinned scroll deliveries synchronously through the same sample operation that clears pending work. This releases layout follow before further growth. Genuine reader movement remains pending until the existing interval or `scrollend`, even within the follow threshold: growth must not erase small gestures before they accumulate into a scroll-away. Immediate pinned samples use scroll metrics, not semantic-row geometry.

## Alternatives considered

**Defer every delivery.** Coalescing reduces geometry work while reading history, but a pinned browser position and its floor must be attributed in the same layout. A longer timeout or retry cannot recover ownership once the stale comparison disarms it.

**Sample every delivery synchronously.** This restores attribution but also repeats semantic-anchor and reading-line measurements throughout an away-reader scroll burst. Only pinned ownership needs the immediate path.

## Consequences

Pinned deliveries incur immediate scroll-metric reads. History reading retains its bounded sampling cadence, and explicit return-to-bottom deliveries clear any pending away sample. [Focused tests](../../../../packages/client/ui-chat/tests/chat-view.client.spec.tsx) cover shrink/regrowth before scrollend, observer growth without row measurements, repinning with a pending sample, timer and scrollend sampling, and unmount cancellation. The [keyless browser scenario](../../../../apps/web/tests/chat-scroll-contract.e2e.ts) covers pinned Send, real scroll-away input, streaming, and tool disclosure across the long transcript.
