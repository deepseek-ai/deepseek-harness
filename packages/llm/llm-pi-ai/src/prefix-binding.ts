/**
 * Request-prefix binding for replayed Anthropic thinking.
 *
 * Anthropic can bind each signed thinking block to the request prefix it was
 * generated under: system prompt, tools, and every earlier message. Compaction
 * and tool-result pruning rewrite that prefix, so a retained signed block
 * becomes invalid and endpoints that enforce the check reject the whole
 * request. Each Anthropic Messages response records a digest of the context it
 * was generated from; a later request replays its thinking only while the
 * reconstructed prefix still has the same digest. Replay state without a
 * digest predates this check and is treated as stale.
 *
 * Manual (non-adaptive) thinking requires the final assistant turn of a tool
 * round to start with a thinking block, so that message keeps its thinking
 * when the model does not force adaptive thinking.
 *
 * @module dsh-llm-pi-ai/prefix-binding
 */

import { createHash } from 'node:crypto'
import type { Api, AssistantMessage, Context as PiContext, Model } from '@earendil-works/pi-ai'
import type { PrefixDigests } from './replay.ts'

/** Wire protocol whose thinking signatures bind to the request prefix. */
const PREFIX_BOUND_API = 'anthropic-messages'

/** Seed of every digest chain; changing the digest input requires a new seed. */
const DIGEST_SEED = 'dsh-llm-pi-ai/prefix-binding/v1'

function chain(previous: string, value: unknown): string {
  return createHash('sha256').update(previous).update('\0').update(JSON.stringify(value)).digest('hex')
}

/** Index of the assistant message whose tool round the request continues, or -1. */
function openToolRoundAssistant(messages: PiContext['messages']): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as PiContext['messages'][number]
    if (message.role === 'assistant') return index
    if (message.role !== 'toolResult') return -1
  }
  return -1
}

/** Copy of an assistant message without its thinking blocks. */
function withoutThinking(message: AssistantMessage): AssistantMessage {
  return { ...message, content: message.content.filter(block => block.type !== 'thinking') }
}

/** Context whose stale thinking is removed, with the digest of the complete request. */
export interface PrefixBoundContext {
  /** Context to send; equal to the input when nothing was removed. */
  context: PiContext
  /** Digest of the sent context, recorded with the response; absent for other protocols. */
  digest?: string
  /** Number of replayed assistant messages whose thinking was removed. */
  omitted: number
}

/**
 * Remove thinking from replayed Anthropic Messages assistant messages whose
 * request prefix changed since they were generated, or whose replay state
 * records no prefix digest.
 * @param context - converted request context.
 * @param model - requested model.
 * @param prefixDigests - recorded digests the context conversion collected.
 * @returns the context to send, its digest for Anthropic Messages models, and the omission count.
 */
export function bindThinkingToPrefix(
  context: PiContext,
  model: Model<Api>,
  prefixDigests: PrefixDigests,
): PrefixBoundContext {
  if (model.api !== PREFIX_BOUND_API) return { context, omitted: 0 }
  const adaptive = (model as Model<typeof PREFIX_BOUND_API>).compat?.forceAdaptiveThinking === true
  const kept = adaptive ? -1 : openToolRoundAssistant(context.messages)
  let digest = chain(DIGEST_SEED, { systemPrompt: context.systemPrompt ?? null, tools: context.tools ?? null })
  let messages: PiContext['messages'] | undefined
  let omitted = 0
  for (const [index, original] of context.messages.entries()) {
    let message = original
    if (
      message.role === 'assistant' && message.api === PREFIX_BOUND_API && index !== kept
      && prefixDigests.get(message) !== digest && message.content.some(block => block.type === 'thinking')
    ) {
      message = withoutThinking(message)
      messages ??= context.messages.slice()
      messages[index] = message
      omitted++
    }
    digest = chain(digest, message)
  }
  return { context: messages === undefined ? context : { ...context, messages }, digest, omitted }
}
