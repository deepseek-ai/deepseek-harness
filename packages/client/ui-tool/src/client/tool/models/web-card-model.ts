/** Pure web-card derivation from raw web result metadata. @module */
import type { WebBlockProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallBlock } from './tool-call-model.ts'
import { parsedToolCall } from './raw-tool-call.ts'

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

/** Web-card data owned by the presenter; render sites add localized labels and classes. */
export type WebCardModelProps = DistributiveOmit<WebBlockProps, 'labels' | 'className'>

function validWebCall(block: ToolCallBlock): 'web_search' | 'web_fetch' | null {
  const call = parsedToolCall(block)
  if (call === null) return null
  if (call.name === 'web_search') {
    const { queries } = call.args
    if (!Array.isArray(queries) || queries.length === 0) return null
    return queries.every(query => typeof query === 'string' && query.trim() !== '') ? call.name : null
  }
  if (call.name === 'web_fetch') {
    const { url } = call.args
    return typeof url === 'string' && url.trim() !== '' ? call.name : null
  }
  return null
}

interface WebSource {
  url: string
  title?: string
  snippet?: string
  publishedAt?: string
}

function webSources(value: unknown): WebSource[] | null {
  if (!Array.isArray(value)) return null
  const sources: WebSource[] = []
  for (const source of value) {
    if (typeof source !== 'object' || source === null || Array.isArray(source)) return null
    const { url, title, snippet, publishedAt } = source as Record<string, unknown>
    if (typeof url !== 'string') return null
    if (title !== undefined && typeof title !== 'string') return null
    if (snippet !== undefined && typeof snippet !== 'string') return null
    if (publishedAt !== undefined && typeof publishedAt !== 'string') return null
    sources.push({
      url,
      ...title === undefined ? {} : { title },
      ...snippet === undefined ? {} : { snippet },
      ...publishedAt === undefined ? {} : { publishedAt },
    })
  }
  return sources
}

/**
 * Derive a settled root web-search or web-fetch card from persisted metadata.
 * @param block - running or settled Tool block.
 * @returns web-card props, or null for the generic path.
 */
export function webCardModel(block: ToolCallBlock): WebCardModelProps | null {
  if (block.parentCallId !== undefined || !('kind' in block) || block.isError) return null
  const tool = validWebCall(block)
  if (tool === null || typeof block.meta !== 'object' || block.meta === null || Array.isArray(block.meta)) return null
  const meta = block.meta as Record<string, unknown>
  if (typeof meta.truncated !== 'boolean') return null
  if (tool === 'web_search') {
    const sources = webSources(meta.sources)
    if (sources === null || (meta.answer !== undefined && typeof meta.answer !== 'string')) return null
    return {
      kind: 'search',
      answer: meta.answer,
      sources,
      truncated: meta.truncated,
    }
  }
  if (typeof meta.url !== 'string') return null
  if (typeof meta.statusCode !== 'number' || !Number.isInteger(meta.statusCode)) return null
  return {
    kind: 'fetch',
    url: meta.url,
    statusCode: meta.statusCode,
    truncated: meta.truncated,
  }
}

/**
 * Read the openable URL of a web_fetch call from its arguments.
 * @param block - running or settled Tool block.
 * @returns the http(s) URL, or undefined for another tool, protocol, or unparsable argument.
 */
export function webFetchHref(block: ToolCallBlock): string | undefined {
  const call = parsedToolCall(block)
  if (call?.name !== 'web_fetch' || typeof call.args.url !== 'string') return undefined
  const { url } = call.args
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:' ? url : undefined
  } catch {
    // An unparsable URL stays plain summary text.
    return undefined
  }
}
