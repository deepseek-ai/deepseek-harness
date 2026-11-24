/**
 * The upload stage : `POST /v2/{groups|users}/{id}/files`, the `file_type` mapping and the TTL
 * that lets the core cache a `file_info` per chat. Every request is answered by a stubbed transport.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Http from '@deepseek-ai/cordis-plugin-http'
import { PlatformError, ResourceRef, Satori, type PrepareContext } from '@deepseek-ai/cordis-plugin-im-core'
import QQBot, {
  Config,
  uploadFileType,
  uploadResource,
  type QQConfig,
} from '@deepseek-ai/cordis-plugin-im-adapter-qq'

const GROUP = 'group:FBB1D91204242AAB8B61A0179A6245B0'
const DIRECT = 'user:DD8246C68EC19CAF8D2AA76941180EA4'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** One request the adapter made (the token call is not recorded). */
interface Call {
  url: string
  method: string | undefined
  data: any
  signal: AbortSignal | undefined
}

/** An answer body or status of the scripted platform. */
interface Answer {
  status?: number
  body?: unknown
}

/** Mount the adapter on a context whose only transport is the scripted `http/fetch` hook. */
async function mount(answer: (call: Call) => Answer = () => ({ body: { file_info: 'FILE_INFO', ttl: 3600 } })) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Http)
  await ctx.plugin(Satori)
  const calls: Call[] = []
    // Contextual typing gives the hook the http package's own request init (undici), so the stub stays exact.
  ctx.on('http/fetch', async (url, init) => {
    const href = String(url)
    if (href.startsWith('https://bots.qq.com/')) {
      return new Response(JSON.stringify({ access_token: 'access-token', expires_in: 7200 }), { status: 200 })
    }
    const call: Call = {
      url: href,
      method: init.method,
      data: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      signal: init.signal ?? undefined,
    }
    calls.push(call)
    const result = answer(call)
    return new Response(result.body === undefined ? null : JSON.stringify(result.body), { status: result.status ?? 200 })
  })
  const config: QQConfig = Config({ appId: '102106848', secret: 'secret', transport: 'none' } as QQConfig)
  await ctx.plugin(QQBot, config)
  const bot = ctx.bots[0] as QQBot
  return { ctx, bot, calls }
}

/** The prepare context the core hands to `upload`; only `fetch` is exercised by a scripted source. */
function createPrepareContext(
  fetch: PrepareContext['fetch'] = async () => ({ data: new Uint8Array([104, 105]) }),
): PrepareContext {
  return {
    target: { chat: { id: GROUP, type: 'group' } },
    signal: new AbortController().signal,
    fetch,
    cache: { get: () => undefined, set: () => {} },
  }
}

describe('uploadFileType', () => {
  it('uploads images as images', () => {
    expect(uploadFileType(new ResourceRef('image', 'https://example.com/a.png'))).toEqual({ fileType: 1, downgraded: false })
  })

  it('uploads MP4 video as video, by MIME or by extension', () => {
    expect(uploadFileType(new ResourceRef('video', 'https://example.com/clip', { mime: 'video/mp4' })))
      .toEqual({ fileType: 2, downgraded: false })
    expect(uploadFileType(new ResourceRef('video', 'https://example.com/clip.MP4')))
      .toEqual({ fileType: 2, downgraded: false })
  })

  it('uploads any other video as a plain file', () => {
    expect(uploadFileType(new ResourceRef('video', 'https://example.com/clip.mov', { mime: 'video/quicktime' })))
      .toEqual({ fileType: 4, downgraded: true })
  })

  it('uploads SILK voice as voice, by MIME or by extension', () => {
    expect(uploadFileType(new ResourceRef('audio', 'https://example.com/a', { mime: 'audio/silk' })))
      .toEqual({ fileType: 3, downgraded: false })
    expect(uploadFileType(new ResourceRef('audio', 'https://example.com/a.silk?x=1')))
      .toEqual({ fileType: 3, downgraded: false })
  })

  it('uploads any other audio as a plain file instead of transcoding', () => {
    expect(uploadFileType(new ResourceRef('audio', 'https://example.com/a.mp3', { mime: 'audio/mpeg' })))
      .toEqual({ fileType: 4, downgraded: true })
  })

  it('uploads a file as a file', () => {
    expect(uploadFileType(new ResourceRef('file', 'https://example.com/report.pdf', { name: 'report.pdf' })))
      .toEqual({ fileType: 4, downgraded: false })
  })

  it('uses the MIME type a fetch discovered when the resource carries none', () => {
    const audio = new ResourceRef('audio', 'base64:AAAA')
    expect(uploadFileType(audio)).toEqual({ fileType: 4, downgraded: true })
    expect(uploadFileType(audio, 'audio/silk; codecs=silk')).toEqual({ fileType: 3, downgraded: false })
    // The element's own hint wins over what the fetch reports.
    expect(uploadFileType(new ResourceRef('audio', 'base64:AAAA', { mime: 'audio/silk' }), 'audio/mpeg'))
      .toEqual({ fileType: 3, downgraded: false })
  })
})

describe('uploadResource', () => {
  it('lets the platform download a remote source and caches the answered key', async () => {
    const { bot, calls } = await mount()
    const ref = new ResourceRef('image', 'https://example.com/a.png', { mime: 'image/png' })
    const before = Date.now()
    const resolved = await uploadResource(bot, ref, GROUP, createPrepareContext())
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      url: 'https://api.sgroup.qq.com/v2/groups/FBB1D91204242AAB8B61A0179A6245B0/files',
      method: 'POST',
      data: { file_type: 1, url: 'https://example.com/a.png', srv_send_msg: false },
    })
    expect(resolved.key).toBe('FILE_INFO')
    expect(resolved.extra).toEqual({ fileType: 1, kind: 'image', downgraded: false })
    // `ttl: 3600` seconds is the expiry the core caches the key for.
    expect(resolved.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000)
    expect(resolved.expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000)
  })

  it('uploads a C2C key on the users route', async () => {
    const { bot, calls } = await mount()
    await uploadResource(bot, new ResourceRef('file', 'https://example.com/r.pdf'), DIRECT, createPrepareContext())
    expect(calls[0]!.url).toBe('https://api.sgroup.qq.com/v2/users/DD8246C68EC19CAF8D2AA76941180EA4/files')
  })

  it('fetches any other source and sends it as base64 file_data', async () => {
    const { bot, calls } = await mount()
    const fetched: string[] = []
    const signal = new AbortController().signal
    const ctx = createPrepareContext(async (src) => {
      fetched.push(src)
      return { data: new Uint8Array([104, 105]), mime: 'image/png' }
    })
    ctx.signal = signal
    const resolved = await uploadResource(bot, new ResourceRef('image', 'data:image/png;base64,aGk='), GROUP, ctx)
    expect(fetched).toEqual(['data:image/png;base64,aGk='])
    expect(calls[0]!.data).toEqual({ file_type: 1, file_data: 'aGk=', srv_send_msg: false })
    // The upload carries the cancellation of the prepare stage.
    expect(calls[0]!.signal).toBeDefined()
    expect(resolved.key).toBe('FILE_INFO')
  })

  it('reports a SILK-less voice upload as a file', async () => {
    const { bot, calls } = await mount()
    const resolved = await uploadResource(bot, new ResourceRef('audio', 'https://example.com/a.mp3'), GROUP, createPrepareContext())
    expect(calls[0]!.data).toMatchObject({ file_type: 4 })
    expect(resolved.extra).toEqual({ fileType: 4, kind: 'audio', downgraded: true })
  })

  it('keeps a key without an expiry when the platform answers no ttl', async () => {
    const { bot } = await mount(() => ({ body: { file_info: 'FOREVER' } }))
    const resolved = await uploadResource(bot, new ResourceRef('image', 'https://example.com/a.png'), GROUP, createPrepareContext())
    expect(resolved).toEqual({ key: 'FOREVER', extra: { fileType: 1, kind: 'image', downgraded: false } })
  })

  it('rejects a scope that is not a chat id without calling the platform', async () => {
    const { bot, calls } = await mount()
    const error = await uploadResource(bot, new ResourceRef('image', 'https://example.com/a.png'), 'oc_chat', createPrepareContext())
      .catch(error => error)
    expect(error).toBeInstanceOf(PlatformError)
    expect(error.kind).toBe('invalid')
    expect(calls).toHaveLength(0)
  })

  it('surfaces the platform failure of the upload', async () => {
    const { bot } = await mount(() => ({ status: 400, body: { code: 40054010, message: 'URL not allowed' } }))
    const error = await uploadResource(bot, new ResourceRef('image', 'https://example.com/a.png'), GROUP, createPrepareContext())
      .catch(error => error)
    expect(bot.classify(error)).toMatchObject({ kind: 'invalid', code: 40054010, published: 'no' })
  })
})
