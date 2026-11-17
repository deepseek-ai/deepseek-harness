/**
 * Resources and the prepare stage.
 *
 * Covers cache hit/miss/expiry, scope separation, bounded concurrency, abort propagation, idempotency (preparing twice
 * uploads once), plus the deep walk and the `ctx.http` backed fetcher. No network: adapters and `ctx.http` are fakes.
 */

import { Context } from '@deepseek-ai/cordis'
import Http from '@deepseek-ai/cordis-plugin-http'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  Bot,
  collectResources,
  createResourceFetcher,
  MemoryResourceCache,
  type PrepareContext,
  type PrepareOptions,
  prepare,
  type ResourceCache,
  type ResourceKind,
  ResourceRef,
  ResourceTimeoutError,
  ResourceTooLargeError,
  resourceCacheKey,
  type ResolvedResource,
  Satori,
  type Target,
} from '@deepseek-ai/cordis-plugin-im-core'

const TARGET: Target = { chat: { id: 'c1', type: 'group' } }
const OTHER_TARGET: Target = { chat: { id: 'c2', type: 'group' } }

function sha256(source: string) {
  return createHash('sha256').update(source).digest('hex')
}

const noFetch: PrepareContext['fetch'] = async (src) => {
  throw new Error(`unexpected fetch of ${src}`)
}

// ---- cache keys -------------------------------------------------------------------------------------------------

describe('resourceCacheKey', () => {
  it('is `${adapterId}|${scope}|${kind}|${sha256(src)}`', () => {
    expect(resourceCacheKey('lark:app1', 'app', 'image', 'https://x/a.png'))
      .toBe(`lark:app1|app|image|${sha256('https://x/a.png')}`)
    expect(resourceCacheKey('lark:app1', 'app', 'image', 'https://x/a.png'))
      .toMatch(/^lark:app1\|app\|image\|[0-9a-f]{64}$/)
  })

  it('separates adapter, scope, kind and src, and never embeds the src', () => {
    const base = resourceCacheKey('qq:1', 'group:1084013940', 'image', 'https://x/a.png')
    expect(resourceCacheKey('qq:2', 'group:1084013940', 'image', 'https://x/a.png')).not.toBe(base)
    expect(resourceCacheKey('qq:1', 'user:42', 'image', 'https://x/a.png')).not.toBe(base)
    expect(resourceCacheKey('qq:1', 'group:1084013940', 'file', 'https://x/a.png')).not.toBe(base)
    expect(resourceCacheKey('qq:1', 'group:1084013940', 'image', 'https://x/b.png')).not.toBe(base)
    expect(base).not.toContain('a.png')
  })

  it('is stable for CJK and very long srcs', () => {
    const src = `https://x/图.png?${'a'.repeat(4096)}`
    expect(resourceCacheKey('lark:app', 'app', 'image', src)).toBe(resourceCacheKey('lark:app', 'app', 'image', src))
    expect(resourceCacheKey('lark:app', 'app', 'image', src)).not.toContain(src)
  })

  it('separates uploads whose src is identical but upload metadata differs', () => {
    const dataUrl = 'data:text/plain;base64,aGVsbG8='
    const plain = resourceCacheKey('lark:app', 'app', 'file', dataUrl)
    const namedA = resourceCacheKey('lark:app', 'app', 'file', dataUrl, { name: 'a.txt' })
    const namedB = resourceCacheKey('lark:app', 'app', 'file', dataUrl, { name: 'b.txt' })
    const mimeDiff = resourceCacheKey('lark:app', 'app', 'file', dataUrl, { name: 'a.txt', mime: 'text/csv' })
    const durationDiff = resourceCacheKey('lark:app', 'app', 'audio', dataUrl, { name: 'a.opus', duration: 12 })
    expect(namedA).not.toBe(plain)
    expect(namedA).not.toBe(namedB)
    expect(namedA).not.toBe(mimeDiff)
    expect(durationDiff).not.toBe(resourceCacheKey('lark:app', 'app', 'audio', dataUrl, { name: 'a.opus', duration: 15 }))
    expect(resourceCacheKey('lark:app', 'app', 'file', dataUrl, { mime: 'text/csv', name: 'a.txt' })).toBe(mimeDiff)
  })
})

// ---- MemoryResourceCache ----------------------------------------------------------------------------------------

describe('MemoryResourceCache', () => {
  it('misses unknown keys and round-trips values', () => {
    const cache = new MemoryResourceCache()
    expect(cache.get('missing')).toBeUndefined()
    cache.set('k', { key: 'img_v2_abc' })
    expect(cache.get('k')).toEqual({ key: 'img_v2_abc' })
  })

  it('honours expiresAt against an injected clock', () => {
    let now = 1_000
    const cache = new MemoryResourceCache({ now: () => now })
    cache.set('live', { key: 'a', expiresAt: 2_000 })
    cache.set('dead', { key: 'b', expiresAt: 1_000 })
    expect(cache.get('dead')).toBeUndefined()
    expect(cache.get('live')).toEqual({ key: 'a', expiresAt: 2_000 })
    now = 1_999
    expect(cache.get('live')).toEqual({ key: 'a', expiresAt: 2_000 })
    // Exactly at `expiresAt` the entry is already gone, and an expired hit drops the entry.
    now = 2_000
    expect(cache.get('live')).toBeUndefined()
    expect(cache.get('live')).toBeUndefined()
  })

  it('keeps entries without expiresAt forever', () => {
    let now = 0
    const cache = new MemoryResourceCache({ now: () => now })
    cache.set('k', { key: 'a' })
    now = 10 ** 12
    expect(cache.get('k')).toEqual({ key: 'a' })
  })

  it('bounds the LRU and evicts the least recently used entry', () => {
    const cache = new MemoryResourceCache({ max: 2 })
    cache.set('a', { key: 'a' })
    cache.set('b', { key: 'b' })
    // `a` becomes the most recently used, so `b` is the eviction victim.
    expect(cache.get('a')).toEqual({ key: 'a' })
    cache.set('c', { key: 'c' })
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toEqual({ key: 'a' })
    expect(cache.get('c')).toEqual({ key: 'c' })
  })

  it('overwrites without growing the cache', () => {
    const cache = new MemoryResourceCache({ max: 2 })
    cache.set('a', { key: 'old' })
    cache.set('b', { key: 'b' })
    cache.set('a', { key: 'new' })
    cache.set('c', { key: 'c' })
    expect(cache.get('a')).toEqual({ key: 'new' })
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('c')).toEqual({ key: 'c' })
  })

  it('rejects a nonsensical bound', () => {
    expect(() => new MemoryResourceCache({ max: 0 })).toThrow(RangeError)
  })
})

// ---- collectResources -------------------------------------------------------------------------------------------

describe('collectResources', () => {
  it('walks arrays, objects, maps and sets in document order', () => {
    const one = new ResourceRef('image', 'https://x/1.png')
    const two = new ResourceRef('file', 'https://x/2.pdf')
    const three = new ResourceRef('audio', 'base64://AAA=')
    const four = new ResourceRef('video', 'https://x/4.mp4')
    const draft = {
      content: [[{ tag: 'img', image_key: one }], { tag: 'file', file_key: two }],
      extra: new Map<any, any>([[three, { nested: [four] }]]),
      tags: new Set([one]),
    }
    expect(collectResources(draft)).toEqual([one, two, three, four])
  })

  it('returns each instance once and preserves first-seen order', () => {
    const ref = new ResourceRef('image', 'https://x/1.png')
    expect(collectResources([ref, { a: ref }, [ref]])).toEqual([ref])
  })

  it('ignores primitives, functions and opaque payloads', () => {
    const ref = new ResourceRef('image', 'https://x/1.png')
    const draft = {
      text: 'hello',
      count: 3,
      nothing: null,
      missing: undefined,
      flag: true,
      callback: () => ref,
      bytes: new Uint8Array([1, 2, 3]),
      time: new Date(),
      pattern: /x/g,
      buffer: new ArrayBuffer(8),
      ref,
    }
    expect(collectResources(draft)).toEqual([ref])
    expect(collectResources('plain')).toEqual([])
    expect(collectResources(undefined)).toEqual([])
  })

  it('terminates on cycles', () => {
    const ref = new ResourceRef('image', 'https://x/1.png')
    const draft: any = { ref }
    draft.self = draft
    const list = [draft]
    list.push(list as any)
    expect(collectResources(draft)).toEqual([ref])
    expect(collectResources(list)).toEqual([ref])
  })

  it('does not treat a ref smuggled into another ref meta as a draft resource', () => {
    const nested = new ResourceRef('image', 'https://x/inner.png')
    const outer = new ResourceRef('image', 'https://x/outer.png', { name: 'x', mime: 'image/png' })
    ;(outer.meta as any).nested = nested
    expect(collectResources({ ref: outer })).toEqual([outer])
  })

  it('accepts a bare ref', () => {
    const ref = new ResourceRef('image', 'https://x/1.png')
    expect(collectResources(ref)).toEqual([ref])
  })
})

// ---- prepare ----------------------------------------------------------------------------------------------------

interface UploadCall {
  ref: ResourceRef
  scope: string
  ctx: PrepareContext
}

function makeAdapter(options: {
  /** Artificial latency so concurrency is observable. */
  delayMs?: number
  /** Fail the upload of a matching ref. */
  fail?: (ref: ResourceRef) => unknown
  resetScope?: boolean
} = {}) {
  const calls: UploadCall[] = []
  let active = 0
  let peak = 0
  const adapter = {
    id: 'fake:bot',
    async upload(ref: ResourceRef, scope: string, ctx: PrepareContext): Promise<ResolvedResource> {
      calls.push({ ref, scope, ctx })
      active++
      peak = Math.max(peak, active)
      try {
        if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs))
        const failure = options.fail?.(ref)
        if (failure !== undefined) throw failure
        return { key: `uploaded|${scope}|${ref.kind}|${ref.src}` }
      } finally {
        active--
      }
    },
    /** Deliberately ignores the kind, so only the cache key's own `kind` segment separates the two. */
    resourceScope(target: Target, kind: ResourceKind) {
      return options.resetScope ? `chat:${target.chat.id}` : `chat:${target.chat.id}/${kind}`
    },
  }
  return { adapter, calls, peak: () => peak }
}

function options(overrides: Partial<PrepareOptions> & Pick<PrepareOptions, 'adapter'>): PrepareOptions {
  return { target: TARGET, cache: new MemoryResourceCache(), fetch: noFetch, ...overrides }
}

describe('prepare', () => {
  it('resolves every draft resource and reports one map per draft', async () => {
    const image = new ResourceRef('image', 'https://x/1.png')
    const file = new ResourceRef('file', 'https://x/2.pdf')
    const { adapter, calls } = makeAdapter()
    const prepared = await prepare([{ content: [image] }, { content: [file] }], options({ adapter }))

    expect(prepared).toHaveLength(2)
    expect(prepared[0]!.draft).toEqual({ content: [image] })
    expect(prepared[0]!.resolved.get(image)).toEqual({ key: 'uploaded|chat:c1/image|image|https://x/1.png' })
    expect(prepared[0]!.resolved.has(file)).toBe(false)
    expect(prepared[1]!.resolved.get(file)).toEqual({ key: 'uploaded|chat:c1/file|file|https://x/2.pdf' })
    expect(calls.map(call => call.scope)).toEqual(['chat:c1/image', 'chat:c1/file'])
  })

  it('uploads once per cache key even for distinct instances of the same src', async () => {
    const first = new ResourceRef('image', 'https://x/1.png')
    const second = new ResourceRef('image', 'https://x/1.png')
    const { adapter, calls } = makeAdapter()
    const prepared = await prepare([{ image: first }, { image: second }], options({ adapter }))

    expect(calls).toHaveLength(1)
    expect(prepared[0]!.resolved.get(first)).toEqual(prepared[1]!.resolved.get(second))
    expect(prepared[0]!.resolved.size).toBe(1)
  })

  it('is idempotent: preparing the same drafts twice uploads once', async () => {
    const cache = new MemoryResourceCache()
    const { adapter, calls } = makeAdapter()
    const draft = { image: new ResourceRef('image', 'https://x/1.png') }

    const first = await prepare([draft], options({ adapter, cache }))
    const second = await prepare([draft], options({ adapter, cache }))

    expect(calls).toHaveLength(1)
    expect(second[0]!.resolved.get(draft.image)).toEqual(first[0]!.resolved.get(draft.image))
  })

  it('reuses a pre-seeded cache entry without uploading', async () => {
    const ref = new ResourceRef('image', 'https://x/1.png')
    const cache = new MemoryResourceCache()
    const key = resourceCacheKey('fake:bot', 'chat:c1/image', 'image', 'https://x/1.png')
    cache.set(key, { key: 'img_v2_seeded', expiresAt: Date.now() + 60_000 })
    const { adapter, calls } = makeAdapter()

    const prepared = await prepare([{ ref }], options({ adapter, cache }))
    expect(calls).toHaveLength(0)
    expect(prepared[0]!.resolved.get(ref)).toEqual({ key: 'img_v2_seeded', expiresAt: expect.any(Number) })
  })

  it('writes every upload back into the cache', async () => {
    const ref = new ResourceRef('image', 'https://x/1.png')
    const cache = new MemoryResourceCache()
    const { adapter } = makeAdapter()
    await prepare([{ ref }], options({ adapter, cache }))
    expect(cache.get(resourceCacheKey('fake:bot', 'chat:c1/image', 'image', 'https://x/1.png')))
      .toEqual({ key: 'uploaded|chat:c1/image|image|https://x/1.png' })
  })

  it('separates scopes: the same src is uploaded per chat and per kind', async () => {
    const image = new ResourceRef('image', 'https://x/same.bin')
    const file = new ResourceRef('file', 'https://x/same.bin')
    const cache = new MemoryResourceCache()
    const { adapter, calls } = makeAdapter({ resetScope: true })

    const first = await prepare([{ content: [image] }], options({ adapter, cache }))
    const second = await prepare([{ content: [image] }], options({ adapter, cache, target: OTHER_TARGET }))
    const third = await prepare([{ content: [file] }], options({ adapter, cache }))

    expect(calls.map(call => call.scope)).toEqual(['chat:c1', 'chat:c2', 'chat:c1'])
    expect(first[0]!.resolved.get(image)).toEqual({ key: 'uploaded|chat:c1|image|https://x/same.bin' })
    expect(second[0]!.resolved.get(image)).toEqual({ key: 'uploaded|chat:c2|image|https://x/same.bin' })
    expect(third[0]!.resolved.get(file)).toEqual({ key: 'uploaded|chat:c1|file|https://x/same.bin' })
  })

  it('re-resolves an expired cache entry', async () => {
    const ref = new ResourceRef('image', 'https://x/1.png')
    const cache = new MemoryResourceCache()
    const key = resourceCacheKey('fake:bot', 'chat:c1/image', 'image', 'https://x/1.png')
    cache.set(key, { key: 'stale', expiresAt: Date.now() - 1 })
    const { adapter, calls } = makeAdapter()

    const prepared = await prepare([{ ref }], options({ adapter, cache }))
    expect(calls).toHaveLength(1)
    expect(prepared[0]!.resolved.get(ref)).toEqual({ key: 'uploaded|chat:c1/image|image|https://x/1.png' })
  })

  it('bounds upload concurrency at 3 by default and honours the override', async () => {
    const refs = Array.from({ length: 7 }, (_, index) => new ResourceRef('image', `https://x/${index}.png`))

    const defaults = makeAdapter({ delayMs: 5 })
    await prepare([{ content: refs }], options({ adapter: defaults.adapter }))
    expect(defaults.calls).toHaveLength(7)
    expect(defaults.peak()).toBe(3)

    const serial = makeAdapter({ delayMs: 1 })
    await prepare([{ content: refs }], options({ adapter: serial.adapter, concurrency: 1 }))
    expect(serial.peak()).toBe(1)

    const wide = makeAdapter({ delayMs: 1 })
    await prepare([{ content: refs }], options({ adapter: wide.adapter, concurrency: 7 }))
    expect(wide.peak()).toBe(7)
  })

  it('rejects a nonsensical concurrency', async () => {
    const { adapter } = makeAdapter()
    await expect(prepare([], options({ adapter, concurrency: 0 }))).rejects.toThrow(RangeError)
  })

  it('hands the adapter a PrepareContext with the target, signal, fetch and cache', async () => {
    const cache = new MemoryResourceCache()
    const { adapter, calls } = makeAdapter()
    const controller = new AbortController()
    await prepare([{ ref: new ResourceRef('image', 'https://x/1.png') }], {
      ...options({ adapter, cache }), signal: controller.signal,
    })
    expect(calls[0]!.ctx.target).toBe(TARGET)
    expect(calls[0]!.ctx.cache).toBe(cache)
    expect(calls[0]!.ctx.fetch).toBe(noFetch)
    expect(calls[0]!.ctx.signal).toBeInstanceOf(AbortSignal)
    expect(calls[0]!.ctx.signal.aborted).toBe(false)
  })

  it('never touches the cache or the adapter for a dry run', async () => {
    const touched: string[] = []
    const cache: ResourceCache = {
      get(key) { touched.push(`get ${key}`); throw new Error('cache must not be read') },
      set(key) { touched.push(`set ${key}`); throw new Error('cache must not be written') },
    }
    const { adapter, calls } = makeAdapter()
    const image = new ResourceRef('image', 'https://x/1.png')
    const prepared = await prepare([{ content: [image] }, { content: [] }], options({ adapter, cache, skipUpload: true }))

    expect(calls).toHaveLength(0)
    expect(touched).toEqual([])
    expect(prepared[0]!.resolved.get(image)).toEqual({ key: 'dryrun:image:https://x/1.png' })
    expect(prepared[1]!.resolved.size).toBe(0)
  })

  it('returns one empty map per draft when there is nothing to resolve', async () => {
    const { adapter, calls } = makeAdapter()
    expect(await prepare([], options({ adapter }))).toEqual([])
    const prepared = await prepare([{ text: 'hi' }, undefined, 'plain'], options({ adapter }))
    expect(prepared.map(entry => entry.resolved.size)).toEqual([0, 0, 0])
    expect(prepared[1]!.draft).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('rejects with the upload failure and cancels the sibling uploads', async () => {
    const failure = new Error('upload rejected')
    const slowStarted = deferred()
    const adapter = {
      id: 'fake:bot',
      async upload(ref: ResourceRef, _scope: string, ctx: PrepareContext): Promise<ResolvedResource> {
        if (ref.src === 'https://x/bad.png') {
          await Promise.resolve()
          throw failure
        }
        slowStarted.resolve()
        return new Promise<ResolvedResource>((_, reject) => {
          ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true })
        })
      },
      resourceScope: () => 'app',
    }
    const pending = prepare([{
      content: [new ResourceRef('image', 'https://x/bad.png'), new ResourceRef('image', 'https://x/slow.png')],
    }], options({ adapter }))

    await slowStarted.promise
    await expect(pending).rejects.toBe(failure)
  })

  it('rejects immediately when the caller signal is already aborted', async () => {
    const reason = new Error('already gone')
    const controller = new AbortController()
    controller.abort(reason)
    const { adapter, calls } = makeAdapter()
    await expect(prepare([{ ref: new ResourceRef('image', 'https://x/1.png') }], {
      ...options({ adapter }), signal: controller.signal,
    })).rejects.toBe(reason)
    expect(calls).toHaveLength(0)
  })

  it('propagates a mid-flight abort to the adapter and rejects with the reason', async () => {
    const started = deferred()
    const signals: AbortSignal[] = []
    const adapter = {
      id: 'fake:bot',
      upload(_ref: ResourceRef, _scope: string, ctx: PrepareContext): Promise<ResolvedResource> {
        signals.push(ctx.signal)
        started.resolve()
        return new Promise<ResolvedResource>((_, reject) => {
          ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true })
        })
      },
      resourceScope: () => 'app',
    }
    const controller = new AbortController()
    const pending = prepare([{ ref: new ResourceRef('image', 'https://x/1.png') }], {
      ...options({ adapter }), signal: controller.signal,
    })

    await started.promise
    const reason = new Error('send cancelled')
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
    expect(signals[0]!.aborted).toBe(true)
    expect(signals[0]!.reason).toBe(reason)
  })

  it('rejects when the adapter resolves no key', async () => {
    const adapter = {
      id: 'fake:bot',
      async upload(): Promise<ResolvedResource> {
        return undefined as unknown as ResolvedResource
      },
      resourceScope: () => 'app',
    }
    await expect(prepare([{ ref: new ResourceRef('image', 'https://x/1.png') }], options({ adapter })))
      .rejects.toThrow(/resolved no key/)
  })
})

// ---- createResourceFetcher --------------------------------------------------------------------------------------

function fakeContext(http: unknown): Context {
  return { get: (name: string) => name === 'http' ? http : undefined } as unknown as Context
}

function fakeHttp(build: () => Response) {
  const calls: { src: string; config: any }[] = []
  return {
    calls,
    http: {
      async get(src: string, config: any) {
        calls.push({ src, config })
        // Mirrors `Http._decode`: the `responseType` decoder turns the raw response into the result.
        return await config.responseType(build())
      },
    },
  }
}

describe('createResourceFetcher', () => {
  it('decodes a base64 data: URL with its media type', async () => {
    const { http, calls } = fakeHttp(() => new Response())
    const fetch = createResourceFetcher(fakeContext(http))
    // "PNG" bytes, base64.
    const fetched = await fetch('data:image/png;base64,UE5H', new AbortController().signal)
    expect([...fetched.data]).toEqual([0x50, 0x4e, 0x47])
    expect(fetched.mime).toBe('image/png')
    expect(fetched.name).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('decodes a percent-encoded data: URL', async () => {
    const fetch = createResourceFetcher(fakeContext(undefined))
    const fetched = await fetch('data:text/plain,hello%20world', new AbortController().signal)
    expect(new TextDecoder().decode(fetched.data)).toBe('hello world')
    expect(fetched.mime).toBe('text/plain')
  })

  it('decodes a base64: src without a media type', async () => {
    const fetch = createResourceFetcher(fakeContext(undefined))
    for (const src of ['base64://UE5H', 'base64:UE5H']) {
      const fetched = await fetch(src, new AbortController().signal)
      expect([...fetched.data]).toEqual([0x50, 0x4e, 0x47])
      expect(fetched.mime).toBeUndefined()
    }
  })

  it('fetches http(s) through ctx.http and reads mime and name from the headers', async () => {
    const { http, calls } = fakeHttp(() => new Response(new Uint8Array([1, 2, 3]), {
      headers: {
        'content-type': 'image/png; charset=binary',
        'content-disposition': 'attachment; filename="a.png"',
      },
    }))
    const fetch = createResourceFetcher(fakeContext(http))
    const signal = new AbortController().signal
    const fetched = await fetch('https://example.com/a.png', signal)

    expect([...fetched.data]).toEqual([1, 2, 3])
    expect(fetched.mime).toBe('image/png')
    expect(fetched.name).toBe('a.png')
    expect(calls[0]!.src).toBe('https://example.com/a.png')
    expect(calls[0]!.config.signal).toBe(signal)
  })

  it('routes satori: internal URLs through the same http waterfall', async () => {
    const { http, calls } = fakeHttp(() => new Response(new Uint8Array([7]), {
      headers: { 'content-type': 'image/jpeg' },
    }))
    const fetch = createResourceFetcher(fakeContext(http))
    const fetched = await fetch('satori:lark/on_1/messages/om_1/resources/file_1?type=image', new AbortController().signal)
    expect([...fetched.data]).toEqual([7])
    expect(calls[0]!.src).toContain('satori:lark/on_1/messages/om_1/resources/file_1')
  })

  it('decodes an RFC 5987 filename*', async () => {
    const { http } = fakeHttp(() => new Response(new Uint8Array(), {
      headers: { 'content-disposition': `attachment; filename*=UTF-8''na%C3%AFve%20file.png` },
    }))
    const fetch = createResourceFetcher(fakeContext(http))
    const fetched = await fetch('https://example.com/x', new AbortController().signal)
    expect(fetched.name).toBe('naïve file.png')
    expect(fetched.mime).toBeUndefined()
  })

  it('reports a missing http service instead of fetching silently', async () => {
    const fetch = createResourceFetcher(fakeContext(undefined))
    await expect(fetch('https://example.com/a.png', new AbortController().signal))
      .rejects.toThrow(/http service is not installed/)
  })

  it('propagates a fetch failure', async () => {
    const failure = new Error('STATUS_ERROR')
    const http = { async get() { throw failure } }
    const fetch = createResourceFetcher(fakeContext(http))
    await expect(fetch('https://example.com/a.png', new AbortController().signal)).rejects.toBe(failure)
  })

  it('refuses a body whose declared length is over the policy limit', async () => {
    const { http } = fakeHttp(() => new Response(new Uint8Array(10), { headers: { 'content-length': '10' } }))
    const fetch = createResourceFetcher(fakeContext(http), { maxBytes: 4 })
    await expect(fetch('https://example.com/big.bin', new AbortController().signal))
      .rejects.toBeInstanceOf(ResourceTooLargeError)
  })

  it('stops reading a body once it passes the policy limit', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(3))
        controller.enqueue(new Uint8Array(3))
        controller.close()
      },
    })
    // No `content-length`, so the limit has to hold while reading: the second chunk takes it over.
    const http = { async get(_src: string, config: any) { return await config.responseType(new Response(body)) } }
    const fetch = createResourceFetcher(fakeContext(http), { maxBytes: 4 })
    await expect(fetch('https://example.com/stream.bin', new AbortController().signal))
      .rejects.toBeInstanceOf(ResourceTooLargeError)
  })

  it('keeps a body that fits the policy limit', async () => {
    const { http } = fakeHttp(() => new Response(new Uint8Array([1, 2, 3])))
    const fetch = createResourceFetcher(fakeContext(http), { maxBytes: 4 })
    expect([...(await fetch('https://example.com/ok.bin', new AbortController().signal)).data]).toEqual([1, 2, 3])
  })

  it('refuses an inline resource over the policy limit', async () => {
    const fetch = createResourceFetcher(fakeContext(undefined), { maxBytes: 1 })
    await expect(fetch('data:text/plain,hello', new AbortController().signal))
      .rejects.toBeInstanceOf(ResourceTooLargeError)
  })

  /** A response whose headers arrive at once and whose body sends one chunk, then never another or an end. */
  function drippingHttp() {
    const calls: { config: any }[] = []
    let cancelled: unknown
    const http = {
      async get(_src: string, config: any) {
        calls.push({ config })
        const body = new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new Uint8Array(1)) },
          cancel(reason) { cancelled = reason ?? true },
        })
        return await config.responseType(new Response(body))
      },
    }
    return { http, calls, cancelled: () => cancelled }
  }

  it('ends a body that drips past the policy deadline, whatever the transport timer does', async () => {
    const { http, calls, cancelled } = drippingHttp()
    const fetch = createResourceFetcher(fakeContext(http), { maxBytes: 1024, timeout: 30 })
    const started = Date.now()
    await expect(fetch('https://example.com/slow.png', new AbortController().signal))
      .rejects.toBeInstanceOf(ResourceTimeoutError)
    expect(Date.now() - started).toBeLessThan(2_000)
    // The deadline is the fetcher's own signal, not the transport `timeout` `ctx.http` clears once the headers arrive.
    expect(calls[0]!.config.timeout).toBeUndefined()
    expect(calls[0]!.config.signal.aborted).toBe(true)
    expect(cancelled()).toBeDefined()
  })

  it('bounds an unlimited body by the deadline too', async () => {
    const { http } = drippingHttp()
    const fetch = createResourceFetcher(fakeContext(http), { timeout: 30 })
    await expect(fetch('https://example.com/slow.png', new AbortController().signal))
      .rejects.toBeInstanceOf(ResourceTimeoutError)
  })

  it('rejects with the caller cancellation, not a timeout, when the caller aborts first', async () => {
    const { http } = drippingHttp()
    const fetch = createResourceFetcher(fakeContext(http), { maxBytes: 1024, timeout: 60_000 })
    const caller = new AbortController()
    const reason = new Error('caller stopped')
    const pending = fetch('https://example.com/slow.png', caller.signal)
    setTimeout(() => caller.abort(reason), 10)
    await expect(pending).rejects.toBe(reason)
  })

  it('propagates deadline and caller aborts into satori: internal routes and 3xx redirects before headers arrive', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(Http)
      await ctx.plugin(Satori)
      class TestBot extends Bot {}
      const bot = new TestBot(ctx, {}, { id: 'lark:1', platform: 'lark' })
      bot.selfId = 'ou_bot'

      const seenSignals: AbortSignal[] = []
      ctx.satori.defineInternalRoute('/slow/:id', async (request) => {
        seenSignals.push(request.signal)
        return await new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
        })
      })
      ctx.satori.defineInternalRoute('/ignore-signal/:id', async () => {
        return await new Promise<Response>(() => {})
      })
      ctx.satori.defineInternalRoute('/bounce/:id', async () => {
        return new Response(null, { status: 302, headers: { location: bot.getInternalUrl('/slow/redirected') } })
      })

      const fetchWithDeadline = createResourceFetcher(ctx, { timeout: 25 })
      await expect(fetchWithDeadline(bot.getInternalUrl('/slow/1'), new AbortController().signal))
        .rejects.toBeInstanceOf(ResourceTimeoutError)
      expect(seenSignals[0]?.aborted).toBe(true)

      await expect(fetchWithDeadline(bot.getInternalUrl('/ignore-signal/1'), new AbortController().signal))
        .rejects.toBeInstanceOf(ResourceTimeoutError)

      await expect(fetchWithDeadline(bot.getInternalUrl('/bounce/1'), new AbortController().signal))
        .rejects.toBeInstanceOf(ResourceTimeoutError)
      expect(seenSignals[1]?.aborted).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not leak an unhandledRejection when signal aborts after headers arrive and before body read', async () => {
    const reason = new Error('aborted after headers')
    const caller = new AbortController()
    const readError = new Error('body read rejected after abort')
    const unhandled: unknown[] = []
    const onUnhandled = (err: unknown) => { unhandled.push(err) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const http = {
        async get() {
          caller.abort(reason)
          return {
            status: 200,
            headers: new Headers({ 'content-type': 'application/octet-stream' }),
            body: {
              getReader: () => ({
                read: () => Promise.reject(readError),
                cancel: async () => {},
              }),
            },
          } as unknown as Response
        },
      } as unknown as Http
      const fetch = createResourceFetcher(fakeContext(http), { timeout: 60_000 })
      await expect(fetch('https://example.com/headers-then-abort.bin', caller.signal)).rejects.toBe(reason)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

// ---- helpers ----------------------------------------------------------------------------------------------------

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}
