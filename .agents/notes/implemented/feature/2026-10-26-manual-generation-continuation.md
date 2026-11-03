# Agent Note: Manual generation continuation

Status: implemented

English | [中文](2026-10-26-manual-generation-continuation.zh.md)

## Problem

Users need another request after a model failure without inserting an artificial instruction. Browser paging can omit the failed turn's start, and streaming must not repeatedly copy history.

## Decision

The play action submits `content: []` through the existing Session prompt API. The API assigns `source.kind: 'retry'`; unchanged AgentLoop admission records an empty `user/message` and opens a normally balanced new turn. Chat presents a compact continuation-request receipt while the log retains the empty input. The original failed turn remains closed.

The Session API owns the fixed-size `conversationContinuation` projection and shares its value with the browser. Admission requires an eligible failure, true idle ownership, and no pending human input. An appended empty retry message admits the new turn, preserving eligibility if its request also fails.

The six-code manual allowlist stays independent of provider retry policy. Non-waking injected context accompanies the request. The accepted user message retains request-id deduplication after the inbox input is claimed. Reusing ordinary message admission avoids a Loop branch and a separate durable acceptance event.

## Alternatives considered

**Localized or hidden continuation text.** Adds model-visible instructions and changes retained history.

**A separate resume operation.** The existing prompt and inbox already carry identified control input and own wakeup.

**Keep the failed turn waiting for a click.** Changes failure settlement, idle status, cancellation, and model-selection semantics.

## Consequences

Ordinary empty-draft Enter remains inert. The explicit action reuses submission state and error reporting without an echo or generated draft. Pre-step rejection and cleared batches still prevent model calls.

## Verification

Unit and assembled scenarios cover repeated failure, request deduplication, injected context, balanced turns, retained tools, one original user message, and zero Client event-window reads.
