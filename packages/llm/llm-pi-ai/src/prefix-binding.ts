/**
 * Request-prefix binding for replayed Anthropic thinking.
 *
 * Anthropic can bind each signed thinking block to the request prefix it was
 * generated under: system prompt, tools, and every earlier message. Compaction
 * and tool-result pruning rewrite that prefix, so a retained signed block
 * becomes invalid and endpoints that enforce the check reject the whole
 * request. Each Anthropic Messages response records a digest of the context it
 * was generated from; a later request replays its signed thinking only while
 * the reconstructed prefix still has the same digest. Replay state without a
 * digest predates this check and is treated as stale.
 *
 * The digest covers the pi-ai context objects this package builds, including
 * fields Anthropic never receives. Any change to their construction
 * invalidates every recorded digest once; a pi-ai upgrade that changes how
 * Anthropic messages are serialized without changing those objects requires a
 * new {@link DIGEST_SEED}.
 *
 * @module dsh-llm-pi-ai/prefix-binding
 */

import { createHash } from 'node:crypto'
import type { Api, AssistantMessage, Context as PiContext } from '@earendil-works/pi-ai'

/** Recorded request-prefix digests of reconstructed assistant messages, owned by one context conversion. */
export type PrefixDigests = Map<AssistantMessage, string>

/** Wire protocol whose thinking signatures bind to the request prefix. */
const PREFIX_BOUND_API = 'anthropic-messages'

/** Seed of every digest chain; changing the digest input or its serialization requires a new seed. */
const DIGEST_SEED = 'dsh-llm-pi-ai/prefix-binding/v1'

function chain(previous: string, value: unknown): string {
  return createHash('sha256').update(previous).update('\0').update(JSON.stringify(value)).digest('hex')
}

/** Index of the assistant message whose tool round the request continues with tool results, or -1. */
function openToolRoundAssistant(messages: PiContext['messages']): number {
  let results = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as PiContext['messages'][number]
    if (message.role === 'assistant') return results > 0 ? index : -1
    if (message.role !== 'toolResult') return -1
    results++
  }
  return -1
}

/** Whether a thinking block carries a signature or redacted payload that binds it to its prefix. */
function signed(block: AssistantMessage['content'][number]): boolean {
  return block.type === 'thinking' && (block.redacted === true || (block.thinkingSignature ?? '').length > 0)
}

/** Copy of an assistant message without its signed thinking blocks. */
function withoutSignedThinking(message: AssistantMessage): AssistantMessage {
  return { ...message, content: message.content.filter(block => !signed(block)) }
}

/** Context whose stale thinking is removed, with the digest of the complete request. */
export interface PrefixBoundContext {
  /** Context to send; equal to the input when nothing was removed. */
  context: PiContext
  /** Digest of the sent context, recorded with the response; absent for other protocols. */
  digest?: string
}

/**
 * Remove signed thinking from replayed Anthropic Messages assistant messages
 * whose request prefix changed since they were generated, or whose replay
 * state records no prefix digest. Manual thinking requires the final
 * assistant turn of a tool round to start with a thinking block, so with
 * `manualThinking` the assistant message whose tool round the request
 * continues keeps its thinking.
 * @param context - converted request context.
 * @param api - wire protocol of the requested model.
 * @param prefixDigests - recorded digests the context conversion collected.
 * @param manualThinking - whether the request enables budget-based rather than adaptive thinking.
 * @param onOmitted - called once with the number of messages whose thinking was removed, when there are any.
 * @returns the context to send and, for Anthropic Messages, its digest.
 */
export function bindThinkingToPrefix(
  context: PiContext,
  api: Api,
  prefixDigests: PrefixDigests,
  manualThinking: boolean,
  onOmitted: (count: number) => void,
): PrefixBoundContext {
  if (api !== PREFIX_BOUND_API) return { context }
  const kept = manualThinking ? openToolRoundAssistant(context.messages) : -1
  let digest = chain(DIGEST_SEED, { systemPrompt: context.systemPrompt ?? null, tools: context.tools ?? null })
  let messages: PiContext['messages'] | undefined
  let omitted = 0
  for (const [index, original] of context.messages.entries()) {
    let message = original
    if (
      message.role === 'assistant' && message.api === PREFIX_BOUND_API && index !== kept
      && prefixDigests.get(message) !== digest && message.content.some(signed)
    ) {
      message = withoutSignedThinking(message)
      messages ??= context.messages.slice()
      messages[index] = message
      omitted++
    }
    digest = chain(digest, message)
  }
  if (messages === undefined) return { context, digest }
  onOmitted(omitted)
  return { context: { ...context, messages }, digest }
}
