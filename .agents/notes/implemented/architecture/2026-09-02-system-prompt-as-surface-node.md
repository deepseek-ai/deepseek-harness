# Agent Note: The system prompt is surface node 0

Status: implemented

English | [中文](2026-09-02-system-prompt-as-surface-node.zh.md)

## Problem

Keeping the system prompt in a log-only request header gives model-visible messages two durable homes. Serializers, compaction, token accounting and request inspection must prepend header text to conversation history independently. Comparing that text alongside configuration and tools also makes instruction changes indistinguishable from request-setting changes. A header cannot represent instructions introduced later in the conversation.

## Decision

System instructions are ordinary `system/message` surface events. The first accepted request reserves a protected system head, including when its content is empty. Empty system content remains addressable in the log and surface but projects to no model message. Later updates can occupy their own conversation positions. [Section admission](2026-10-21-section-based-system-updates.md) owns current attribution and incremental updates; [deferred compaction rebuilding](2026-11-09-deferred-system-compaction.md) owns consolidation. The earlier whole-prompt replacement rule is superseded, while this single durable representation remains.

The surface fold supplies logged system messages to adapters alongside the rest of the conversation. Adapters choose native messages or their protocol representation without changing durable roles. `EpochHeader` holds configuration, adapter defaults and tools, not system text; prompt changes therefore have their own event identity rather than a header `change` reason. Header reasons still describe initial, resumed, changed or new-series requests.

`assertSystemHeadRewrite` rejects a replacement covering node 0 when it is a system message unless another system message replaces exactly that node. Later system nodes remain replaceable by compaction. Protecting even an empty head gives rebuilding a stable target without inserting a node ahead of existing history. Per-node replacements preserve intervening conversation and use the existing replacement-generation accounting.

The loop commits prepared instructions inside an open step, after request middleware and route preparation, before new user input and the model call. Rejection or cancellation before commitment admits neither instructions nor users. System-prompt assembly prepares candidates; the loop owns their durable append or replacement. Runtime context remains an independent user-role contribution. Both become model-visible through logged messages rather than adapter-local state.

Token usage anchors to the priced surface immediately before the successful assistant event. Step start is too early: system and user admission, or retry recovery, can still change the request afterward. Embedded provider output is priced separately so assistant rewrites retain their signed delta; the open step retains lifecycle coordinates rather than another node snapshot.

### Released conversion

The [V2-to-V3 specification](../../../../packages/session/session-format-v2-to-v3/README.md#system-head) owns structural conversion, message identities, reference preservation and refusal of unsupported sources. Migrated requests are semantically equivalent, not byte-identical to native recordings. When conversion cannot preserve historical order under the step invariant, refusal is preferable to moving messages or relaxing ownership. Historical acceptance coordinates do not acknowledge transformed logs. [Released-format rules](2026-08-31-released-session-format-migrations.md) preserve each conversion's semantics; an existing target generation does not rerun its incoming edge, and projection-cache versions are independent. [Canonical envelopes](2026-09-06-v3-canonical-session-envelopes.md) retain their separate strict-acceptance rationale.

## Alternatives considered

**Keep `header.system` for the initial prompt and use events only for updates.** Every consumer would still need two sources, and header comparison would need a special exception while a system node exists.

**A log-only change event that rewrites the header.** This distinguishes changes but still cannot place a system message inside history; later updates would need another mechanism.

**Synthesize instructions from consecutive headers in an adapter.** Adapters are stateless per request and do not see the log. Adapter-local reconstruction cannot make the durable message fold authoritative.

**Use a user-role snapshot like runtime context.** This sends a different role and loses native system authority on models that support it.

## Consequences

Request inspection, compaction, accounting, SDK events and recorded-session prompt sidecars read the same logged system messages. Human transcript projections omit them because they are model instructions rather than conversational speech. Replacing a system node changes the request prefix and replacement generation; appending a section can preserve its preceding prefix. No header-to-message join is required.

The initial head cannot be compacted by any provider, even when empty; later system additions can be removed. Initial emptiness does not require later instructions to move to the head during ordinary admission. Current section and compaction decisions determine their placement.

## Verification

Session surface tests cover protected-head rewrites, empty projection, ordinary later-node replacement and persisted system-message validation. Adapter tests cover system-block rendering on text and image paths. Compaction tests retain the leading derived prompt and reject ranges covering the protected head. Request reconstruction and both SDK expected outputs verify that model-visible instructions are logged. Token-meter tests cover admission and retry changes before usage anchoring; recorded-session snapshots cover shipped profile requests and prompt sidecars.
