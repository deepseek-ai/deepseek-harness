# Agent Note: Remove the Python SDK's unused reverse RPC direction

Status: proposed

English | [中文](2026-09-19-python-sdk-directional-client.zh.md)

## Problem

The [Python client](../../../../python/sdk/src/deepseek_harness/client.py) keeps an incoming-request queue, close-time wake-up, and `next_request`, `respond`, `respond_error`, and `notify` methods. The [SDK server](../../../../packages/sdk/server/src/server.ts) receives requests and emits notifications; it declares no server-originated request or client-notification handler. Searches across Python sources, examples, and runtime profiles found the reverse direction only in client implementation and [synthetic client tests](../../../../python/sdk/tests/test_client.py). The exported `IncomingRequest` model consequently has no supported runtime producer.

This is a narrower continuation of the [directional JSON-RPC proposal](../../rejected/simplification/2026-07-19-make-jsonrpc-directional.md), whose rejection explicitly permits transport narrowing separately. Its completion redesign remains rejected. Its claim about the shared TypeScript transport is now inapplicable: the [Codex wire adapter](../../../../packages/subagent/subagent-codex/src/wire.ts) uses requests and notifications in both directions.

## Proposal

Remove the four Python methods, `_requests`, and `IncomingRequest` from the client, models, and exports. Retain an explicit guard for an unexpected frame containing both `id` and `method` before response matching, so a server request cannot settle an unrelated pending client request. Keep client requests, response validation, incoming notification subscriptions, and shutdown unchanged.

Remove the dedicated synthetic reverse-request test. Change tests that send client notifications only to trigger fixture behavior to use a request and response instead; retain their filter-exception and concurrent-write assertions. This removes one queue and its lifetime, four public methods, one public model, and roughly three dozen source lines without adding a replacement transport.

## Alternatives considered

**Keep a generic Python peer for external plugins.** Custom runtimes could use the methods, but no SDK method describes their request ownership, cancellation, or delivery protocol. The proposal accepts this pre-stable API loss; a future bidirectional SDK feature must supply its actual method and lifecycle requirements.

**Narrow the shared TypeScript transport too.** Rejected because the Codex adapter is a current bidirectional consumer. The shared implementation and its tests remain.

## Acceptance criteria

- Python sources and examples have no reverse-direction API or request queue; documentation and exports describe the retained client role.
- An unexpected server request reusing a pending client id cannot complete its waiter. Notification filtering, sibling delivery, final draining, malformed-frame handling, serialized writes, and shutdown still pass their existing tests.
- Prompt submission still returns the durable enqueue receipt; no per-prompt completion promise or response-based turn result is introduced.
- Run the Python client suite and installed-runtime SDK smoke and snapshot checks, plus documentation and lint checks. Preserve the TypeScript transport and released Session fixtures.

## Risks

External Python callers using custom runtime plugins lose these methods. Ignoring an unsupported request does not fulfill a hypothetical server's response expectation; this is deliberate withdrawal of that direction, not protocol parity. Revisit the proposal if a supported server-originated method lands before implementation.
