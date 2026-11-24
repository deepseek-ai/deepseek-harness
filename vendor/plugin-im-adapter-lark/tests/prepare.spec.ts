/**
 * The upload stage of the Lark adapter: `POST /im/v1/images` and `POST /im/v1/files`, the `file_type` mapping of the
 * file route, the opus/mp4 checks that turn a media element into a plain file, and the caching that makes a re-rendered
 * (streamed, edited) message upload nothing twice.
 *
 * Every request is answered by a stubbed transport: nothing touches the network.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Http from '@deepseek-ai/cordis-plugin-http'
import {
  MemoryResourceCache, PlatformError, prepare, ResourceRef, Satori, type PrepareContext, type Target,
} from '@deepseek-ai/cordis-plugin-im-core'
import LarkBot, { Config, type LarkConfig } from '@deepseek-ai/cordis-plugin-im-adapter-lark'
import {
  FILE_LIMIT_BYTES, IMAGE_LIMIT_BYTES, uploadFileType, uploadResource,
} from '../src/prepare.ts'

const group: Target = { chat: { id: 'oc_chat', type: 'group' } }

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** One request the adapter made. */
interface Call {
  path: string
  method: string
  search: string
  body: any
}

/** What the platform answers for one path. */
type Route = (call: Call) => Response | Promise<Response>

/** The two upload routes plus the token route every request needs. */
function routes(overrides: Record<string, Route> = {}): Record<string, Route> {
  return {
    '/open-apis/im/v1/images': () => Response.json({ code: 0, data: { image_key: 'img_v2_key' } }),
    '/open-apis/im/v1/files': () => Response.json({ code: 0, data: { file_key: 'file_v2_key' } }),
    ...overrides,
  }
}

/**
 * Mount the adapter on a fresh context. The bot is constructed directly (not through `ctx.plugin`), so its long
 * connection never starts and the only traffic is the upload route of the case.
 */
async function mount(overrides: Record<string, Route> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Http)
  await ctx.plugin(Satori)
  const calls: Call[] = []
  const table = routes(overrides)
  ctx.on('http/fetch', async (url: URL, init: any) => {
    const call: Call = { path: url.pathname, method: init.method ?? 'GET', search: url.search, body: init.body }
    // The tenant token is fetched once per bot and is not part of what a case asserts.
    if (call.path === '/open-apis/auth/v3/tenant_access_token/internal') {
      return Response.json({ code: 0, tenant_access_token: 't-token', expire: 7200 })
    }
    calls.push(call)
    const route = table[call.path]
    if (!route) throw new Error(`Unexpected request: ${call.method} ${call.path}`)
    return await route(call)
  })
  const config: LarkConfig = Config({ appId: 'cli_lark', appSecret: 'secret' } as LarkConfig)
  const bot = new LarkBot(ctx, config)
  return { ctx, bot, config, calls }
}

/** A `PrepareContext` whose fetch answers the given bytes without any I/O. */
function prepareContext(data = new Uint8Array([1, 2, 3]), mime?: string, name?: string): PrepareContext {
  return {
    target: group,
    signal: new AbortController().signal,
    fetch: async () => ({ data, ...mime === undefined ? {} : { mime }, ...name === undefined ? {} : { name } }),
    cache: { get: () => undefined, set: () => undefined },
  }
}

/** Await a call that must fail, and hand its classified error over. */
async function failure(promise: Promise<unknown>): Promise<PlatformError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(PlatformError)
    return error as PlatformError
  }
  throw new Error('the call was expected to fail')
}

/** The multipart body of one upload call (undici's `FormData`, so the class check is structural). */
function formOf(call: Call): FormData {
  const form = call.body as FormData
  expect(typeof form.get).toBe('function')
  return form
}

describe('uploadFileType', () => {
  it('sends an image through the image route', () => {
    expect(uploadFileType(new ResourceRef('image', 'https://example.com/a.png'))).toEqual({ route: 'image', downgraded: false })
  })

  it('uploads OPUS audio as a voice message', () => {
    expect(uploadFileType(new ResourceRef('audio', 'https://example.com/a.opus')))
      .toEqual({ route: 'file', fileType: 'opus', downgraded: false })
    expect(uploadFileType(new ResourceRef('audio', 'https://example.com/a', { name: 'Voice.OPUS' })))
      .toEqual({ route: 'file', fileType: 'opus', downgraded: false })
  })

  it('uploads any other audio as a plain file instead of transcoding', () => {
    expect(uploadFileType(new ResourceRef('audio', 'https://example.com/a.mp3', { mime: 'audio/mpeg' })))
      .toEqual({ route: 'file', fileType: 'stream', downgraded: true })
  })

  it('uploads MP4 video as a video message', () => {
    expect(uploadFileType(new ResourceRef('video', 'https://example.com/clip.mp4?x=1')))
      .toEqual({ route: 'file', fileType: 'mp4', downgraded: false })
  })

  it('uploads any other video as a plain file', () => {
    expect(uploadFileType(new ResourceRef('video', 'https://example.com/clip.webm', { mime: 'video/webm' })))
      .toEqual({ route: 'file', fileType: 'stream', downgraded: true })
  })

  it('maps the document kinds of the file route', () => {
    expect(uploadFileType(new ResourceRef('file', 'https://example.com/report.pdf')))
      .toEqual({ route: 'file', fileType: 'pdf', downgraded: false })
    expect(uploadFileType(new ResourceRef('file', 'https://example.com/report.docx')))
      .toEqual({ route: 'file', fileType: 'doc', downgraded: false })
    expect(uploadFileType(new ResourceRef('file', 'https://example.com/sheet.xlsx')))
      .toEqual({ route: 'file', fileType: 'xls', downgraded: false })
    expect(uploadFileType(new ResourceRef('file', 'https://example.com/deck.pptx')))
      .toEqual({ route: 'file', fileType: 'ppt', downgraded: false })
    expect(uploadFileType(new ResourceRef('file', 'https://example.com/archive.zip')))
      .toEqual({ route: 'file', fileType: 'stream', downgraded: false })
    expect(uploadFileType(new ResourceRef('file', 'https://example.com/a.constructor')))
      .toEqual({ route: 'file', fileType: 'stream', downgraded: false })
    expect(uploadFileType(new ResourceRef('file', 'base64:AAAA', { mime: '__proto__' })))
      .toEqual({ route: 'file', fileType: 'stream', downgraded: false })
  })

  it('uses the MIME type of the bytes when the source carries no extension', () => {
    const anonymous = new ResourceRef('file', 'base64:AAAA')
    expect(uploadFileType(anonymous)).toEqual({ route: 'file', fileType: 'stream', downgraded: false })
    expect(uploadFileType(anonymous, 'application/vnd.ms-powerpoint; charset=binary'))
      .toEqual({ route: 'file', fileType: 'ppt', downgraded: false })
    // The element's own hint wins over what the fetch reported.
    expect(uploadFileType(new ResourceRef('file', 'base64:AAAA', { mime: 'application/pdf' }), 'image/gif'))
      .toEqual({ route: 'file', fileType: 'pdf', downgraded: false })
  })

  it('never decides opus/mp4 from the MIME type alone (the mode read the extension)', () => {
    // The mode published this audio as a `file` message, so its key must not be an `opus` one.
    expect(uploadFileType(new ResourceRef('audio', 'base64:AAAA'), 'audio/opus'))
      .toEqual({ route: 'file', fileType: 'stream', downgraded: true })
    expect(uploadFileType(new ResourceRef('video', 'base64:AAAA'), 'video/mp4'))
      .toEqual({ route: 'file', fileType: 'stream', downgraded: true })
  })
})

describe('upload: image route', () => {
  it('uploads one image and reports the key', async () => {
    const { bot, calls } = await mount()
    const result = await bot.upload(
      new ResourceRef('image', 'https://example.com/a.png', { name: 'a.png' }),
      'cli_lark',
      prepareContext(new Uint8Array([1, 2, 3]), 'image/png'),
    )
    expect(result.key).toBe('img_v2_key')
    expect(result.extra).toEqual({ route: 'image', kind: 'image', downgraded: false })
    // A key belongs to the application and has no expiry the platform documents.
    expect(result.expiresAt).toBeUndefined()
    const call = calls.find(entry => entry.path === '/open-apis/im/v1/images')!
    expect(call.method).toBe('POST')
    const form = formOf(call)
    expect(form.get('image_type')).toBe('message')
    const file = form.get('image') as File
    expect(file.name).toBe('a.png')
    expect(file.type).toBe('image/png')
    expect(calls.some(entry => entry.path === '/open-apis/im/v1/files')).toBe(false)
  })

  it('names an unnamed image after its bytes', async () => {
    const { bot, calls } = await mount()
    await bot.upload(new ResourceRef('image', 'base64:AAAA'), 'cli_lark', prepareContext(new Uint8Array([9]), 'image/jpeg'))
    const call = calls.find(entry => entry.path === '/open-apis/im/v1/images')!
    expect((formOf(call).get('image') as File).name).toBe('image.jpg')
  })

  it('falls back to a generic image name when nothing is known', async () => {
    const { bot, calls } = await mount()
    await bot.upload(new ResourceRef('image', 'base64:AAAA'), 'cli_lark', prepareContext(new Uint8Array([9])))
    const call = calls.find(entry => entry.path === '/open-apis/im/v1/images')!
    expect((formOf(call).get('image') as File).name).toBe('image.png')
  })
})

describe('upload: file route', () => {
  it('uploads a document with the file_type of its kind', async () => {
    const { bot, calls } = await mount()
    const result = await bot.upload(
      new ResourceRef('file', 'https://example.com/report.pdf', { name: 'report.pdf' }),
      'cli_lark',
      prepareContext(new Uint8Array([1, 2]), 'application/pdf'),
    )
    expect(result.key).toBe('file_v2_key')
    expect(result.extra).toEqual({ route: 'file', kind: 'file', fileType: 'pdf', downgraded: false })
    const form = formOf(calls.find(entry => entry.path === '/open-apis/im/v1/files')!)
    expect(form.get('file_type')).toBe('pdf')
    expect(form.get('file_name')).toBe('report.pdf')
    expect(form.get('duration')).toBeNull()
    expect((form.get('file') as File).name).toBe('report.pdf')
  })

  it('uploads OPUS audio with its duration', async () => {
    const { bot, calls } = await mount()
    const result = await bot.upload(
      new ResourceRef('audio', 'https://example.com/a.opus', { name: 'a.opus', duration: 4200 }),
      'cli_lark',
      prepareContext(new Uint8Array([1]), 'audio/opus'),
    )
    expect(result.extra).toEqual({ route: 'file', kind: 'audio', fileType: 'opus', downgraded: false })
    const form = formOf(calls.find(entry => entry.path === '/open-apis/im/v1/files')!)
    expect(form.get('file_type')).toBe('opus')
    expect(form.get('duration')).toBe('4200')
  })

  it('uploads an audio the platform cannot play as a plain named file', async () => {
    const { bot, calls } = await mount()
    const result = await bot.upload(
      new ResourceRef('audio', 'https://example.com/a.mp3', { name: 'a.mp3' }),
      'cli_lark',
      prepareContext(new Uint8Array([1]), 'audio/mpeg'),
    )
    expect(result.extra).toEqual({ route: 'file', kind: 'audio', fileType: 'stream', downgraded: true })
    expect(formOf(calls.find(entry => entry.path === '/open-apis/im/v1/files')!).get('file_type')).toBe('stream')
  })
})

describe('upload: limits and failures', () => {
  it('refuses an image the image route cannot take, before any request', async () => {
    const { bot, calls } = await mount()
    const error = await failure(bot.upload(
      new ResourceRef('image', 'https://example.com/a.png'),
      'cli_lark',
      prepareContext(new Uint8Array(IMAGE_LIMIT_BYTES + 1)),
    ))
    expect(error.kind).toBe('limit')
    expect(error.published).toBe('no')
    expect(calls).toHaveLength(0)
  })

  it('refuses a file the file route cannot take', async () => {
    const { bot, calls } = await mount()
    const error = await failure(bot.upload(
      new ResourceRef('file', 'https://example.com/a.zip'),
      'cli_lark',
      prepareContext(new Uint8Array(FILE_LIMIT_BYTES + 1)),
    ))
    expect(error.kind).toBe('limit')
    expect(calls).toHaveLength(0)
  })

  it('refuses a resource without bytes', async () => {
    const { bot, calls } = await mount()
    const error = await failure(bot.upload(
      new ResourceRef('image', 'https://example.com/a.png'),
      'cli_lark',
      prepareContext(new Uint8Array(0)),
    ))
    expect(error.kind).toBe('invalid')
    expect(calls).toHaveLength(0)
  })

  it('surfaces a platform failure of an upload', async () => {
    const { bot } = await mount({
      '/open-apis/im/v1/images': () => Response.json({ code: 234006, msg: 'invalid image' }, { status: 400 }),
    })
    // The client's own error reaches the caller; `errors.ts` classifies it when a send reports it.
    await expect(bot.upload(new ResourceRef('image', 'https://example.com/a.png'), 'cli_lark', prepareContext()))
      .rejects.toThrow(/answered 400/)
  })

  it('honours a cancelled prepare context', async () => {
    const { bot, calls } = await mount()
    const controller = new AbortController()
    controller.abort()
    const ctx: PrepareContext = {
      target: group,
      signal: controller.signal,
      fetch: async () => ({ data: new Uint8Array([1]) }),
      cache: { get: () => undefined, set: () => undefined },
    }
    await expect(uploadResource(bot, new ResourceRef('image', 'https://example.com/a.png'), 'cli_lark', ctx)).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})

describe('upload: core cache reuse', () => {
  it('uploads one resource once across two prepares', async () => {
    const { bot, calls } = await mount()
    const ref = new ResourceRef('image', 'https://example.com/a.png', { name: 'a.png' })
    const draft = { kind: 'post', paragraphs: [{ kind: 'image', ref, path: 'message/p[0]/img[0]' }] }
    const cache = new MemoryResourceCache()
    const fetch = async () => ({ data: new Uint8Array([1, 2, 3]), mime: 'image/png' })
    const first = await prepare([draft], { adapter: bot, target: group, cache, fetch })
    const second = await prepare([draft], { adapter: bot, target: group, cache, fetch })
    expect(first[0]!.resolved.get(ref)?.key).toBe('img_v2_key')
    expect(second[0]!.resolved.get(ref)?.key).toBe('img_v2_key')
    expect(calls.filter(entry => entry.path === '/open-apis/im/v1/images')).toHaveLength(1)
  })

  it('separates the two routes for one source rendered as two kinds', async () => {
    const { bot, calls } = await mount()
    const image = new ResourceRef('image', 'https://example.com/a.png')
    const file = new ResourceRef('file', 'https://example.com/a.png')
    const draft = { kind: 'post', paragraphs: [{ kind: 'image', ref: image }, { kind: 'media', msgType: 'file', ref: file }] }
    const cache = new MemoryResourceCache()
    const fetch = async () => ({ data: new Uint8Array([1]) })
    const [prepared] = await prepare([draft], { adapter: bot, target: group, cache, fetch })
    expect(prepared!.resolved.get(image)?.key).toBe('img_v2_key')
    expect(prepared!.resolved.get(file)?.key).toBe('file_v2_key')
    expect(calls.map(entry => entry.path).sort()).toEqual(['/open-apis/im/v1/files', '/open-apis/im/v1/images'])
  })
})
