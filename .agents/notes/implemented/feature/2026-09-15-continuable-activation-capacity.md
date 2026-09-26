# Agent Note: Shared continuable Activation capacity

Status: implemented

English | [中文](2026-09-15-continuable-activation-capacity.zh.md)

## Problem

Depth limits bound nesting but permit wide concurrent delegation. Background Job limits do not cover continuable children, and a lifetime creation quota prevents useful later work after earlier children finish.

## Decision

The subagent service configures `maxActiveSubagents`, defaulting to 8. Each live non-continuable parent owns one process-local pool, shared by reference through uninterrupted continuable parent links. The pool owner itself is excluded. One-shot runs and external-provider work do not enter this pool. A one-shot intermediate parent starts a separate pool for its continuable children; cross-one-shot capacity inheritance is deferred. Delegation depth remains independently configured.

The Activation registry reserves a unique slot before fresh or cold-resume reconstruction yields. The materialization owns rollback until the Activation owns the slot; unpublished rollback and failed materialization may both release the same token safely. Handle disposal precedes release, which precedes parent settlement notification. Sending to an existing Activation reuses its slot.

Pool lookup, admission and release take amortized constant time. A weak root map does not retain dead root Agents; each pool holds only occupied tokens. No Session catalog scan, tree traversal, durable counter, or public capacity-query API is added.

The Host registers the `subagent` settings section over its composition. Each reservation reads the current capacity, so lowering it never evicts resident children or rebuilds their registry. Delegation tools resolve an omitted depth from the same section at each attempt; explicit numeric and provider-managed tool policies retain priority. The GUI stages both numbers and resets each to composition through the existing revision-fenced settings path. Keeping counts in the pool and policy in settings avoids a second live counter or a settings-triggered teardown.

## Alternatives considered

A cumulative child count is a separate cost policy and does not release capacity after useful work finishes. Counting model requests would omit waiting parents, queued inbox work, reconstruction and cleanup, all of which retain resources. Scanning resident and pending maps adds work proportional to unrelated live trees. Separate counters require synchronization with slot ownership.

Waiting for capacity can deadlock when every slot belongs to a parent waiting for a descendant. Full pools reject with an actionable diagnostic instead of retaining queued activation requests.

## Consequences

Idle Activations with pending inbox work or owned descendants still occupy slots. Cold resume can fail at capacity even though the historical child exists; browser prompts report this as `subagent/delivery-unavailable`. Slots do not impose a token or cumulative spending budget, and they do not coordinate multiple harness processes.

The [continuable lifecycle decision](2026-07-28-continuable-subagent-conversations.md) retains ownership of settlement and child-first teardown. This capacity policy extends that lifecycle without changing durable Session data.

## Verification

Focused continuation tests exercise the default, invalid configuration, shared multi-level capacity, root isolation, pending creation, failure release, cold resume, resident messages and disposal. A keyless SDK-profile snapshot records successful background creation followed by an over-capacity tool diagnostic while the first child remains live.
