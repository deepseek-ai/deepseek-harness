import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { h, normalize, type Element, type UserRef } from '@deepseek-ai/cordis-plugin-im-core'
import { ImChatKey, ImMessageKey, ImSourceId, type ImChat, type ImConfig, type ImMessage } from '../src/api.ts'
import { ImError } from '../src/error.ts'
import type { HostResolver } from '../src/media-source.ts'
import {
  ImMediaStore, mediaKindOf, mediaLabel, mediaRefs, parseMediaId, sniffImageMediaType, type ImMediaItem, type ImMediaRef,
} from '../src/media.ts'

const CHAT: ImChat = {
  key: ImChatKey('lark:cli_a', 'oc_1'),
  bot: 'lark:cli_a',
  ref: { id: 'oc_1', type: 'group', name: '群' },
  source: ImSourceId('main'),
}

const sender = (name: string, self = false): UserRef & { self: boolean } =>
  ({ id: `u_${name}`, name, self })

function message(content: Element<'message'>, seq = 12, chat: ImChat = CHAT): ImMessage {
  return {
    key: ImMessageKey(chat.bot, `m_${seq}`),
    seq,
    chat,
    sender: sender('张三'),
    content,
    text: '',
    mentions: { self: false, all: false, users: [] },
    addressed: false,
    time: Date.UTC(2026, 9, 25, 6, 7),
    via: 'platform',
  }
}

const media = (...children: Element[]) => normalize(h('message', ...children))

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02])
const GIF_BYTES = new TextEncoder().encode('GIF89a-rest')
const TEXT_BYTES = new TextEncoder().encode('plain text')

interface FakeHttp {
  get(url: string, init: { signal?: AbortSignal; redirect?: RequestRedirect; timeout?: number }): Promise<unknown>
}

interface FakeStore {
  saveImages(inputs: readonly { data: Uint8Array; mediaType: string; name?: string }[]): Promise<unknown[]>
  saveFile(input: { data: Uint8Array; name?: string }): Promise<unknown>
}

function fakeContext(services: { http?: FakeHttp; attachments?: FakeStore; im?: unknown }): Context {
  return { get: (name: string) => (services as Record<string, unknown>)[name] } as Context
}

/** `ctx.http` stand-in: serves `bytes` for every URL and reports `mime`. */
function httpServing(bytes: Uint8Array, mime = 'image/png'): FakeHttp {
  return {
    get: async () => ({
      headers: { get: () => mime },
      arrayBuffer: async () => bytes.slice().buffer,
    }),
  }
}

/** `ctx.attachments` stand-in: one durable reference per image and per file. */
function attachmentsSaving(): FakeStore & {
  saved: { data: Uint8Array; mediaType: string; name?: string }[]
  files: { data: Uint8Array; name?: string }[]
} {
  const saved: { data: Uint8Array; mediaType: string; name?: string }[] = []
  const files: { data: Uint8Array; name?: string }[] = []
  return {
    saved,
    files,
    saveImages: async (inputs) => {
      saved.push(...inputs)
      return inputs.map((input, index) => ({
        attachmentId: `att_${index}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 1,
        height: 1,
        ...input.name ? { name: input.name } : {},
      }))
    },
    saveFile: async (input) => {
      files.push(input)
      return {
        attachmentId: `sha256:${files.length}`,
        name: input.name ?? 'file',
        bytes: input.data.byteLength,
      }
    },
  }
}

/** A `saveFile` a scenario never reaches: it only fills the double's shape. */
async function unusedFileStore(): Promise<unknown> {
  throw new Error('this scenario stores no file')
}

function config(overrides: Partial<ImConfig['media']> = {}): ImConfig {
  return {
    sources: [],
    retentionMs: 3600000,
    maxRecords: 100,
    maxInputBytes: 262144,
    retryIntervalMs: 5000, platformTimeoutMs: 30000, compositionWarnMs: 30000,
    media: { download: true, maxBytes: 1048576, maxItems: 9, timeoutMs: 30000, source: { file: false, internal: false }, ...overrides },
    send: { maxMediaBytes: 1048576, operationTimeoutMs: 30000 },
    tools: { readOnly: false, maxReadBytes: 65536, maxHistoryItems: 50, maxMembers: 200, maxMemberPages: 10, fileDir: '.dsh/im' },
  }
}

/** Every host in these scenarios resolves to one public address, so no scenario reaches a name resolver. */
const PUBLIC_HOSTS: HostResolver = async () => ['93.184.216.34']

/** A media store whose host lookups never leave the test. */
function mediaStore(ctx: Context, configuration: ImConfig): ImMediaStore {
  return new ImMediaStore(ctx, configuration, { resolveHost: PUBLIC_HOSTS })
}

describe('mediaRefs', () => {
  it('collects every media element in content order', () => {
    const content = media(
      h('p', '看这张 ', h('img', { src: 'https://cdn/1.png', alt: '猫' })),
      h('p', h('img', { src: 'https://cdn/2.png' })),
      h('file', { src: 'https://cdn/report.pdf', name: 'report.pdf' }),
      h('audio', { src: 'https://cdn/voice.opus', name: '语音.opus' }),
      h('video', { src: 'https://cdn/clip.mp4', name: 'clip.mp4' }),
    )
    expect(mediaRefs(message(content))).toEqual([
      { message: 'lark:cli_a|m_12', chat: 'lark:cli_a|oc_1', seq: 12, index: 1, kind: 'image', src: 'https://cdn/1.png', name: '猫' },
      { message: 'lark:cli_a|m_12', chat: 'lark:cli_a|oc_1', seq: 12, index: 2, kind: 'image', src: 'https://cdn/2.png' },
      { message: 'lark:cli_a|m_12', chat: 'lark:cli_a|oc_1', seq: 12, index: 3, kind: 'file', src: 'https://cdn/report.pdf', name: 'report.pdf' },
      { message: 'lark:cli_a|m_12', chat: 'lark:cli_a|oc_1', seq: 12, index: 4, kind: 'audio', src: 'https://cdn/voice.opus', name: '语音.opus' },
      { message: 'lark:cli_a|m_12', chat: 'lark:cli_a|oc_1', seq: 12, index: 5, kind: 'video', src: 'https://cdn/clip.mp4', name: 'clip.mp4' },
    ])
  })

  it('finds media nested in containers', () => {
    const content = media(h('blockquote', h('ul', h('li', h('img', { src: 'https://cdn/deep.png' })))))
    expect(mediaRefs(message(content, 3)).map(ref => [ref.index, ref.kind, ref.src, ref.name]))
      .toEqual([[1, 'image', 'https://cdn/deep.png', undefined]])
  })

  it('tolerates an unnormalized media element without src or name', () => {
    const raw = h('message', h('file', { src: '', name: '   ' }), h('img', {} as { src: string }))
    expect(mediaRefs(message(raw)).map(ref => [ref.kind, ref.src, ref.name]))
      .toEqual([['file', '', undefined], ['image', '', undefined]])
  })

  it('returns nothing for a message without media', () => {
    expect(mediaRefs(message(media(h('p', 'hi'))))).toEqual([])
  })

  it('classifies media and non-media elements', () => {
    expect(mediaKindOf(h('img', { src: 's' }))).toBe('image')
    expect(mediaKindOf(h('video', { src: 's' }))).toBe('video')
    expect(mediaKindOf(h('p', 'x'))).toBeUndefined()
  })
})

describe('mediaLabel', () => {
  const ref = (kind: ImMediaRef['kind'], name?: string, seq = 12, index = 1): ImMediaRef =>
    ({ message: 'b|m' as never, chat: 'b|c' as never, seq, index, kind, src: 's', ...name ? { name } : {} })

  it('labels every kind by its stable id', () => {
    expect(mediaLabel(ref('image'))).toBe('[图片 #12.1]')
    expect(mediaLabel(ref('file', 'report.pdf', 12, 2))).toBe('[文件 #12.2 report.pdf]')
    expect(mediaLabel(ref('audio', '语音.opus'))).toBe('[语音 #12.1 语音.opus]')
    expect(mediaLabel(ref('video', 'clip.mp4', 7, 3))).toBe('[视频 #7.3 clip.mp4]')
  })

  it('collapses whitespace and bounds a long name', () => {
    expect(mediaLabel(ref('file', 'a\n b\t c '))).toBe('[文件 #12.1 a b c]')
    expect(mediaLabel(ref('file', '   '))).toBe('[文件 #12.1]')
    expect(mediaLabel(ref('file', 'x'.repeat(50)))).toBe(`[文件 #12.1 ${'x'.repeat(39)}…]`)
    expect(mediaLabel(ref('file', '😀'.repeat(41)))).toBe(`[文件 #12.1 ${'😀'.repeat(39)}…]`)
  })
})

describe('parseMediaId', () => {
  it('accepts every documented spelling', () => {
    expect(parseMediaId('#12.1')).toEqual({ seq: 12, index: 1 })
    expect(parseMediaId('12.1')).toEqual({ seq: 12, index: 1 })
    expect(parseMediaId(' 12.1 ')).toEqual({ seq: 12, index: 1 })
    expect(parseMediaId('#12')).toEqual({ seq: 12, index: 1 })
    expect(parseMediaId('12.0')).toBeUndefined()
    expect(parseMediaId('12.1.2')).toBeUndefined()
    expect(parseMediaId('img-12')).toBeUndefined()
    expect(parseMediaId('#')).toBeUndefined()
    expect(parseMediaId('')).toBeUndefined()
  })
})

describe('sniffImageMediaType', () => {
  it('recognizes the accepted raster formats from their bytes', () => {
    expect(sniffImageMediaType(PNG_BYTES)).toBe('image/png')
    expect(sniffImageMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageMediaType(GIF_BYTES)).toBe('image/gif')
    expect(sniffImageMediaType(new TextEncoder().encode('GIF87a-rest'))).toBe('image/gif')
    expect(sniffImageMediaType(new TextEncoder().encode('RIFF0000WEBPVP8 '))).toBe('image/webp')
    expect(sniffImageMediaType(new TextEncoder().encode('RIFF0000AVI '))).toBeUndefined()
    expect(sniffImageMediaType(TEXT_BYTES)).toBeUndefined()
    expect(sniffImageMediaType(new Uint8Array([0x89, 0x50]))).toBeUndefined()
  })
})

describe('ImMediaStore.admit', () => {
  const imageRef = (index = 1, src = 'https://cdn/1.png', name?: string): ImMediaRef =>
    ({ message: 'b|m' as never, chat: CHAT.key, seq: 12, index, kind: 'image', src, ...name ? { name } : {} })
  const fileRef = (index = 2, src = 'https://cdn/report.pdf', name?: string): ImMediaRef =>
    ({ message: 'b|m' as never, chat: CHAT.key, seq: 12, index, kind: 'file', src, ...name ? { name } : {} })

  it('admits an image through http into a durable attachment', async () => {
    const attachments = attachmentsSaving()
    const store = mediaStore(fakeContext({ http: httpServing(PNG_BYTES), attachments }), config())
    const [item] = await store.admit([imageRef(1, 'https://cdn/1.png', '猫.png')])
    expect(item).toEqual({
      ref: imageRef(1, 'https://cdn/1.png', '猫.png'),
      image: { type: 'image', attachment: { attachmentId: 'att_0', mediaType: 'image/png', bytes: 11, width: 1, height: 1, name: '猫.png' } },
      mime: 'image/png',
      bytes: 11,
    })
    expect(attachments.saved).toEqual([{ data: PNG_BYTES, mediaType: 'image/png', name: '猫.png' }])
  })

  it('admits an inline data: source without the http service', async () => {
    const attachments = attachmentsSaving()
    const store = mediaStore(fakeContext({ attachments }), config())
    const base64 = Buffer.from(PNG_BYTES).toString('base64')
    const [item] = await store.admit([imageRef(1, `data:image/png;base64,${base64}`)])
    expect(item?.image?.attachment).toMatchObject({ mediaType: 'image/png', bytes: 11 })
  })

  it('skips everything when downloading is disabled', async () => {
    const store = mediaStore(fakeContext({}), config({ download: false }))
    expect(await store.admit([imageRef()])).toEqual([{ ref: imageRef(), skipped: 'disabled' }])
  })

  it('admits a satori: resource only under the route of the bot that serves the chat', async () => {
    const im = { bot: () => ({ platform: 'lark', selfId: 'ou_bot' }) }
    const store = mediaStore(fakeContext({ http: httpServing(PNG_BYTES), attachments: attachmentsSaving(), im }), config())
    const satoriOwn = imageRef(1, 'satori:lark/ou_bot/messages/om_1/resources/img_1?type=image')
    const [own, other] = await store.admit([
      satoriOwn,
      imageRef(2, 'satori:lark/ou_other/messages/om_1/resources/img_1?type=image'),
    ])
    expect(own?.image?.attachment).toMatchObject({ mediaType: 'image/png' })
    expect(other?.skipped).toContain('not a resource of the bot that received')

    const withoutIm = mediaStore(fakeContext({ http: httpServing(PNG_BYTES), attachments: attachmentsSaving() }), config())
    expect((await withoutIm.admit([satoriOwn]))[0]?.skipped).toContain('not a resource of the bot that received')

    const unmounted = mediaStore(fakeContext({
      http: httpServing(PNG_BYTES),
      attachments: attachmentsSaving(),
      im: { bot: () => { throw new ImError('unavailable', 'no bot') } },
    }), config())
    expect((await unmounted.admit([satoriOwn]))[0]?.skipped).toContain('not a resource of the bot that received')

    const faulty = mediaStore(fakeContext({
      http: httpServing(PNG_BYTES),
      attachments: attachmentsSaving(),
      im: { bot: () => { throw new TypeError('broken lookup') } },
    }), config())
    expect((await faulty.admit([satoriOwn]))[0]?.skipped).toBe('broken lookup')
  })

  it('skips a source a received message may not make this host fetch', async () => {
    // The chat member writes the message, so the src is their choice: a path of this host and an internal address are
    // reported as skipped instead of being fetched into the transcript.
    const store = mediaStore(fakeContext({ http: httpServing(PNG_BYTES), attachments: attachmentsSaving() }), config())
    const [path, internal] = await store.admit([
      imageRef(1, 'file:///home/u/.ssh/id_rsa'),
      imageRef(2, 'http://169.254.169.254/latest/meta-data/'),
    ])
    expect(path).toMatchObject({ ref: imageRef(1, 'file:///home/u/.ssh/id_rsa') })
    expect(path?.skipped).toContain('media.source.file')
    expect(internal).toMatchObject({ ref: imageRef(2, 'http://169.254.169.254/latest/meta-data/') })
    expect(internal?.skipped).toContain('media.source.internal')
  })

  it('admits a non-image element as a durable verbatim file', async () => {
    const attachments = attachmentsSaving()
    const store = mediaStore(
      fakeContext({ http: httpServing(TEXT_BYTES, 'application/pdf'), attachments }),
      config(),
    )
    const [item] = await store.admit([fileRef(2, 'https://cdn/report.pdf', 'report.pdf')])
    expect(item).toEqual({
      ref: fileRef(2, 'https://cdn/report.pdf', 'report.pdf'),
      file: { type: 'file', attachment: { attachmentId: 'sha256:1', name: 'report.pdf', bytes: 10 } },
      mime: 'application/pdf',
      bytes: 10,
      data: TEXT_BYTES,
    })
    expect(attachments.files).toEqual([{ data: TEXT_BYTES, name: 'report.pdf' }])
    expect(attachments.saved).toEqual([])
  })

  it('keeps an unnamed or mime-less file under the store defaults', async () => {
    const attachments = attachmentsSaving()
    const withoutMime: FakeHttp = {
      get: async () => ({ headers: { get: () => null }, arrayBuffer: async () => TEXT_BYTES.slice().buffer }),
    }
    const store = mediaStore(fakeContext({ http: withoutMime, attachments }), config())
    const [item] = await store.admit([fileRef(1, 'https://cdn/voice.opus')])
    expect(item).toEqual({
      ref: fileRef(1, 'https://cdn/voice.opus'),
      file: { type: 'file', attachment: { attachmentId: 'sha256:1', name: 'file', bytes: 10 } },
      bytes: 10,
      data: TEXT_BYTES,
    })
    expect(attachments.files).toEqual([{ data: TEXT_BYTES }])
  })

  it('enforces the item bound across kinds', async () => {
    const attachments = attachmentsSaving()
    const store = mediaStore(fakeContext({ http: httpServing(PNG_BYTES), attachments }), config({ maxItems: 1 }))
    const refs: ImMediaRef[] = [imageRef(1), { ...imageRef(2), kind: 'file' }, imageRef(3)]
    const items = await store.admit(refs)
    expect(items.map(item => item.image ? 'image' : item.file ? 'file' : item.skipped)).toEqual(['image', 'limit', 'limit'])
  })

  it('skips an oversized download', async () => {
    const store = mediaStore(
      fakeContext({ http: httpServing(PNG_BYTES), attachments: attachmentsSaving() }),
      config({ maxBytes: 4 }),
    )
    expect(await store.admit([imageRef()])).toEqual([{ ref: imageRef(), bytes: 11, skipped: 'too-large' }])

    const declaredOversized: FakeHttp = {
      get: async () => ({
        headers: { get: (name: string) => (name === 'content-length' ? '999999' : 'image/png') },
        arrayBuffer: async () => PNG_BYTES.slice().buffer,
      }),
    }
    const abortedEarly = mediaStore(
      fakeContext({ http: declaredOversized, attachments: attachmentsSaving() }),
      config({ maxBytes: 4 }),
    )
    expect(await abortedEarly.admit([imageRef()])).toEqual([{ ref: imageRef(), skipped: 'too-large' }])
  })

  it('skips an oversized file and one the attachment service cannot keep', async () => {
    const oversized = mediaStore(
      fakeContext({ http: httpServing(TEXT_BYTES, 'application/pdf'), attachments: attachmentsSaving() }),
      config({ maxBytes: 4 }),
    )
    expect(await oversized.admit([fileRef()])).toEqual([{ ref: fileRef(), bytes: 10, skipped: 'too-large' }])
    const missing = mediaStore(fakeContext({ http: httpServing(TEXT_BYTES, 'application/pdf') }), config())
    expect(await missing.admit([fileRef()]))
      .toEqual([{ ref: fileRef(), mime: 'application/pdf', bytes: 10, skipped: 'unavailable' }])
    const withoutMime: FakeHttp = {
      get: async () => ({ headers: { get: () => null }, arrayBuffer: async () => TEXT_BYTES.slice().buffer }),
    }
    const bareMissing = mediaStore(fakeContext({ http: withoutMime }), config())
    expect(await bareMissing.admit([fileRef()])).toEqual([{ ref: fileRef(), bytes: 10, skipped: 'unavailable' }])
    const failing = mediaStore(fakeContext({
      http: httpServing(TEXT_BYTES, 'application/pdf'),
      attachments: {
        saveImages: async () => [],
        saveFile: async () => { throw new Error('the disk is full') },
      },
    }), config())
    expect(await failing.admit([fileRef()])).toEqual([{ ref: fileRef(), skipped: 'the disk is full' }])
  })

  it('skips bytes that are not an accepted raster format', async () => {
    const store = mediaStore(fakeContext({ http: httpServing(TEXT_BYTES, 'text/plain') }), config())
    expect(await store.admit([imageRef()]))
      .toEqual([{ ref: imageRef(), mime: 'text/plain', bytes: 10, skipped: 'unsupported' }])
    const withoutMime: FakeHttp = {
      get: async () => ({ headers: { get: () => null }, arrayBuffer: async () => TEXT_BYTES.slice().buffer }),
    }
    const bare = mediaStore(fakeContext({ http: withoutMime }), config())
    expect(await bare.admit([imageRef()])).toEqual([{ ref: imageRef(), bytes: 10, skipped: 'unsupported' }])
  })

  it('skips when the attachment service is missing or returns nothing', async () => {
    const missing = mediaStore(fakeContext({ http: httpServing(PNG_BYTES) }), config())
    expect(await missing.admit([imageRef()]))
      .toEqual([{ ref: imageRef(), mime: 'image/png', bytes: 11, skipped: 'unavailable' }])
    const empty = mediaStore(
      fakeContext({
        http: httpServing(PNG_BYTES),
        attachments: { saveImages: async () => [], saveFile: unusedFileStore },
      }),
      config(),
    )
    expect(await empty.admit([imageRef()]))
      .toEqual([{ ref: imageRef(), mime: 'image/png', bytes: 11, skipped: 'persistence' }])
  })

  it('reports a download or admission failure as the skipped reason', async () => {
    const failing = mediaStore(fakeContext({
      http: { get: async () => { throw new Error('403 forbidden') } },
    }), config())
    expect(await failing.admit([imageRef()])).toEqual([{ ref: imageRef(), skipped: '403 forbidden' }])
    const throwing = mediaStore(fakeContext({
      http: httpServing(PNG_BYTES),
      attachments: { saveImages: async () => { throw new ImError('capacity', 'too many pixels') }, saveFile: unusedFileStore },
    }), config())
    expect(await throwing.admit([imageRef()])).toEqual([{ ref: imageRef(), skipped: 'too many pixels' }])
    const odd = mediaStore(fakeContext({
      http: { get: async () => { throw 'no route' } },
    }), config())
    expect(await odd.admit([imageRef()])).toEqual([{ ref: imageRef(), skipped: 'no route' }])
  })

  it('stops on a caller abort', async () => {
    const store = mediaStore(fakeContext({ http: httpServing(PNG_BYTES), attachments: attachmentsSaving() }), config())
    const aborted = AbortSignal.abort(new Error('turn ended'))
    await expect(store.admit([imageRef()], aborted)).rejects.toThrow('turn ended')
    const reasonless = { aborted: true, reason: undefined } as AbortSignal
    await expect(store.admit([imageRef()], reasonless)).rejects.toThrow('aborted')
  })

  it('rethrows the failure of an interrupted download', async () => {
    const controller = new AbortController()
    const store = mediaStore(fakeContext({
      http: {
        get: async () => {
          controller.abort(new Error('cancelled'))
          throw new Error('fetch aborted')
        },
      },
    }), config())
    await expect(store.admit([imageRef()], controller.signal)).rejects.toThrow('fetch aborted')
  })
})

const imageMessage = (seq: number): ImMessage =>
  message(media(h('p', '图：', h('img', { src: 'https://cdn/1.png' }))), seq)
const mixedMessage = (seq: number): ImMessage =>
  message(media(h('p', h('img', { src: 'https://cdn/1.png' }), h('file', { src: 'https://cdn/r.pdf' }))), seq)
const fileMessage = (seq: number): ImMessage =>
  message(media(h('p', '看报告 ', h('file', { src: 'https://cdn/r.pdf', name: 'r.pdf' }))), seq)

/** A store over one fixed history, with the doubles a read scenario needs. */
function storeWith(
  messages: readonly ImMessage[],
  options: { http?: FakeHttp; attachments?: FakeStore; media?: Partial<ImConfig['media']> } = {},
): ImMediaStore {
  const history = {
    after: (chat: string, seq: number, limit: number) =>
      messages.filter(message => message.chat.key === chat && message.seq > seq).slice(0, limit),
    before: () => [],
    get: () => undefined,
    latest: () => undefined,
  }
  return mediaStore(
    fakeContext({ http: httpServing(PNG_BYTES), attachments: attachmentsSaving(), im: { history }, ...options }),
    config(options.media),
  )
}

describe('ImMediaStore.read', () => {
  it('resolves the media element by its stable id', async () => {
    const item: ImMediaItem = await storeWith([imageMessage(12)]).read(CHAT.key, '#12.1')
    expect(item.ref).toMatchObject({ seq: 12, index: 1, kind: 'image' })
    expect(item.image?.attachment).toMatchObject({ mediaType: 'image/png' })
  })

  it('rejects an unknown id, message, element or missing im service', async () => {
    await expect(storeWith([imageMessage(12)]).read(CHAT.key, 'nope')).rejects.toThrow(ImError)
    await expect(storeWith([imageMessage(12)]).read(CHAT.key, '13.1')).rejects.toThrow('no stored message #13')
    await expect(storeWith([imageMessage(12)]).read(CHAT.key, '12.2')).rejects.toThrow('no media element #2')
    await expect(storeWith([imageMessage(12)]).read(ImChatKey('b', 'other'), '12.1'))
      .rejects.toThrow('no stored message')
    const noIm = mediaStore(fakeContext({}), config())
    await expect(noIm.read(CHAT.key, '12.1')).rejects.toThrow('im service is not available')
  })

  it('refuses a non-image element and a disabled download', async () => {
    expect(await storeWith([mixedMessage(12)]).read(CHAT.key, '12.2')).toMatchObject({ skipped: 'unsupported' })
    expect(await storeWith([imageMessage(12)], { media: { download: false } }).read(CHAT.key, '12.1'))
      .toMatchObject({ skipped: 'disabled' })
  })

  it('passes the caller signal into the download', async () => {
    const abortAware: FakeHttp = {
      get: async (_src, init) => {
        if (init.signal?.aborted) throw init.signal.reason ?? new Error('aborted')
        return { headers: { get: () => 'image/png' }, arrayBuffer: async () => PNG_BYTES.slice().buffer }
      },
    }
    await expect(storeWith([imageMessage(12)], { http: abortAware }).read(CHAT.key, '12.1', AbortSignal.abort(new Error('gone'))))
      .rejects.toThrow('gone')
  })

  it('asks the transport to reach the admitted URL only', async () => {
    const asked: { redirect?: RequestRedirect | undefined }[] = []
    const recording: FakeHttp = {
      get: async (_src, init) => {
        asked.push({ redirect: init.redirect })
        return { headers: { get: () => 'image/png' }, arrayBuffer: async () => PNG_BYTES.slice().buffer }
      },
    }
    await storeWith([imageMessage(12)], { http: recording }).read(CHAT.key, '12.1')
    // Without `redirect: 'error'` the transport follows a 302 to any host, which is the address the admission refused.
    expect(asked).toEqual([{ redirect: 'error' }])
  })

  it('skips a picture whose body is still dripping at media.timeoutMs, with no caller signal at all', async () => {
    // The headers arrive at once and the body never ends: `ctx.http` clears its own timer at the headers, so only the
    // fetch deadline ends this. The automatic delivery path passes no signal, which is the case this pins.
    const dripping: FakeHttp = {
      get: async () => ({
        headers: { get: () => null },
        body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1)) } }),
        arrayBuffer: async () => new Promise<ArrayBuffer>(() => {}),
      }),
    }
    const item = await storeWith([imageMessage(12)], { http: dripping, media: { timeoutMs: 30 } }).read(CHAT.key, '12.1')
    expect(item.skipped).toContain('did not arrive within 30 ms')
  })

  it('reads the entries of a merged forward before resolving its picture', async () => {
    // The store holds the forward as a bare reference; the picture only exists in what the platform read returns.
    const bare = message(media(h('forward', { id: 'm_7' })), 7)
    const expanded = message(media(h('forward', { id: 'm_7' }, h('img', { src: 'https://cdn/9.png' }))), 7)
    const history = {
      after: (chat: string, seq: number, limit: number) =>
        [bare].filter(entry => entry.chat.key === chat && entry.seq > seq).slice(0, limit),
      before: () => [],
      get: () => undefined,
      latest: () => undefined,
    }
    const store = mediaStore(
      fakeContext({
        http: httpServing(PNG_BYTES),
        attachments: attachmentsSaving(),
        im: { history, readMessage: async () => expanded },
      }),
      config(),
    )
    expect(await store.read(CHAT.key, '7.1')).toMatchObject({ ref: { seq: 7, index: 1, src: 'https://cdn/9.png' } })
  })

  it('forwards the caller AbortSignal to forward expansion readMessage when the platform read hangs', async () => {
    const bare = message(media(h('forward', { id: 'm_8' })), 8)
    const history = {
      after: (chat: string, seq: number, limit: number) =>
        [bare].filter(entry => entry.chat.key === chat && entry.seq > seq).slice(0, limit),
      before: () => [],
      get: () => undefined,
      latest: () => undefined,
    }
    const controller = new AbortController()
    let seenSignal: AbortSignal | undefined
    const store = mediaStore(
      fakeContext({
        http: httpServing(PNG_BYTES),
        attachments: attachmentsSaving(),
        im: {
          history,
          readMessage: (_chat: string, _id: string, signal?: AbortSignal) => {
            seenSignal = signal
            return new Promise<ImMessage>((_resolve, reject) => {
              signal?.addEventListener('abort', () => {
                reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
              }, { once: true })
            })
          },
        },
      }),
      config(),
    )
    const pending = store.read(CHAT.key, '8.1', controller.signal)
    controller.abort(new Error('cancelled by user'))
    await expect(pending).rejects.toThrow('cancelled by user')
    expect(seenSignal).toBe(controller.signal)
  })

  it('settles immediately when aborted while the DNS admission lookup is hanging', async () => {
    const controller = new AbortController()
    const target = fileMessage(8)
    const history = {
      after: (chat: string, seq: number, limit: number) =>
        [target].filter(entry => entry.chat.key === chat && entry.seq > seq).slice(0, limit),
      before: () => [],
      get: () => undefined,
      latest: () => undefined,
    }
    const ctx = fakeContext({ im: { history } })
    const store = new ImMediaStore(ctx, config({ timeoutMs: 30_000 }), {
      resolveHost: () => new Promise(() => {}),
    })
    const pending = store.readFile(CHAT.key, '8.1', controller.signal)
    controller.abort(new Error('cancelled during dns'))
    await expect(pending).rejects.toThrow('cancelled during dns')
  })
})

describe('ImMediaStore.readFile', () => {
  const http = (): FakeHttp => httpServing(TEXT_BYTES, 'application/pdf')

  it('admits the file of one label and hands back its bytes', async () => {
    const attachments = attachmentsSaving()
    const item = await storeWith([fileMessage(12)], { http: http(), attachments }).readFile(CHAT.key, '12.1')
    expect(item.ref).toMatchObject({ seq: 12, index: 1, kind: 'file' })
    expect(item.file?.attachment).toEqual({ attachmentId: 'sha256:1', name: 'r.pdf', bytes: 10 })
    expect(item.data).toEqual(TEXT_BYTES)
    expect(attachments.files).toEqual([{ data: TEXT_BYTES, name: 'r.pdf' }])
  })

  it('reports a file the store could not keep', async () => {
    const oversized = await storeWith([fileMessage(12)], { http: http(), media: { maxBytes: 4 } })
      .readFile(CHAT.key, '12.1')
    expect(oversized.file).toBeUndefined()
    expect(oversized.data).toBeUndefined()
    expect(oversized.skipped).toBe('too-large')
  })

  it('keeps the original bytes of an image label as a file', async () => {
    const attachments = attachmentsSaving()
    const item = await storeWith([imageMessage(12)], { attachments }).readFile(CHAT.key, '12.1')
    expect(item.file?.attachment).toMatchObject({ name: 'file', bytes: PNG_BYTES.byteLength })
    expect(item.data).toEqual(PNG_BYTES)
    expect(attachments.files).toEqual([{ data: PNG_BYTES }])
    expect(attachments.saved).toEqual([])
  })

  it('reports a disabled download instead of storing anything', async () => {
    const attachments = attachmentsSaving()
    const item = await storeWith([fileMessage(12)], { attachments, media: { download: false } })
      .readFile(CHAT.key, '12.1')
    expect(item.ref.kind).toBe('file')
    expect(item.file).toBeUndefined()
    expect(item.data).toBeUndefined()
    expect(item.skipped).toBe('disabled')
    expect(attachments.files).toEqual([])
  })

  it('refuses media whose owning message fails the caller allow predicate', async () => {
    const store = storeWith([fileMessage(12)], { http: http(), attachments: attachmentsSaving() })
    await expect(store.read(CHAT.key, '12.1', undefined, () => false)).rejects.toMatchObject({ code: 'access' })
    await expect(store.readFile(CHAT.key, '12.1', undefined, () => false)).rejects.toMatchObject({ code: 'access' })
  })
})
