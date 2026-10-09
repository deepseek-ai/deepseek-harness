import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { TimeoutReason } from '@deepseek-ai/dsh-timeout'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Translator, { TranslationError, type Config, type TranslationSpec } from '../src/index.ts'

type Reply = (req: IncomingMessage, res: ServerResponse, body: string) => void
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(reply: Reply, overrides: Partial<Config> = {}) {
  const requests: Array<{ url: URL; method: string | undefined; headers: IncomingMessage['headers']; body: string }> = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { body += chunk })
    req.on('end', () => {
      requests.push({ url: new URL(req.url!, 'http://localhost'), method: req.method, headers: req.headers, body })
      reply(req, res, body)
    })
  })
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing loopback listener')
  const base = `http://127.0.0.1:${address.port}`
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  const config = Translator.Config({ googleEndpoint: `${base}/google?client=legacy&q=stale&sl=fr&tl=ja&dt=x&fixture=retained`,
    bingEndpoint: `${base}/bing?from=fr`, ...overrides })
  const fiber = ctx.plugin(Translator, config)
  await fiber
  return { ctx, fiber, config, requests, translator: ctx.translator }
}

function json(res: ServerResponse, payload: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

const googlePayload = [[['你好', 'Hello', null, null], ['，世界。', 'world', null, null]], null, 'en']
const bingPayload = [{ translations: [{ text: '你好，世界。', to: 'zh-Hans' }] }]

describe('anonymous translator', () => {
  it('uses explicitly selected Google with automatic detection and combines translated segments', async () => {
    const { translator, requests } = await fixture((_req, res) => { json(res, googlePayload) })
    const spec = translator.resolve({ text: 'Hello world.', targetLanguage: 'zh', provider: 'google' })
    expect(spec).toEqual({ text: 'Hello world.', targetLanguage: 'zh', sourceLanguage: 'auto', provider: 'google' })
    expect(translator.maxTextChars).toBe(4000)
    expect(await translator.translate(spec)).toBe('你好，世界。')
    const request = requests[0]!
    expect(request.method).toBe('POST')
    expect(request.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(Object.fromEntries(request.url.searchParams)).toEqual({ fixture: 'retained' })
    expect(Object.fromEntries(new URLSearchParams(request.body))).toEqual({ client: 'gtx', sl: 'auto', tl: 'zh-CN', dt: 't', q: 'Hello world.' })
    expect(request.headers.cookie).toBeUndefined()
    expect(request.headers.authorization).toBeUndefined()
  })

  it('uses Bing by default and lets an explicit provider override it', async () => {
    const { translator, requests } = await fixture((req, res) => {
      json(res, req.url?.startsWith('/bing') ? bingPayload : googlePayload)
    })
    expect(translator.resolve({ text: 'hello', targetLanguage: 'zh-Hans' }).provider).toBe('bing')
    expect(await translator.translate(translator.resolve({ text: 'hello', targetLanguage: 'zh-Hans' }))).toBe('你好，世界。')
    expect(requests[0]!.url.searchParams.has('from')).toBe(false)
    expect(await translator.translate(translator.resolve({ text: 'hello', targetLanguage: 'en', sourceLanguage: 'zh-Hant' }))).toBe('你好，世界。')
    const explicit = requests[1]!
    expect(explicit.method).toBe('POST')
    expect(explicit.headers['content-type']).toBe('application/json')
    expect(JSON.parse(explicit.body)).toEqual(['hello'])
    expect(Object.fromEntries(explicit.url.searchParams)).toEqual({ from: 'zh-Hant', to: 'en', isEnterpriseClient: 'false' })
    expect(await translator.translate(translator.resolve({ text: 'hello', targetLanguage: 'zh-TW', sourceLanguage: 'en', provider: 'google' }))).toBe('你好，世界。')
    expect(new URLSearchParams(requests[2]!.body).get('tl')).toBe('zh-TW')
    expect(new URLSearchParams(requests[2]!.body).get('sl')).toBe('en')
  })

  it('maps Simplified and Traditional tags to Bing language codes', async () => {
    const { translator, requests } = await fixture((_req, res) => { json(res, bingPayload) })
    await translator.translate(translator.resolve({ text: '你好', targetLanguage: 'zh-HK', sourceLanguage: 'zh-CN', provider: 'bing' }))
    expect(Object.fromEntries(requests[0]!.url.searchParams)).toEqual({ from: 'zh-Hans', to: 'zh-Hant', isEnterpriseClient: 'false' })
  })

  it('returns empty text locally and accepts the exact UTF-16 limit', async () => {
    const { translator, requests } = await fixture((_req, res) => { json(res, googlePayload) }, { maxTextChars: 2, provider: 'google' })
    expect(await translator.translate(translator.resolve({ text: '', targetLanguage: 'zh' }))).toBe('')
    expect(requests).toHaveLength(0)
    await translator.translate(translator.resolve({ text: '😀', targetLanguage: 'zh' }))
    expect(requests).toHaveLength(1)
    expect(() => translator.resolve({ text: '😀a', targetLanguage: 'zh' })).toThrow(TranslationError)
    const oversized: TranslationSpec = { text: '😀a', targetLanguage: 'zh', sourceLanguage: 'auto', provider: 'google' }
    await expect(translator.translate(oversized)).rejects.toThrow(expect.objectContaining({ code: 'TRANSLATION_TEXT_LIMIT' }))
    expect(requests).toHaveLength(1)
  })

  it.each([400, 429, 503, 304])('reports HTTP %s without provider error content or fallback', async (status) => {
    const { translator, requests } = await fixture((_req, res) => { res.writeHead(status); res.end('private source text') })
    await expect(translator.translate(translator.resolve({ text: 'private source text', targetLanguage: 'zh', provider: 'google' })))
      .rejects.toThrow(expect.objectContaining({ code: 'TRANSLATION_HTTP_ERROR', message: `google translation failed (HTTP ${status})` }))
    expect(requests).toHaveLength(1)
  })

  it('rejects redirects without contacting the redirected endpoint', async () => {
    const { translator, requests } = await fixture((_req, res) => { res.writeHead(307, { location: '/other-provider' }); res.end() })
    await expect(translator.translate(translator.resolve({ text: 'hello', targetLanguage: 'zh' })))
      .rejects.toThrow(expect.objectContaining({ code: 'TRANSLATION_REQUEST_FAILED' }))
    expect(requests).toHaveLength(1)
  })

  it('normalizes a disconnected provider into a safe transport failure', async () => {
    const { translator } = await fixture((req) => { req.socket.destroy() })
    await expect(translator.translate(translator.resolve({ text: 'private source text', targetLanguage: 'zh', provider: 'google' })))
      .rejects.toThrow(expect.objectContaining({ code: 'TRANSLATION_REQUEST_FAILED', message: 'google translation request failed' }))
  })

  it('rejects missing bodies and invalid JSON', async () => {
    let empty = true
    const { translator } = await fixture((_req, res) => {
      if (empty) { res.writeHead(204); res.end() } else res.end('not JSON')
    })
    const spec = translator.resolve({ text: 'hello', targetLanguage: 'zh' })
    await expect(translator.translate(spec)).rejects.toThrow(expect.objectContaining({ code: 'TRANSLATION_INVALID_RESPONSE' }))
    empty = false
    await expect(translator.translate(spec)).rejects.toThrow(expect.objectContaining({ code: 'TRANSLATION_INVALID_RESPONSE' }))
  })

  it.each([null, {}, [], [null], [[]], [['not a segment']], [[[null]]]])('rejects malformed Google response %j', async (payload) => {
    const { translator } = await fixture((_req, res) => { json(res, payload) })
    await expect(translator.translate(translator.resolve({ text: 'hello', targetLanguage: 'zh', provider: 'google' })))
      .rejects.toThrow(expect.objectContaining({ code: 'TRANSLATION_INVALID_RESPONSE' }))
  })

  it.each([null, [], [1], [null], [{}], [{ translations: null }], [{ translations: [] }], [{ translations: [1] }],
    [{ translations: [null] }], [{ translations: [{}] }], [{ translations: [{ text: 1 }] }]])('rejects malformed Bing response %j', async (payload) => {
    const { translator } = await fixture((_req, res) => { json(res, payload) })
    await expect(translator.translate(translator.resolve({ text: 'hello', targetLanguage: 'zh', provider: 'bing' })))
      .rejects.toThrow(expect.objectContaining({ code: 'TRANSLATION_INVALID_RESPONSE' }))
  })

  it('enforces response-byte limits on multibyte text at and below the exact limit', async () => {
    const payload = [[['中']]]
    const bytes = Buffer.byteLength(JSON.stringify(payload))
    const exact = await fixture((_req, res) => { json(res, payload) }, { maxResponseBytes: bytes })
    expect(await exact.translator.translate(exact.translator.resolve({ text: 'hello', targetLanguage: 'zh', provider: 'google' }))).toBe('中')
    const short = await fixture((_req, res) => { json(res, payload) }, { maxResponseBytes: bytes - 1 })
    await expect(short.translator.translate(short.translator.resolve({ text: 'hello', targetLanguage: 'zh', provider: 'google' })))
      .rejects.toThrow(expect.objectContaining({ code: 'TRANSLATION_RESPONSE_LIMIT' }))
  })

  it.each([new Error('consumer stopped translation'), new TimeoutReason('TRANSLATION_TIMEOUT', 1)])(
    'preserves caller cancellation before admission and during response intake: %s', async (reason) => {
      const entered = Promise.withResolvers<undefined>()
      const { translator, requests } = await fixture((_req, res) => { res.writeHead(200); res.write('['); entered.resolve(undefined) })
      const spec = translator.resolve({ text: 'hello', targetLanguage: 'zh' })
      const already = new AbortController()
      already.abort(reason)
      await expect(translator.translate(spec, already.signal)).rejects.toBe(reason)
      expect(requests).toHaveLength(0)
      const controller = new AbortController()
      const pending = translator.translate(spec, controller.signal)
      const rejection = expect(pending).rejects.toBe(reason)
      await entered.promise
      controller.abort(reason)
      await rejection
    })

  it('applies its deadline while a provider leaves the response unfinished', async () => {
    const { translator } = await fixture((_req, res) => { res.writeHead(200); res.write('[') }, { timeoutMs: 40 })
    await expect(translator.translate(translator.resolve({ text: 'hello', targetLanguage: 'zh' })))
      .rejects.toThrow(expect.objectContaining({ name: 'TranslationError', code: 'TRANSLATION_TIMEOUT',
        message: 'bing translation timed out after 40ms' }))
  })

  it('unloads the service after aborting and joining accepted translations', async () => {
    const entered = Promise.withResolvers<undefined>()
    const { ctx, fiber, translator } = await fixture((_req, res) => { res.writeHead(200); res.write('['); entered.resolve(undefined) })
    const spec = translator.resolve({ text: 'hello', targetLanguage: 'zh' })
    const pending = translator.translate(spec)
    const rejection = expect(pending).rejects.toThrow('Translator service disposed')
    await entered.promise
    await fiber.dispose()
    await rejection
    expect(ctx.get('translator')).toBeUndefined()
    expect(() => translator.resolve({ text: 'hello', targetLanguage: 'zh' })).toThrow('Translator service disposed')
    await expect(translator.translate(spec)).rejects.toThrow('Translator service disposed')
  })

  it('validates endpoint URLs and numerical limits before activation', () => {
    expect(Translator.Config({})).toMatchObject({ provider: 'bing', maxTextChars: 4000, timeoutMs: 10000,
      googleEndpoint: 'https://translate.googleapis.com/translate_a/single',
      bingEndpoint: 'https://edge.microsoft.com/translate/translatetext' })
    for (const googleEndpoint of ['not a URL', 'ftp://provider.invalid/', 'https://user:password@provider.invalid/', 'https://provider.invalid/#fragment']) {
      expect(() => Translator.Config({ googleEndpoint })).toThrow()
    }
    for (const field of ['timeoutMs', 'maxTextChars', 'maxResponseBytes']) {
      expect(() => Translator.Config({ [field]: 0 })).toThrow()
    }
    expect(() => z.resolve({ provider: 'other' }, Translator.Config, {})).toThrow()
    expect(() => Translator.Config({ maxTextChars: 1 })).toThrow()
  })

  it('boots a real Loader composition and translates through its configured provider', async () => {
    const { config, requests } = await fixture((_req, res) => { json(res, bingPayload) })
    const root = await mkdtemp(join(tmpdir(), 'dsh-translator-composition-'))
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
    const source = await readFile(new URL('./fixtures/cordis.yml', import.meta.url), 'utf8')
    const path = join(root, 'cordis.yml')
    await writeFile(path, source.replace('TRANSLATION_ENDPOINT', config.bingEndpoint))
    const ctx = await boot('translator-composition', path, [], (host) => {
      host.loader.builtins.translator = Translator
    })
    cleanups.push(async () => { await ctx.fiber.dispose() })
    expect(ctx.translator.resolve({ text: 'Hello world.', targetLanguage: 'zh' }).provider).toBe('bing')
    expect(await ctx.translator.translate(ctx.translator.resolve({ text: 'Hello world.', targetLanguage: 'zh' }))).toBe('你好，世界。')
    expect(requests).toHaveLength(1)
    expect(requests[0]!.method).toBe('POST')
    expect(requests[0]!.url.searchParams.get('to')).toBe('zh-Hans')
    expect(JSON.parse(requests[0]!.body)).toEqual(['Hello world.'])
  })
})
