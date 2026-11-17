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
import { ResourceTimeoutError, ResourceTooLargeError } from './errors.ts'
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

/**
 * The cache key (`${adapterId}|${scope}|${kind}|${sha256(src, meta)}`).
 * @param adapterId - adapter id owning the upload.
 * @param scope - upload scope returned by `resourceScope`.
 * @param kind - resource kind (`image`, `audio`, `video`, `file`).
 * @param src - resource source URL or path.
 * @param meta - optional upload metadata (`name`, `mime`, `duration`, `width`, `height`).
 * @returns deterministic cache key for `(adapterId, scope, kind, src, meta)`.
 */
export function resourceCacheKey(
  adapterId: string,
  scope: string,
  kind: ResourceKind,
  src: string,
  meta: ResourceMeta = {},
): string {
  const hash = createHash('sha256').update(src)
  const hasMeta = meta.name !== undefined || meta.mime !== undefined || meta.duration !== undefined
    || meta.width !== undefined || meta.height !== undefined
  if (hasMeta) {
    hash.update('\0').update(JSON.stringify([
      meta.name ?? null,
      meta.mime ?? null,
      meta.duration ?? null,
      meta.width ?? null,
      meta.height ?? null,
    ]))
  }
  return `${adapterId}|${scope}|${kind}|${hash.digest('hex')}`
}

/**
 * Whether a src names bytes of this host rather than a remote resource: the file behind a `file:` URL can change
 * without its URL changing, so a platform key resolved for it does not describe the next publication.
 * @param src - the source of one resource reference.
 * @returns true for a `file:` src.
 */
export function isMutableSource(src: string): boolean {
  try {
    return new URL(src).protocol === 'file:'
  } catch {
    // Not a URL at all: the adapter's upload decides what it is, and its cache key is whatever the src spells.
    return false
  }
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
        const key = resourceCacheKey(adapter.id, scope, ref.kind, ref.src, ref.meta)
        // A `file:` src names bytes this host can change between two publications, and a platform key usually has no
        // expiry: caching it would publish the old content for the new path forever. It is still deduplicated within
        // this call by `inflight`.
        if (isMutableSource(ref.src)) {
          tasks.push({ ref, scope, key })
          continue
        }
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
          if (!isMutableSource(task.ref.src)) cache.set(task.key, value)
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

/** What one {@link createResourceFetcher} bounds. */
export interface ResourceFetchPolicy {
  /**
   * Refuse a resource bigger than this many bytes, deciding from the declared `content-length` and again while the body
   * is read. The inbound media of a message is downloaded by whoever wrote that message, so without a limit one chat
   * member decides how much memory this process buffers.
   */
  maxBytes?: number
  /**
   * How the transport treats a 3xx answer (`RequestInit.redirect`). A caller that admitted the source before fetching it
   * passes `'error'`: the connection reaches the admitted URL only, so a redirect cannot carry it to a host the caller
   * refused. The `satori:` internal route answers its own 3xx and is unaffected.
   */
  redirect?: RequestRedirect
  /**
   * Deadline of the whole fetch in milliseconds, the body included. It is a signal of the fetcher's own, joined with
   * the caller's and held until the last byte is read, rather than the transport's `timeout`, which `ctx.http` clears
   * as soon as the response headers arrive: a server that answers its headers at once and then drips the body would
   * otherwise hold the call for as long as it likes. When it passes, the request is aborted and the call rejects.
   */
  timeout?: number
}

/**
 * `PrepareContext.fetch` backed by `ctx.http` (http(s), `satori:` via the core fetch hook) and data:/base64: decoding.
 * @param ctx - the context whose `http` service resolves the non-inline forms.
 * @param policy - how much one resource may weigh, where it may be redirected to, and how long it may take.
 * @returns the fetch of one prepare pass.
 */
export function createResourceFetcher(ctx: Context, policy: ResourceFetchPolicy = {}): PrepareContext['fetch'] {
  return async (src, signal) => {
    const inline = inlineResource(src)
    if (inline) {
      if (policy.maxBytes !== undefined && inline.data.byteLength > policy.maxBytes) {
        throw new ResourceTooLargeError(policy.maxBytes, inline.data.byteLength,
          `resource "${preview(src)}" is ${inline.data.byteLength} bytes, over the ${policy.maxBytes}-byte limit`)
      }
      return inline
    }

    const http = ctx.get('http')
    if (!http) throw new Error(`cannot fetch ${src}: the http service is not installed`)

    const deadline = policy.timeout === undefined ? undefined : AbortSignal.timeout(policy.timeout)
    const bounded = deadline === undefined ? signal : AbortSignal.any([signal, deadline])
    try {
      // `ctx.http` runs the `http/fetch` waterfall, which is what resolves `satori:` internal URLs (plugin-im-core's
      // own hook) and `file:` sources; `responseType` keeps the raw `Response` so the bytes and headers stay ours.
      const response = await http.get(src, {
        responseType: (raw: globalThis.Response) => raw,
        signal: bounded,
        ...policy.redirect === undefined ? {} : { redirect: policy.redirect },
      })
      return {
        data: await readBounded(response, policy.maxBytes, src, bounded),
        mime: mimeOf(response.headers.get('content-type')),
        name: nameOf(response.headers.get('content-disposition')),
      }
    } catch (error) {
      if (deadline?.aborted && !signal.aborted) {
        throw new ResourceTimeoutError(policy.timeout!, `resource "${preview(src)}" did not arrive within ${policy.timeout} ms`)
      }
      throw error
    }
  }
}

/**
 * Settle with `pending`, or reject with the reason of `signal` as soon as it aborts. A body stream is not required to
 * honour the signal of the request that produced it (a `http/fetch` hook can answer with any stream), so every read is
 * raced against it instead of trusting the stream to error.
 */
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // Callers construct `pending` (e.g. `reader.read()` / `response.arrayBuffer()`) before entering here;
    // observe any late rejection on it so an already-aborted signal never leaks an unhandledRejection.
    void pending.catch(() => {})
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/**
 * Read one response body, refusing it as soon as it passes `maxBytes`: the declared length first, then every chunk, so
 * an oversized body is abandoned instead of buffered. Every read is bounded by `signal`, which carries the deadline of
 * the whole fetch: when it aborts, the body is cancelled and the read rejects with its reason.
 * @param response - the raw response the http service returned.
 * @param maxBytes - the accepted size, or `undefined` for no limit.
 * @param src - the resource URL, used in the refusal only through its preview.
 * @param signal - cancellation of the caller joined with the fetch deadline.
 * @returns the body bytes.
 */
async function readBounded(
  response: globalThis.Response,
  maxBytes: number | undefined,
  src: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'))
  if (maxBytes !== undefined && Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel()
    throw new ResourceTooLargeError(maxBytes, declared,
      `resource "${preview(src)}" declares ${declared} bytes, over the ${maxBytes}-byte limit`)
  }
  const reader = response.body?.getReader()
  if (reader === undefined) return new Uint8Array(await abortable(response.arrayBuffer(), signal))
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const chunk = await abortable(reader.read(), signal)
      if (chunk.done) break
      total += chunk.value.byteLength
      if (maxBytes !== undefined && total > maxBytes) {
        throw new ResourceTooLargeError(maxBytes, undefined,
          `resource "${preview(src)}" is over the ${maxBytes}-byte limit`)
      }
      chunks.push(chunk.value)
    }
  } catch (error) {
    // The body is abandoned either way; its cancellation can fail on a stream that already errored, which changes
    // nothing for a body nobody reads again, so only the original error is reported.
    reader.cancel(error).catch((cancelError: unknown) => void cancelError)
    throw error
  }
  const data = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.byteLength
  }
  return data
}

/** One src, shortened to fit a diagnostic (a data: URL can be megabytes long). */
function preview(src: string): string {
  const trimmed = src.trim()
  return trimmed.length <= 120 ? trimmed : `${trimmed.slice(0, 120)}…`
}
