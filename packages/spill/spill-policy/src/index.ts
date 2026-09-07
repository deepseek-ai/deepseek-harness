/**
 * The spill-policy PLUGIN: a `tools/post-execute` result transformer that keeps
 * oversized plain-text tool results out of the model's context. When a final
 * result's UTF-8 size exceeds `maxInlineBytes`, it saves the FULL text to a
 * session-scoped spill artifact (`ctx.spillStore`) and replaces the
 * model-facing result with a bounded head/tail preview plus the backend's
 * locator and retrieval guidance.
 *
 * It registers NO service and owns NO storage or preview mechanics: preview is
 * `@deepseek-ai/dsh-output-retention` (`TextRetainer`), storage is `ctx.spillStore`.
 * The policy only decides WHEN to spill and composes the notice.
 *
 * A second arm applies the SAME cap to the durable log: the
 * `tools/ptc-dispatch-log` waterfall bounds the `tool/code-dispatch` event's
 * copy of an oversized `run_code` sub-call result (the program's value is
 * untouched; UIs and replay read the full text through the spill artifact).
 *
 * ## Deliberately narrow
 *
 * - Omitted `maxInlineBytes` ⇒ the plugin registers nothing (a true no-op).
 * - Plain-text results only: a result carrying any non-text block is left
 *   untouched (the policy knows only the final formatted text, not tool
 *   internals).
 * - Nested composite calls skip the MODEL-facing arm; their durable log copy
 *   is bounded by the dispatch-log arm instead.
 * - Accepted value replacements pass through for registry revalidation and
 *   rendering; this presentation policy cannot also replace content in the
 *   same mutually exclusive decision.
 * - `read` is skipped by the model-facing arm to avoid a
 *   `read → spill → read again` loop; the dispatch-log arm bounds `read`
 *   sub-calls too (a log copy is not model context, and `read` is precisely
 *   the tool that produces huge logs).
 * - Best-effort: no session owner, no `ctx.spillStore` backend, or a save
 *   failure ⇒ log and return the original result. A spill failure must NEVER
 *   turn a successful tool call into an `isError` or hide the inline result.
 *
 * It COMPOSES with other post-execute listeners: its prepended listener
 * delegates via `next()` and bounds the resulting content projection, so
 * tool-owned asynchronous projection runs before generic bounding, a hook that
 * replaced content still has its replacement bounded, and value replacements
 * and `block` decisions pass through unchanged.
 *
 * @module @deepseek-ai/dsh-spill-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import type { Omitted } from '@deepseek-ai/dsh-output-retention'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SpillPolicyExec } from './types.ts'
import { formatSpillNotice } from './notice.ts'

export type { SpillPolicyExec } from './types.ts'

/** Plugin config. */
export interface Config {
  /**
   * The model-facing context cap for a plain-text tool result, in UTF-8 bytes.
   * Omitted disables the policy entirely (no-op). When set, a result larger than
   * this is spilled and replaced with a preview derived from this same budget.
   */
  maxInlineBytes?: number
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'spill-policy'

/** Require the tool registry (its `tools/post-execute` waterfall is the extension point we transform). */
export const inject = ['tools']

export const Config: z<Config> = z.object({
  maxInlineBytes: z.number(),
})

/** All-text content flattened to one UTF-8 string, or `undefined` if any block is non-text. */
function flattenPlainText(content: ContentBlock[]): string | undefined {
  let text = ''
  for (const block of content) {
    if (block.type !== 'text') return undefined
    text += block.text
  }
  return text
}

/** The owning session id, or `undefined` for a call with no agent (a direct/test call). */
function ownerSessionId(exec: ToolExecution): SessionId | undefined {
  return (exec as SpillPolicyExec).agent?.session.header.id
}

/** Build the bounded head/tail preview for `text`, splitting `budget` bytes across the two ends. */
function preview(text: string, budget: number): { text: string; omitted: Omitted } {
  const headBytes = Math.ceil(budget / 2)
  const tailBytes = Math.floor(budget / 2)
  const retainer = new TextRetainer({ kind: 'headTail', headBytes, tailBytes })
  retainer.push(text)
  const kept = retainer.finish()
  return { text: kept.text, omitted: kept.omittedBytes }
}

export function apply(ctx: Context, config: Config): void {
  const maxInlineBytes = config.maxInlineBytes
  // Omitted ⇒ no automatic spill policy: register nothing at all.
  if (maxInlineBytes === undefined) return
  // Validate at LOAD, not per call: a negative/fractional cap would reach
  // TextRetainer's assertBudget and throw, turning every oversized-result call
  // into an isError. A bad config must fail the deployment, not the tool.
  if (!Number.isInteger(maxInlineBytes) || maxInlineBytes < 0) {
    throw new Error(`spill-policy: maxInlineBytes must be a non-negative integer (got ${maxInlineBytes})`)
  }
  // Narrowed once for the nested arms (closure narrowing does not survive awaits).
  const cap: number = maxInlineBytes

  /**
   * Spill `text` and build the bounded replacement (preview + notice), or
   * return `undefined` when the policy must keep the original (no session
   * owner, no backend, storage failure, or no within-cap replacement).
   * Shared verbatim by the model-facing post-execute arm and the durable
   * dispatch-log arm so both produce byte-identical projections.
   */
  async function spillReplacement(
    text: string,
    totalBytes: number,
    sessionId: SessionId | undefined,
    toolName: string,
    callId: ToolCallId,
    label: 'result' | 'dispatch',
  ): Promise<string | undefined> {
    if (sessionId === undefined) {
      ctx.logger.warn(`spill-policy: no session owner for ${toolName} ${label}; keeping the inline content`)
      return undefined
    }
    const spillStore = ctx.get('spillStore')
    if (!spillStore) {
      ctx.logger.warn('spill-policy: no ctx.spillStore backend loaded; keeping the inline content')
      return undefined
    }
    const save: SaveTextSpill = {
      owner: { sessionId },
      source: { kind: 'tool', toolName, callId, label },
      suggestedName: `${toolName}.txt`,
      content: text,
    }
    let ref: SpillRef
    try {
      ref = await spillStore.saveText(save)
    } catch (error: unknown) {
      // Best-effort: a storage failure (permissions, ENOSPC, backend down) must
      // never fail the call or hide the content — keep the original inline.
      ctx.logger.warn(`spill-policy: saveText failed for ${toolName}: ${String(error)}; keeping the inline content`)
      return undefined
    }

    // Reserve the notice's byte cost INSIDE maxInlineBytes so the replacement
    // (preview + blank line + notice) never exceeds the documented cap — a naive
    // preview that spent the whole budget then appended the notice could be
    // larger than the cap, and for a marginally-over result even larger than the
    // original. The reservation uses a notice priced at the worst-case omission
    // count (the full byte total): its digit count bounds the real count's, so
    // the reserved size is a safe upper bound and the final notice is never
    // longer than what we reserved. `\n\n` is the 2-byte join.
    const reserve = Buffer.byteLength(formatSpillNotice({ kind: 'exact', count: totalBytes }, ref), 'utf8') + 2
    const previewBudget = Math.max(0, cap - reserve)
    const { text: previewText, omitted } = preview(text, previewBudget)
    const notice = formatSpillNotice(omitted, ref)
    const replacedText = previewText.length > 0 ? `${previewText}\n\n${notice}` : notice
    // Invariant: the policy NEVER emits a replacement larger than the cap. When
    // the notice alone exceeds maxInlineBytes (a tiny cap or a long spill root),
    // there is no within-cap replacement, so keep the inline content — spilling
    // would break the advertised cap. (A within-cap replacement is always
    // smaller than the original, which is > cap by the entry condition, so this
    // one check subsumes "not smaller than the original" too. The spill file
    // already written is a harmless orphan; cleanup is deferred.)
    if (Buffer.byteLength(replacedText, 'utf8') > cap) {
      ctx.logger.warn(`spill-policy: spill notice for ${toolName} exceeds maxInlineBytes; keeping the inline content`)
      return undefined
    }
    return replacedText
  }

  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    // Delegate first so a downstream listener (e.g. a hook) settles the result;
    // we bound whatever it accepted. A block passes through — spill only shapes
    // accepted plain-text results, never corrective feedback.
    const decision = await next()
    // Skip `read` to avoid a read → spill → read again loop.
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')
      || exec.parent !== undefined || exec.name === 'read') return decision

    const content = decision.content ?? result.content
    const text = flattenPlainText(content)
    if (text === undefined) return decision
    const totalBytes = Buffer.byteLength(text, 'utf8')
    if (totalBytes <= maxInlineBytes) return decision

    const replacedText = await spillReplacement(text, totalBytes, ownerSessionId(exec), exec.name, exec.callId, 'result')
    if (replacedText === undefined) return decision
    const replaced: ContentBlock[] = [{ type: 'text', text: replacedText }]
    return { kind: 'accept', content: replaced, ...decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {} }
  }, { prepend: true })

  // The durable-log arm: bound the `tool/code-dispatch` event's copy of an
  // oversized sub-call result the same way the model-facing arm bounds an
  // outer result. The program's returned value is untouched (it already
  // crossed the worker boundary whole); only the session log's copy shrinks
  // to preview + locator, so replay and UIs read the full text through the
  // spill artifact exactly as they do for spilled native results.
  ctx.on('tools/ptc-dispatch-log', async (dispatch, next): Promise<ContentBlock[]> => {
    const content = await next()
    // `read` sub-calls spill too: the log copy is not model context, so the
    // read → spill → read-again loop the post-execute arm avoids cannot
    // happen here, and read is precisely the tool that produces huge logs.
    const text = flattenPlainText(content)
    if (text === undefined) return content
    const totalBytes = Buffer.byteLength(text, 'utf8')
    if (totalBytes <= maxInlineBytes) return content

    const replacedText = await spillReplacement(
      text, totalBytes, ownerSessionId(dispatch.exec), dispatch.name, dispatch.subCallId, 'dispatch')
    if (replacedText === undefined) return content
    return [{ type: 'text', text: replacedText }]
  }, { prepend: true })
}
