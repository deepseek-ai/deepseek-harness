import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { h, normalize, type Element, type UserRef } from '@deepseek-ai/cordis-plugin-im-core'
import { ImChatKey, ImMessageKey, ImSourceId, type ImChat, type ImConfig, type ImMessage } from '../src/api.ts'
import { ImError } from '../src/error.ts'
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
  get(url: string, init: { signal?: AbortSignal }): Promise<unknown>
}

interface FakeStore {
  saveImages(inputs: readonly { data: Uint8Array; mediaType: string; name?: string }[]): Promise<unknown[]>
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

/** `ctx.attachments` stand-in: one durable reference per image. */
function attachmentsSaving(): FakeStore & { saved: { data: Uint8Array; mediaType: string; name?: string }[] } {
  const saved: { data: Uint8Array; mediaType: string; name?: string }[] = []
  return {
    saved,
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
  }
}

function config(overrides: Partial<ImConfig['media']> = {}): ImConfig {
  return {
    sources: [],
    retentionMs: 3600000,
    maxRecords: 100,
    maxInputBytes: 262144,
    retryIntervalMs: 5000,
    media: { download: true, maxBytes: 1048576, maxItems: 9, ...overrides },
    send: { maxBytes: 30000, maxMediaBytes: 1048576, operationTimeoutMs: 30000 },
    tools: { readOnly: false, maxReadBytes: 65536, maxHistoryItems: 50 },
  }
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

  it('admits an image through http into a durable attachment', async () => {
    const attachments = attachmentsSaving()
    const store = new ImMediaStore(fakeContext({ http: httpServing(PNG_BYTES), attachments }), config())
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
    const store = new ImMediaStore(fakeContext({ attachments }), config())
    const base64 = Buffer.from(PNG_BYTES).toString('base64')
    const [item] = await store.admit([imageRef(1, `data:image/png;base64,${base64}`)])
    expect(item?.image?.attachment).toMatchObject({ mediaType: 'image/png', bytes: 11 })
  })

  it('skips everything when downloading is disabled', async () => {
    const store = new ImMediaStore(fakeContext({}), config({ download: false }))
    expect(await store.admit([imageRef()])).toEqual([{ ref: imageRef(), skipped: 'disabled' }])
  })

  it('skips non-image media and enforces the item bound', async () => {
    const attachments = attachmentsSaving()
    const store = new ImMediaStore(fakeContext({ http: httpServing(PNG_BYTES), attachments }), config({ maxItems: 1 }))
    const refs: ImMediaRef[] = [
      imageRef(1),
      { ...imageRef(2), kind: 'file' },
      imageRef(3),
    ]
    const items = await store.admit(refs)
    expect(items.map(item => item.image ? 'image' : item.skipped)).toEqual(['image', 'unsupported', 'limit'])
  })

  it('skips an oversized download', async () => {
    const store = new ImMediaStore(
      fakeContext({ http: httpServing(PNG_BYTES), attachments: attachmentsSaving() }),
      config({ maxBytes: 4 }),
    )
    expect(await store.admit([imageRef()])).toEqual([{ ref: imageRef(), bytes: 11, skipped: 'too-large' }])
  })

  it('skips bytes that are not an accepted raster format', async () => {
    const store = new ImMediaStore(fakeContext({ http: httpServing(TEXT_BYTES, 'text/plain') }), config())
    expect(await store.admit([imageRef()]))
      .toEqual([{ ref: imageRef(), mime: 'text/plain', bytes: 10, skipped: 'unsupported' }])
    const withoutMime: FakeHttp = {
      get: async () => ({ headers: { get: () => null }, arrayBuffer: async () => TEXT_BYTES.slice().buffer }),
    }
    const bare = new ImMediaStore(fakeContext({ http: withoutMime }), config())
    expect(await bare.admit([imageRef()])).toEqual([{ ref: imageRef(), bytes: 10, skipped: 'unsupported' }])
  })

  it('skips when the attachment service is missing or returns nothing', async () => {
    const missing = new ImMediaStore(fakeContext({ http: httpServing(PNG_BYTES) }), config())
    expect(await missing.admit([imageRef()]))
      .toEqual([{ ref: imageRef(), mime: 'image/png', bytes: 11, skipped: 'unavailable' }])
    const empty = new ImMediaStore(
      fakeContext({ http: httpServing(PNG_BYTES), attachments: { saveImages: async () => [] } }),
      config(),
    )
    expect(await empty.admit([imageRef()]))
      .toEqual([{ ref: imageRef(), mime: 'image/png', bytes: 11, skipped: 'persistence' }])
  })

  it('reports a download or admission failure as the skipped reason', async () => {
    const failing = new ImMediaStore(fakeContext({
      http: { get: async () => { throw new Error('403 forbidden') } },
    }), config())
    expect(await failing.admit([imageRef()])).toEqual([{ ref: imageRef(), skipped: '403 forbidden' }])
    const throwing = new ImMediaStore(fakeContext({
      http: httpServing(PNG_BYTES),
      attachments: { saveImages: async () => { throw new ImError('capacity', 'too many pixels') } },
    }), config())
    expect(await throwing.admit([imageRef()])).toEqual([{ ref: imageRef(), skipped: 'too many pixels' }])
    const odd = new ImMediaStore(fakeContext({
      http: { get: async () => { throw 'no route' } },
    }), config())
    expect(await odd.admit([imageRef()])).toEqual([{ ref: imageRef(), skipped: 'no route' }])
  })

  it('stops on a caller abort', async () => {
    const store = new ImMediaStore(fakeContext({ http: httpServing(PNG_BYTES), attachments: attachmentsSaving() }), config())
    const aborted = AbortSignal.abort(new Error('turn ended'))
    await expect(store.admit([imageRef()], aborted)).rejects.toThrow('turn ended')
    const reasonless = { aborted: true, reason: undefined } as AbortSignal
    await expect(store.admit([imageRef()], reasonless)).rejects.toThrow('aborted')
  })

  it('rethrows the failure of an interrupted download', async () => {
    const controller = new AbortController()
    const store = new ImMediaStore(fakeContext({
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

describe('ImMediaStore.read', () => {
  const mediaMessage = (seq: number): ImMessage =>
    message(media(h('p', '图：', h('img', { src: 'https://cdn/1.png' }))), seq)
  const mixedMessage = (seq: number): ImMessage =>
    message(media(h('p', h('img', { src: 'https://cdn/1.png' }), h('file', { src: 'https://cdn/r.pdf' }))), seq)

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
    return new ImMediaStore(
      fakeContext({ http: httpServing(PNG_BYTES), attachments: attachmentsSaving(), im: { history }, ...options }),
      config(options.media),
    )
  }

  it('resolves the media element by its stable id', async () => {
    const item: ImMediaItem = await storeWith([mediaMessage(12)]).read(CHAT.key, '#12.1')
    expect(item.ref).toMatchObject({ seq: 12, index: 1, kind: 'image' })
    expect(item.image?.attachment).toMatchObject({ mediaType: 'image/png' })
  })

  it('rejects an unknown id, message, element or missing im service', async () => {
    await expect(storeWith([mediaMessage(12)]).read(CHAT.key, 'nope')).rejects.toThrow(ImError)
    await expect(storeWith([mediaMessage(12)]).read(CHAT.key, '13.1')).rejects.toThrow('no stored message #13')
    await expect(storeWith([mediaMessage(12)]).read(CHAT.key, '12.2')).rejects.toThrow('no media element #2')
    await expect(storeWith([mediaMessage(12)]).read(ImChatKey('b', 'other'), '12.1'))
      .rejects.toThrow('no stored message')
    const noIm = new ImMediaStore(fakeContext({}), config())
    await expect(noIm.read(CHAT.key, '12.1')).rejects.toThrow('im service is not available')
  })

  it('refuses a non-image element and a disabled download', async () => {
    expect(await storeWith([mixedMessage(12)]).read(CHAT.key, '12.2')).toMatchObject({ skipped: 'unsupported' })
    expect(await storeWith([mediaMessage(12)], { media: { download: false } }).read(CHAT.key, '12.1'))
      .toMatchObject({ skipped: 'disabled' })
  })

  it('passes the caller signal into the download', async () => {
    const abortAware: FakeHttp = {
      get: async (_src, init) => {
        if (init.signal?.aborted) throw init.signal.reason ?? new Error('aborted')
        return { headers: { get: () => 'image/png' }, arrayBuffer: async () => PNG_BYTES.slice().buffer }
      },
    }
    await expect(storeWith([mediaMessage(12)], { http: abortAware }).read(CHAT.key, '12.1', AbortSignal.abort(new Error('gone'))))
      .rejects.toThrow('gone')
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
    const store = new ImMediaStore(
      fakeContext({
        http: httpServing(PNG_BYTES),
        attachments: attachmentsSaving(),
        im: { history, readMessage: async () => expanded },
      }),
      config(),
    )
    expect(await store.read(CHAT.key, '7.1')).toMatchObject({ ref: { seq: 7, index: 1, src: 'https://cdn/9.png' } })
  })
})
