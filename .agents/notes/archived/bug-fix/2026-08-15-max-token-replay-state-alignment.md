# Agent Note: Replay state aligns with assembled content by construction

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-15-max-token-replay-state-alignment.zh.md)

## Problem

pi-ai recorded one opaque replay blob per response, projected from the provider's native message, while `BlockAssembler.blocks()` separately dropped tool calls from a `max-tokens` response because a truncated call is unsafe to execute. The durable assistant message therefore stored transformed content next to metadata describing the untransformed native block list. The next request failed during history reconstruction with `INVALID_REPLAY_STATE: block count does not match assistant content`, and because the mismatch was already on disk, every later request on that session failed the same way — the session was permanently stuck. The root cause is structural: two representations of one response were snapshotted at different pipeline points, with their index alignment enforced only by a read-time hard error.

## Decision

Two changes, one per side of the durable boundary.

**Write side — one keep/drop decision.** The finish chunk's `replayState` becomes a typed `ReplayEnvelope`: an opaque `response` half plus optional opaque per-block entries aligned with the emitted block sequence. `BlockAssembler` computes its keep/drop decision once and applies it to blocks and envelope entries together, so any transformation assembly performs — the max-token tool-call drop or a future one — prunes the matching metadata by construction. Retained blocks keep their entries, so a truncated response keeps signatures for the reasoning and text it kept. An envelope whose entries do not match the emitted block count is discarded whole (a misemitting adapter must not publish misattributed metadata). pi-ai splits its former flat state into a version-2 response half and per-block signature entries.

**Read side — durable content is authoritative.** `toPiAssistant` treats replay state as fidelity metadata, not as a load-bearing input: any state the reading build cannot use — another adapter's kind, another version (including the flat version-1 form already on disk), malformed metadata, or a block shape that no longer matches the content — degrades that one message to the existing foreign provider-neutral conversion and reports the `INVALID_REPLAY_STATE` diagnostic through the plugin's `onReplayDegrade` hook (a logger warning). The request proceeds. This is what lets sessions poisoned before this change continue instead of erroring forever, and it bounds every future divergence source to a fidelity loss on one message.

## Verification

Assembler unit tests prove pruning, misalignment discard, and pass-through for untransformed and per-block-free envelopes. pi-ai unit tests prove the version-2 envelope round-trip and that every formerly-throwing invalid-state case now degrades to foreign conversion with the diagnostic. An agent-loop regression drives a truncated text-plus-tool-call response through persistence and shows the follow-up request carrying the pruned envelope. Keyless real-composition tests boot `dsh-llm-pi-ai` through the Loader and prove a native continuation without `tool_calls` after truncation, and a successful continuation over a legacy flat-state message whose block count no longer matches. The authored keyless snapshot scenario `max-tokens-continue` pins the assembled application's durable log — truncated turn, pruned envelope on the stored message, continued turn — through the real ACP subprocess path.

## Alternatives considered

**Suppress the whole replay state when assembly drops a tool call.** Works for the one shipped transformation, but re-derives the drop condition beside `blocks()` (the two drift silently), discards valid signatures for the retained blocks, and leaves read-time divergence — legacy sessions on disk foremost — a hard error.

**Keep the state and relax pi-ai's block-count validation to attach what fits.** Rejected: index-aligned signatures attached to a different block list would present false native history to the provider. Degrading attaches nothing.

**Teach each adapter to rewrite its state after assembly.** Rejected as an adapter obligation with an opaque blob; the envelope moves exactly the needed structure — and nothing else — into shared vocabulary, and the assembler's single decision does the rewrite mechanically.

## Consequences

Continuing after a max-token response that included a tool call works, retains the kept blocks' native signatures, and replays as a native pi-ai message. Sessions recorded before this change replay their affected assistant messages as provider-neutral content (with a diagnostic) instead of failing the turn; on-disk `replayState` values changed shape under the pre-release no-compatibility stance, with the old flat form handled by the same degrade path. This supersedes the read-time hard-error rule in the [provider-routed adapter decision](../architecture/2026-07-14-provider-routed-llm-adapters.md) for unusable state; validation itself is unchanged and still precedes any native reconstruction.
