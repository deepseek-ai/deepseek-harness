/**
 * Resources and the prepare stage: `ResourceRef` placeholders produced by handlers are resolved to platform keys
 * (upload / upsert, cached) before `serialize`.
 *
 * Layering: `transform` is pure and every handler calls `ctx.resource(...)` for media, so drafts carry
 * `ResourceRef` *placeholders*. `prepare` is the only stage that performs I/O: it walks the drafts, de-duplicates,
 * consults the cache, uploads the misses (bounded concurrency) and hands `serialize` a `ResolvedMap`. Idempotency
 * comes from the cache: re-preparing a re-transformed (streamed / edited) message is free.
 */

import type { Context } from '@deepseek-ai/cordis'
import { Binary } from '@deepseek-ai/cosmokit'
import { createHash } from 'node:crypto'
import type { Adapter } from './bot.ts'
import { RefusedContentError } from './errors.ts'
import type { Target } from './protocol.ts'

export type ResourceKind = 'image' | 'audio' | 'video' | 'file'

export interface ResourceMeta {
  name?: string
  mime?: string
  duration?: number
  width?: number
  height?: number
}

export class ResourceRef<K extends ResourceKind = ResourceKind> {
  constructor(readonly kind: K, readonly src: string, readonly meta: ResourceMeta = {}) {}
}

export interface ResolvedResource {
  key: string
  expiresAt?: number
  extra?: unknown
}

/** A draft with every ResourceRef resolved. serialize() reads keys via `resolved.get(ref)`. */
export interface Prepared<D> {
  draft: D
  resolved: ReadonlyMap<ResourceRef, ResolvedResource>
  state?: unknown
}

export interface FetchedResource {
  data: Uint8Array
  mime?: string
  name?: string
}

export interface PrepareContext {
  target: Target
  signal: AbortSignal
  /** Fetch bytes for a src (http(s), data:, base64:, satori: internal, file via host fs bridge). */
  fetch(src: string, signal: AbortSignal): Promise<FetchedResource>
  cache: ResourceCache
}

export interface ResourceCache {
  /** Key = `${adapterId}|${scope}|${kind}|${sha256(src or bytes)}`; honours expiresAt. */
  get(key: string): ResolvedResource | undefined
  set(key: string, value: ResolvedResource): void
}

/** The cache key (`${adapterId}|${scope}|${kind}|${sha256(src)}`). */
export function resourceCacheKey(adapterId: string, scope: string, kind: ResourceKind, src: string): string {
  const digest = createHash('sha256').update(src).digest('hex')
  return `${adapterId}|${scope}|${kind}|${digest}`
}

export interface MemoryResourceCacheOptions {
  /** LRU bound (entries). */
  max?: number
  now?: () => number
}

/** Default LRU bound of {@link MemoryResourceCache}: a few hundred platform keys cost little and cover a long chat. */
const DEFAULT_CACHE_MAX = 512

/** In-memory LRU `ResourceCache` honouring `expiresAt`. */
export class MemoryResourceCache implements ResourceCache {
  /** Insertion order is the recency order: `get` re-appends, `set` appends, the oldest entry is evicted first. */
  private readonly entries = new Map<string, ResolvedResource>()
  private readonly max: number
  private readonly now: () => number

  constructor(readonly options: MemoryResourceCacheOptions = {}) {
    this.max = options.max ?? DEFAULT_CACHE_MAX
    if (!(this.max >= 1)) throw new RangeError(`MemoryResourceCache max must be >= 1, got ${this.max}`)
    this.now = options.now ?? Date.now
  }

  get(key: string): ResolvedResource | undefined {
    const value = this.entries.get(key)
    if (!value) return undefined
    if (value.expiresAt !== undefined && value.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    // Refresh recency of a hit.
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  set(key: string, value: ResolvedResource): void {
    this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
  }
}

/** Objects whose contents are never walked by {@link collectResources}: opaque payloads, not draft structure. */
function isOpaque(value: object): boolean {
  return ArrayBuffer.isView(value)
    || value instanceof ArrayBuffer
    || value instanceof Date
    || value instanceof RegExp
    || value instanceof Promise
    || value instanceof WeakMap
    || value instanceof WeakSet
    || (typeof Blob !== 'undefined' && value instanceof Blob)
    || (typeof Response !== 'undefined' && value instanceof Response)
    || (typeof Request !== 'undefined' && value instanceof Request)
}

/** Deep-walk any value (drafts are adapter-defined) and collect the distinct `ResourceRef` instances, in order. */
export function collectResources(value: unknown): ResourceRef[] {
  const found: ResourceRef[] = []
  const visited = new Set<object>()

  const walk = (node: unknown) => {
    if (node instanceof ResourceRef) {
      // A ref's `meta` describes the same resource; a nested ref there would be an adapter bug, not a resource.
      if (!visited.has(node)) {
        visited.add(node)
        found.push(node)
      }
      return
    }
    if (!node || typeof node !== 'object') return
    if (visited.has(node) || isOpaque(node as object)) return
    visited.add(node)
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (node instanceof Map) {
      for (const [key, item] of node) {
        walk(key)
        walk(item)
      }
      return
    }
    if (node instanceof Set) {
      for (const item of node) walk(item)
      return
    }
    for (const item of Object.values(node as Record<string, unknown>)) walk(item)
  }

  walk(value)
  return found
}

export interface PrepareOptions {
  adapter: Pick<Adapter, 'id' | 'upload' | 'resourceScope'>
  target: Target
  cache: ResourceCache
  fetch: PrepareContext['fetch']
  signal?: AbortSignal
  /**
   * Dry run (`bot.render`): no upload and no cache lookup, so payloads are deterministic; every ref resolves to
   * `{ key: \`dryrun:${kind}:${src}\` }`.
   */
  skipUpload?: boolean
  /** Bounded upload concurrency, default 3. */
  concurrency?: number
}

/** Default upload concurrency of {@link prepare} (bounded concurrency 3). */
const DEFAULT_CONCURRENCY = 3

/** One `ResourceRef` that still needs an `adapter.upload` call, with its pre-computed cache identity. */
interface UploadTask {
  ref: ResourceRef
  scope: string
  key: string
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

/** Resolve every resource of every draft (dedupe → cache → `adapter.upload` for misses). Idempotent. */
export async function prepare<D>(drafts: readonly D[], options: PrepareOptions): Promise<Prepared<D>[]> {
  const { adapter, target, cache, fetch, skipUpload = false } = options
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
  if (!(concurrency >= 1)) throw new RangeError(`prepare concurrency must be >= 1, got ${concurrency}`)

  const caller = options.signal
  if (caller?.aborted) throw abortReason(caller)

  // One signal for every upload of this call: it follows the caller and is aborted as soon as the call gives up,
  // so a sibling upload's fetch is cancelled instead of running on after the message is already lost.
  const controller = new AbortController()
  const signal = controller.signal
  const relay = () => controller.abort(abortReason(caller!))
  caller?.addEventListener('abort', relay, { once: true })

  try {
    const perDraft = drafts.map(draft => collectResources(draft))

    // Distinct refs across all drafts, first-seen order.
    const unseen: ResourceRef[] = []
    const seen = new Set<ResourceRef>()
    for (const refs of perDraft) {
      for (const ref of refs) {
        if (seen.has(ref)) continue
        seen.add(ref)
        unseen.push(ref)
      }
    }

    const resolved = new Map<ResourceRef, ResolvedResource>()

    if (skipUpload) {
      for (const ref of unseen) resolved.set(ref, { key: `dryrun:${ref.kind}:${ref.src}` })
    } else if (unseen.length) {
      const context: PrepareContext = { target, signal, fetch, cache }

      // Split refs into cache hits (synchronous) and uploads. Distinct `ResourceRef` instances built from the same
      // src collapse onto one cache key, so `inflight` guarantees a single upload per key within this call.
      const tasks: UploadTask[] = []
      for (const ref of unseen) {
        const scope = adapter.resourceScope(target, ref.kind)
        const key = resourceCacheKey(adapter.id, scope, ref.kind, ref.src)
        const hit = cache.get(key)
        if (hit) {
          resolved.set(ref, hit)
          continue
        }
        tasks.push({ ref, scope, key })
      }

      const inflight = new Map<string, Promise<ResolvedResource>>()
      const load = (task: UploadTask) => {
        const existing = inflight.get(task.key)
        if (existing) return existing
        const pending = (async () => {
          const value = await adapter.upload(task.ref, task.scope, context)
          if (!value || typeof value.key !== 'string') {
            throw new TypeError(`adapter ${adapter.id} resolved no key for ${task.ref.kind} "${task.ref.src}"`)
          }
          cache.set(task.key, value)
          return value
        })()
        inflight.set(task.key, pending)
        return pending
      }

      let index = 0
      // `undefined` = no failure yet; wrapped so a handler throwing `undefined` still counts as a failure.
      let failure: { error: unknown } | undefined
      const worker = async () => {
        for (;;) {
          if (failure || index >= tasks.length) return
          const task = tasks[index++]
          if (signal.aborted) {
            failure = { error: abortReason(signal) }
            return
          }
          try {
            resolved.set(task.ref, await load(task))
          } catch (error) {
            failure = { error }
            controller.abort(error)
            return
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker))

      if (failure) throw failure.error
      if (caller?.aborted) throw abortReason(caller)
    }

    return drafts.map((draft, index) => ({
      draft,
      resolved: new Map<ResourceRef, ResolvedResource>(
        perDraft[index].map(ref => [ref, resolved.get(ref)!] as [ResourceRef, ResolvedResource]),
      ),
    }))
  } finally {
    caller?.removeEventListener('abort', relay)
  }
}

/** `data:` URL: `data:[<media-type>][;base64],<data>`. */
const DATA_URL = /^data:([^,]*),([\s\S]*)$/

/** The `base64:` src variants clients send (`base64://<payload>`, `base64:<payload>`). */
const BASE64_SRC = /^base64:(?:\/\/)?([\s\S]*)$/

/** Strip the parameters of a `content-type` header (`image/png; charset=binary` → `image/png`). */
function mimeOf(header: string | null): string | undefined {
  const mime = header?.split(';')[0].trim().toLowerCase()
  return mime || undefined
}

/** Extract a file name from `content-disposition`, preferring the RFC 5987 `filename*` form. */
function nameOf(header: string | null): string | undefined {
  if (!header) return undefined
  const extended = /filename\*\s*=\s*(?:UTF-8'')?("[^"]*"|[^;]+)/i.exec(header)
  const plain = /filename\s*=\s*("[^"]*"|[^;]+)/i.exec(header)
  const raw = extended?.[1] ?? plain?.[1]
  if (!raw) return undefined
  const value = raw.trim().replace(/^"|"$/g, '')
  if (!extended) return value || undefined
  try {
    return decodeURIComponent(value) || undefined
  } catch {
    return value || undefined
  }
}

/** Decode the src variants that carry their bytes inline; `undefined` means "fetch it over http". */
function inlineResource(src: string): FetchedResource | undefined {
  const data = DATA_URL.exec(src)
  if (data) {
    const meta = data[1]
    const payload = data[2]
    if (meta.endsWith(';base64')) {
      return { data: new Uint8Array(Binary.fromBase64(payload)), mime: mimeOf(meta.slice(0, -';base64'.length)) }
    }
    return { data: new TextEncoder().encode(decodeURIComponent(payload)), mime: mimeOf(meta) }
  }
  const base64 = BASE64_SRC.exec(src)
  if (base64) return { data: new Uint8Array(Binary.fromBase64(base64[1])) }
  return undefined
}

/**
 * Resource schemes one publication may reference: bytes its own content carries (`data:`, `base64:`) and resources
 * the core resolves itself (`satori:`). Everything else — `file:` above all — would have this host fetch the resource.
 */
export const PUBLISHABLE_SCHEMES = ['data:', 'base64:', 'satori:'] as const

/** What one {@link createResourceFetcher} accepts beyond the inline forms. */
export interface ResourceFetchPolicy {
  /**
   * Schemes this fetch accepts, matched case-insensitively on the src prefix. Absent accepts every scheme the http
   * service resolves (`http(s):`, `file:`, `satori:` …), which is what reading platform resources needs.
   */
  schemes?: readonly string[]
}

/**
 * `PrepareContext.fetch` backed by `ctx.http` (http(s), `satori:` via the core fetch hook) and data:/base64: decoding.
 * @param ctx - the context whose `http` service resolves the non-inline forms.
 * @param policy - which schemes are accepted; a refused one rejects with {@link RefusedContentError} before any I/O.
 * @returns the fetch of one prepare pass.
 */
export function createResourceFetcher(ctx: Context, policy: ResourceFetchPolicy = {}): PrepareContext['fetch'] {
  return async (src, signal) => {
    const inline = inlineResource(src)
    if (inline) return inline

    if (policy.schemes !== undefined) {
      const resolved = src.trim().toLowerCase()
      if (!policy.schemes.some(scheme => resolved.startsWith(scheme))) {
        throw new RefusedContentError(`the publication carries the resource "${preview(src)}", which this host will `
          + `not fetch: a published message references ${PUBLISHABLE_SCHEMES.join(', ')} resources only.`)
      }
    }

    const http = ctx.get('http')
    if (!http) throw new Error(`cannot fetch ${src}: the http service is not installed`)

    // `ctx.http` runs the `http/fetch` waterfall, which is what resolves `satori:` internal URLs (plugin-im-core's
    // own hook); `responseType` keeps the raw `Response` so the bytes and headers stay ours.
    const response = await http.get(src, { responseType: (raw: globalThis.Response) => raw, signal })
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      mime: mimeOf(response.headers.get('content-type')),
      name: nameOf(response.headers.get('content-disposition')),
    }
  }
}

/** One src, shortened to fit a diagnostic (a data: URL can be megabytes long). */
function preview(src: string): string {
  const trimmed = src.trim()
  return trimmed.length <= 120 ? trimmed : `${trimmed.slice(0, 120)}…`
}
