# Agent Note: Atomic Web image admission

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-29-atomic-web-image-admission.zh.md)

## Problem

Image prompt admission and `session.selectModel` each cross asynchronous model and attachment lookups. Without one ordering point, an image prompt could validate an image-capable target while a concurrent selection installed a text-only target. Selection could also change the route after admission had begun but before the durable message event was published.

## Decision

Each live Web agent has one private promise chain shared by image-bearing prompt admission and model selection. A failed operation settles its caller normally and leaves the chain usable. Text-only prompts bypass the chain because they cannot create this ordering conflict.

The chain gives the two operations a deterministic order. When selection runs first, later image admission observes the selected model and refuses an unsupported image before persistence. When image admission runs first, its attachment and event publication complete before selection changes the route. The shared LLM runtime can then project durable image blocks to deterministic text placeholders for a text-only request without rewriting the session log. Steering uses the same admission chain even though it does not enter the queued UI mirror.

Provider adapters remain the final enforcement boundary. The host ordering only prevents its mutable route and pending image state from contradicting each other before request assembly.

## Alternatives considered

**Scan durable or derived history before selection.** This prevented a text-only route from being selected whenever history contained an image. Request-local projection now supports that route directly, so history is no longer a selection constraint.

**Track pending publication separately.** A queued occurrence could be retained from dequeue through its matching event. The promise chain already keeps selection behind the complete admission operation, so a second lifecycle mirror is unnecessary.

**Serialize every prompt and session mutation.** Text-only prompts and unrelated session operations cannot introduce an image requirement. A broader lock would add latency and ownership without closing another modality race.

## Consequences

An image prompt and a concurrent model selection have deterministic order. Selection may wait for in-flight image admission, while unrelated text prompts retain their existing concurrency. Text-only model selection remains available after images enter durable history because request assembly projects those images to placeholders.
