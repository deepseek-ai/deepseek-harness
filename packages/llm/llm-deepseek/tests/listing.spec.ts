/** `/models` decoding and the listing request lifecycle. */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { APP_IDENTITY } from '@deepseek-ai/dsh-llm'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { LISTING_TIMEOUT, MAX_BADGE_TEXT_LENGTH, parseModelListing, requestModelListing } from '../src/listing.ts'
import type { ListedCapabilities } from '../src/listing.ts'

/** The listing the service returned to an account token on 2026-09-24. */
const LISTING = {
  object: 'list',
  data: [
    {
      id: 'deepseek-flash', object: 'model', owned_by: 'deepseek', name: 'DeepSeek-V4.1-Flash',
      context_window: 1_048_576, max_output_tokens: 393_216, input_modalities: ['text', 'image'], output_modalities: ['text'],
      effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
      api_capabilities: { anthropic_messages: { system_prompt_update: 'in-history' } },
    },
    {
      id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek', name: 'DeepSeek-V4-Pro',
      context_window: 1_048_576, max_output_tokens: 393_216, input_modalities: ['text'], output_modalities: ['text'],
      effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
      api_capabilities: { anthropic_messages: { system_prompt_update: 'leading-only' } },
    },
  ],
}
const MESSAGES = { api_capabilities: { anthropic_messages: {} } }
const only = (row: object) => parseModelListing({ data: [{ id: 'm', ...row }] }).entries[0]

describe('parseModelListing', () => {
  it('decodes the service listing', () => {
    expect(parseModelListing(LISTING)).toEqual({
      skipped: 0,
      entries: [
        {
          id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', requirement: { kind: 'none' },
          capabilities: { usable: true, facts: {
            inputModalities: ['text', 'image'], contextWindow: 1_048_576, maxOutputTokens: 393_216, systemPromptUpdate: 'in-history',
          } },
        },
        {
          id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', requirement: { kind: 'none' },
          capabilities: { usable: true, facts: {
            inputModalities: ['text'], contextWindow: 1_048_576, maxOutputTokens: 393_216, systemPromptUpdate: 'leading-only',
          } },
        },
      ],
    })
  })

  it('skips rows without a usable id and repeated ids', () => {
    const listing = parseModelListing({ data: [null, 1, { id: '' }, { id: 'a', name: '' }, { id: 'a' }] })
    expect(listing.skipped).toBe(4)
    expect(listing.entries).toEqual([{ id: 'a', requirement: { kind: 'none' }, capabilities: expect.objectContaining({ usable: false }) as ListedCapabilities }])
  })

  it.each([{}, [], null, { data: {} }, { data: [] }, { data: [{ id: '' }] }])('rejects %j as a listing', (body) => {
    expect(() => parseModelListing(body)).toThrow(/DeepSeek model listing/)
  })

  it.each([
    [undefined, { kind: 'none' }],
    [{ other: { min_version: '9.0.0' } }, { kind: 'none' }],
    [{ [APP_IDENTITY.product]: {} }, { kind: 'none' }],
    [{ [APP_IDENTITY.product]: { min_version: '0.2.0-alpha.1' } }, { kind: 'min-version', version: '0.2.0-alpha.1' }],
    ['0.2.0', { kind: 'invalid' }],
    [{ [APP_IDENTITY.product]: '0.2.0' }, { kind: 'invalid' }],
    [{ [APP_IDENTITY.product]: { min_version: 2 } }, { kind: 'invalid' }],
    [{ [APP_IDENTITY.product]: { min_version: '' } }, { kind: 'invalid' }],
  ])('reads client requirements %j', (requirements, expected) => {
    expect(only({ ...MESSAGES, ...requirements === undefined ? {} : { client_requirements: requirements } })?.requirement).toEqual(expected)
  })

  it.each([
    [{}, 'declares no api_capabilities.anthropic_messages'],
    [{ api_capabilities: { anthropic_messages: 'yes' } }, 'declares no api_capabilities.anthropic_messages'],
    [{ ...MESSAGES, output_modalities: ['image'] }, 'declares no text output'],
    [{ ...MESSAGES, output_modalities: 'text' }, 'declares no text output'],
    [{ ...MESSAGES, input_modalities: ['audio'] }, 'declares no input modality DeepSeek Harness supports'],
    [{ ...MESSAGES, input_modalities: 'text' }, 'declares no input modality DeepSeek Harness supports'],
    [{ ...MESSAGES, context_window: 0 }, 'declares an invalid context_window or max_output_tokens'],
    [{ ...MESSAGES, max_output_tokens: 1.5 }, 'declares an invalid context_window or max_output_tokens'],
  ])('marks %j unusable', (row, reason) => {
    expect(only(row)?.capabilities).toEqual({ usable: false, reason })
  })

  it('narrows modalities to this build\'s vocabulary and reads an unknown system prompt mode as leading-only', () => {
    expect(only({
      input_modalities: ['text', 'audio', 'text'],
      api_capabilities: { anthropic_messages: { system_prompt_update: 'future-mode' } },
    })?.capabilities).toEqual({ usable: true, facts: { inputModalities: ['text'], systemPromptUpdate: 'leading-only' } })
    expect(only(MESSAGES)?.capabilities).toEqual({ usable: true, facts: { inputModalities: ['text'] } })
  })

  it.each([
    ['addition-only', 'addition-only'],
    ['in-history', 'in-history'],
    ['leading-only', 'leading-only'],
    ['future-mode', 'leading-only'],
    [false, 'leading-only'],
    [1, 'leading-only'],
  ])('reads tool_update %j as %s', (declared, toolUpdate) => {
    expect(only({ api_capabilities: { anthropic_messages: { tool_update: declared } } })?.capabilities)
      .toEqual({ usable: true, facts: { inputModalities: ['text'], toolUpdate } })
  })

  it('reads a null protocol mode as undeclared', () => {
    expect(only({ api_capabilities: { anthropic_messages: { system_prompt_update: null, tool_update: null } } })?.capabilities)
      .toEqual({ usable: true, facts: { inputModalities: ['text'] } })
  })

  const OWN = `client_metadata["${APP_IDENTITY.product}"]`
  const showing = (badge: unknown) => ({ ...MESSAGES, client_metadata: { [APP_IDENTITY.product]: { badge } } })
  const longest = '十'.repeat(MAX_BADGE_TEXT_LENGTH)
  it.each([
    [{ text: '1017', tone: 'info' }, { text: '1017', tone: 'info' }],
    [{ text: '  1017 ', tone: 'success' }, { text: '1017', tone: 'success' }],
    [{ text: longest, tone: 'warning' }, { text: longest, tone: 'warning' }],
    [{ text: '👍🏽'.repeat(MAX_BADGE_TEXT_LENGTH) }, { text: '👍🏽'.repeat(MAX_BADGE_TEXT_LENGTH), tone: 'neutral' }],
    [{ text: '👨‍👩‍👧'.repeat(MAX_BADGE_TEXT_LENGTH) }, { text: '👨‍👩‍👧'.repeat(MAX_BADGE_TEXT_LENGTH), tone: 'neutral' }],
    [{ text: 'Beta' }, { text: 'Beta', tone: 'neutral' }],
    [{ text: 'Beta', tone: null }, { text: 'Beta', tone: 'neutral' }],
    [{ text: 'Beta', tone: 'accent' }, { text: 'Beta', tone: 'neutral' }],
    [{ text: 'Beta', tone: 1 }, { text: 'Beta', tone: 'neutral' }],
    [{ text: { en: 'New', zh: '新', 'zh-hant': ' 新 ' }, tone: 'info' }, { text: { en: 'New', zh: '新', 'zh-hant': '新' }, tone: 'info' }],
  ])('decodes badge %j', (badge, expected) => {
    expect(only(showing(badge))?.badge).toEqual({ kind: 'badge', badge: expected })
  })

  it.each([
    undefined,
    null,
    {},
    { other: { badge: { text: '1017' } } },
    { [APP_IDENTITY.product]: null },
    { [APP_IDENTITY.product]: { other_field: 1 } },
    { [APP_IDENTITY.product]: { badge: null } },
  ])('declares no badge for client_metadata %j', (metadata) => {
    expect(only({ ...MESSAGES, client_metadata: metadata })).not.toHaveProperty('badge')
  })

  it('reads badges only from client_metadata', () => {
    const badge = { text: '1017' }
    expect(only({ ...MESSAGES, badge, client_requirements: { [APP_IDENTITY.product]: { badge } } })).not.toHaveProperty('badge')
  })

  it.each([
    ['1017', 'client_metadata is not an object'],
    [['1017'], 'client_metadata is not an object'],
    [{ [APP_IDENTITY.product]: '1017' }, `${OWN} is not an object`],
    [{ [APP_IDENTITY.product]: [] }, `${OWN} is not an object`],
    [{ [APP_IDENTITY.product]: { badge: '1017' } }, `${OWN}.badge is not an object`],
    [{ [APP_IDENTITY.product]: { badge: ['1017'] } }, `${OWN}.badge is not an object`],
  ])('rejects client_metadata %j without hiding the entry', (metadata, reason) => {
    const entry = only({ ...MESSAGES, client_metadata: metadata })
    expect(entry?.badge).toEqual({ kind: 'invalid', reason })
    expect(entry?.capabilities.usable).toBe(true)
  })

  const unreadableText = expect.stringContaining(`${OWN}.badge.text is not a string or an object of lowercase language ids`) as string
  it.each([
    { tone: 'info' },
    { text: null },
    { text: '   ' },
    { text: `${longest}十` },
    { text: 'line\nbreak' },
    { text: '\nNew' },
    { text: 'New\u2028Model' },
    { text: 'New\u2029Model' },
    { text: 'New\u202e' },
    { text: '\u2066New\u2069' },
    { text: '\u200b' },
    { text: '\u200d' },
    { text: '\ufe0f' },
    { text: ' \u00ad\u200b ' },
    { text: 7 },
    { text: { zh: '新' } },
    { text: { en: 'New', ZH: '新' } },
    { text: { en: 'New', zh: '' } },
    { text: { en: 'New', zh: '\u200b' } },
    { text: { en: 1 } },
  ])('rejects badge %j without hiding the entry', (badge) => {
    const entry = only(showing(badge))
    expect(entry?.badge).toEqual({ kind: 'invalid', reason: unreadableText })
    expect(entry?.capabilities.usable).toBe(true)
  })

  it('rejects an own "__proto__" translation key', () => {
    const body: unknown = JSON.parse(
      `{"data":[{"id":"m","client_metadata":{"${APP_IDENTITY.product}":{"badge":{"text":{"en":"New","__proto__":"x"}}}}}]}`,
    )
    expect(parseModelListing(body).entries[0]?.badge).toEqual({ kind: 'invalid', reason: unreadableText })
  })
})

describe('requestModelListing', () => {
  const servers: Server[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  })

  async function listen(reply: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
    const server = createServer(reply)
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    return `http://127.0.0.1:${address.port}/models`
  }

  it('sends attribution, accept, and the given authentication headers', async () => {
    let headers: IncomingMessage['headers'] = {}
    const url = await listen((request, response) => {
      headers = request.headers
      response.end(JSON.stringify(LISTING))
    })
    const listing = await requestModelListing(url, { 'x-dsh-auth-token': 'fixture-token' }, AbortSignal.timeout(5_000))
    expect(listing.entries.map(entry => entry.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    expect(headers).toMatchObject({
      'accept': 'application/json',
      'x-dsh-auth-token': 'fixture-token',
      'user-agent': expect.stringContaining(`${APP_IDENTITY.product}/${APP_IDENTITY.version}`) as string,
    })
  })

  it.each([
    [401, 'Authentication Fails (governor)', 'HTTP_401'],
    [200, '<html>', 'INVALID_RESPONSE'],
    [200, JSON.stringify({ data: [] }), 'INVALID_RESPONSE'],
  ])('classifies HTTP %d with body %s', async (status, body, code) => {
    const url = await listen((_request, response) => { response.writeHead(status).end(body) })
    await expect(requestModelListing(url, {}, AbortSignal.timeout(5_000))).rejects.toMatchObject({ code })
  })

  it('refuses redirects', async () => {
    const url = await listen((_request, response) => { response.writeHead(302, { location: 'http://127.0.0.1:1/models' }).end() })
    await expect(requestModelListing(url, {}, AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'TRANSPORT' })
  })

  it('reports an unreachable endpoint as a transport failure', async () => {
    const url = await listen(() => { /* closed before any request */ })
    await new Promise(resolve => servers.pop()?.close(resolve))
    await expect(requestModelListing(url, {}, AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'TRANSPORT' })
  })

  it('reports the listing deadline as a timeout and another abort as an aborted request', async () => {
    const url = await listen(() => { /* never answers */ })
    using limit = deadline(undefined, 20, LISTING_TIMEOUT)
    await expect(requestModelListing(url, {}, limit.signal)).rejects.toMatchObject({
      code: 'TIMEOUT', message: `DeepSeek model listing request to ${url} timed out after 20 ms`,
    })
    const caller = new AbortController()
    const pending = requestModelListing(url, {}, caller.signal)
    caller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
  })
})
