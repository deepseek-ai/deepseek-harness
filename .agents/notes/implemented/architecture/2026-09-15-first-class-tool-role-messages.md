# Agent Note: First-class tool-role messages

Status: implemented

English | [中文](2026-09-15-first-class-tool-role-messages.zh.md)

## Problem

The released Session format stores tool results inside a user-role `tool-result` content block, while the model conversation and provider protocols treat a tool result as a separate role. Keeping both descriptions active makes validation, replay, and adapter projections disagree.

## Decision

Session format V4 stores one tool result as a first-class `role: 'tool'` message. Its `toolCallId`, tool source call id, result content, and optional error flag are validated together. The V3-to-V4 edge lifts exactly one released wrapper and refuses nested wrappers before publication, retaining the source generation. Current V4 decoding is native-only; wrapper rows are accepted only by the adjacent migration edge.

Historical message and result extension fields keep distinct `plugin:message:` and `plugin:result:` names when their wrapper is removed. Complete original field names remain in each suffix, preventing collisions without adding core metadata fields. Opaque retention avoids inventing a shared field owner when the wrapper disappears. It retains duplicate values from distinct owners, and plugin consumers must use the V4 names. The wrapper alone supplies the interpreted call id and error flag; an old outer field with the same spelling remains opaque. The [conversion specification](../../../../packages/session/session-format-v3-to-v4/README.md#tool-results) owns exact preservation and refusal rules.

The conversation role map is closed. A model-visible role must have a persisted Session event and an adapter projection, so adapters do not silently turn an unlogged extension role into user text. Provider-specific source kinds remain merge-extensible and are owned by their producers.

## Alternatives considered

- **Keep wrapper-shaped V4 rows** — this preserves the released payload but leaves the canonical role and provider wire formats inconsistent.
- **Accept both wrapper and native V4 rows** — dual current representations make encoding, decoding, recovery, and replay depend on which path produced the artifact.
- **Flatten historical nested results** — leaf text does not retain nested call IDs or error status, and providers did not interpret nested content uniformly. Unsupported migration preserves the original data until a lossless conversion is available.
- **Keep role extensions open** — an extension could reach a model request without a Session event and could not be reconstructed on replay.

## Consequences

The adjacent migration changes the logical message role without changing message identity, tool-call identity, or result content. Native V4 semantic failures are hard admission failures; recoverable decoding still applies to released V3 canonical tails. Adapters map the first-class role to their provider-specific tool-result representation. The duplicated message `toolCallId` and source `callId` remain as an explicit equality-checked provider field and source-identity field pair.
