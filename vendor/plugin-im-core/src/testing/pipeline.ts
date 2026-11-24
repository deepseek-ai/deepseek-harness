/**
 * Offline render pipeline (`normalize → transform → prepare → serialize`), assembled here so the testkit can render
 * content for conformance, goldens and assertions without `Bot.send`.
 *
 * An adapter implementation never calls this: `bot.send`/`bot.render` own the same steps. The testkit keeps its own
 * copy so a conformance run does not depend on the send pipeline's options, retries or events.
 */

import type { Element, Fragment } from '@deepseek-ai/satori-element'
import { normalize } from '@deepseek-ai/satori-element'
import type { Adapter } from '../bot.ts'
import { splitDirectives } from '../directives.ts'
import type { RenderReport } from '../fallback.ts'
import type { Mode, TransformResult } from '../mode.ts'
import type { Target } from '../protocol.ts'
import { MemoryResourceCache, type PrepareContext, prepare, type ResourceCache } from '../resource.ts'
import { transform } from '../transform.ts'

/** Default target of testkit renders: a group chat on the adapter's platform. */
export function defaultTarget(adapter: { platform: string }): Target {
  return { chat: { id: `${adapter.platform}:test`, type: 'group' } }
}

/** Deterministic in-memory `fetch`: no network, no filesystem. */
export const offlineFetch: PrepareContext['fetch'] = async (src) => ({
  data: new TextEncoder().encode(src),
  mime: 'application/octet-stream',
})

export interface RenderThroughOptions {
  target: Target
  mode: Mode<any>
  cache?: ResourceCache
  fetch?: PrepareContext['fetch']
  signal?: AbortSignal
  /** Dry run: no upload and no cache lookup (`bot.render` passes this). */
  skipUpload?: boolean
}

export interface RenderedContent {
  /** Normalized `<message>` root. */
  content: Element<'message'>
  transform: TransformResult<unknown>
  drafts: unknown[]
  /** Exact request bodies, in send order — what goldens compare. */
  payloads: unknown[]
  report: RenderReport
}

/**
 * Run one message through the pipeline. `prepare` uses the adapter's `upload()` (recorded by `FakeAdapter`) and an
 * in-memory cache; there is no network and no retry.
 */
export async function renderContent(
  adapter: Adapter<any, any>,
  content: Fragment,
  options: RenderThroughOptions,
): Promise<RenderedContent> {
  const { target, mode } = options
  const root = normalize(splitDirectives(content).content)
  const result = transform(root, { bot: adapter, target, mode })
  const prepared = await prepare(result.msgs as unknown[], {
    adapter,
    target,
    cache: options.cache ?? new MemoryResourceCache(),
    fetch: options.fetch ?? offlineFetch,
    ...options.signal ? { signal: options.signal } : {},
    ...options.skipUpload ? { skipUpload: true } : {},
  })
  const payloads = prepared.map((msg, index) => mode.serialize(msg, {
    bot: adapter,
    target,
    mode: mode.id,
    index,
    count: prepared.length,
    ...result.quote === undefined ? {} : { quote: result.quote },
    options: {},
  }))
  if (!payloads.length) {
    throw new Error(`mode "${mode.id}" produced no platform message for a content tree (assemble returned none)`)
  }
  return { content: root, transform: result, drafts: result.msgs, payloads, report: result.report }
}
