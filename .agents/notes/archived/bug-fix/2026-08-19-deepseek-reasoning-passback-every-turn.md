# Agent Note: DeepSeek reasoning passback on every reasoned turn

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-19-deepseek-reasoning-passback-every-turn.zh.md)

## Problem

`dsh-llm-deepseek` replayed `reasoning_content` in history only on assistant turns that also carried tool calls. DeepSeek's thinking-mode guide requires the field there and ignores it elsewhere, so withholding it on plain turns bought input tokens back with nothing observable lost against `api.deepseek.com`.

That endpoint is not the only one this adapter serves. `Config.baseURL` points it at any OpenAI-compatible endpoint, including a gateway that re-encodes a DeepSeek chat-completions conversation for another vendor. Such a gateway has no wire slot for the upstream thinking signature and recovers it by hashing the replayed chain of thought. A turn the model answered without calling a tool therefore reached the gateway with no reasoning text at all, the signature lookup found nothing, and the reconstructed conversation diverged from the recorded one. Agent runs call tools on most turns, so the loss appeared only at plain-answer turns and looked intermittent.

## Decision

`serializeAssistant` emits `reasoning_content` for every assistant turn whose content carried reasoning, independent of tool calls. An absent reasoning block still emits no field, so a non-thinking turn is unchanged.

The replayed text is byte-exact with what the provider streamed: `translate.ts` accumulates the whole `reasoning_content` channel of one response into a single reasoning block, so the join in `serializeAssistant` concatenates one member and a hash taken over the replay matches a hash taken over the original delivery.

## Alternatives considered

- **A `Config` switch selecting the passback policy.** The two endpoint behaviors are real, but the field is inert where it is unneeded, so the switch only ever buys back one turn's chain of thought in input tokens — against a wrong setting that silently makes a session unreconstructable, with no error at either end to attribute it to. A knob whose wrong position fails silently is worse than the tokens.
- **Deciding from `baseURL`.** Whether an endpoint forwards to another vendor is not readable from its host: an internal endpoint may proxy DeepSeek directly and a public one may forward. The adapter would be guessing at a deployment it cannot see through.
- **Carrying the signature durably instead, as `dsh-llm-pi-ai` does.** That adapter persists `thinkingSignature` per block in its replay state because its providers put the signature on the wire. DeepSeek chat-completions exposes none, so this adapter has nothing to persist and the replayed text is the only channel.

## Consequences

Every reasoned tool-call-free turn now costs its chain of thought in input tokens on later requests. The added text sits at that turn's position and is identical on every subsequent request, so the assembled prefix stays stable and only the first request spanning the change loses cache reuse from that point.

`WireAssistantMessage.reasoning_content` documents both endpoint behaviors, and the package README states the passback rule in the Wire-format notes and the Model Experience token and cache sections.

## Testing

`tests/serialize.spec.ts` pins all three assistant shapes: reasoning beside text with no tool call, reasoning beside a tool call, and a reasoning-only turn whose content stays `""`. Turns carrying no reasoning keep emitting no field, which the content-less and tool-call-only cases cover.
