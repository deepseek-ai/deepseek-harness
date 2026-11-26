/**
 * REST client of the QQ official bot. Every test drives a stub transport, so no request
 * leaves the process.
 */
import { describe, expect, it, vi } from 'vitest'
import { PlatformError } from '@deepseek-ai/cordis-plugin-im-core'
import {
  chatId,
  chatPath,
  chatPathOf,
  classify,
  parseChatId,
  QqApi,
  QqApiError,
  type QqHttpInit,
  type QqMessageRequest,
} from '@deepseek-ai/cordis-plugin-im-adapter-qq'

/** One answer of the stub transport. */
interface Answer {
  status?: number
  body?: unknown
  text?: string
  headers?: Record<string, string>
}

/** One request the client made. */
interface Call {
  url: string
  method: string | undefined
  data: unknown
  headers: Record<string, string> | undefined
  signal: AbortSignal | undefined
}

/** Client over a scripted transport. */
function createApi(answer: (call: Call) => Answer | Promise<Answer> = () => ({ body: { id: 'msg-1' } })) {
  const calls: Call[] = []
  const http = async (url: string, init: QqHttpInit) => {
    const call: Call = { url, method: init.method, data: init.data, headers: init.headers, signal: init.signal }
    calls.push(call)
    const result = await answer(call)
    const body = result.text ?? (result.body === undefined ? '' : JSON.stringify(result.body))
    return new Response(body || null, {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json', ...result.headers },
    })
  }
  const token = vi.fn(async () => 'access-token')
  const api = new QqApi({ http, appId: '102106848', token })
  return { api, calls, token }
}

describe('QQ chat addressing', () => {
  it('round-trips the self-describing ids of', () => {
    expect(chatId('group', 'FBB1D912')).toBe('group:FBB1D912')
    expect(chatId('user', 'DD8246C6')).toBe('user:DD8246C6')
    expect(parseChatId('group:FBB1D912')).toEqual({ kind: 'group', id: 'FBB1D912' })
    expect(parseChatId('user:DD8246C6')).toEqual({ kind: 'user', id: 'DD8246C6' })
  })

  it('rejects ids that are not group:/user:', () => {
    for (const value of ['FBB1D912', 'chat:abc', 'group:', ':abc', 'guild:123']) {
      expect(() => parseChatId(value)).toThrow(/group:<group_openid>/)
    }
  })

  it('maps an address onto the v2 collection path', () => {
    expect(chatPath({ kind: 'group', id: 'FBB1' })).toBe('/v2/groups/FBB1')
    expect(chatPath({ kind: 'user', id: 'DD82' })).toBe('/v2/users/DD82')
    expect(chatPathOf('group:FBB1')).toBe('/v2/groups/FBB1')
    expect(chatPathOf('user:DD82')).toBe('/v2/users/DD82')
  })
})

describe('QqApi', () => {
  it('reads the gateway with the application credentials of', async () => {
    const { api, calls } = createApi(() => ({ body: { url: 'wss://api.sgroup.qq.com/websocket' } }))
    await expect(api.getGateway()).resolves.toEqual({ url: 'wss://api.sgroup.qq.com/websocket' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      url: 'https://api.sgroup.qq.com/gateway',
      method: 'GET',
      headers: { Authorization: 'QQBot access-token', 'X-Union-Appid': '102106848' },
    })
  })

  it('posts a group message and returns its id', async () => {
    const { api, calls } = createApi(() => ({ body: { id: 'ROBOT1.0_abc', timestamp: '1700000000' } }))
    const body: QqMessageRequest = { msg_type: 0, content: 'hi', msg_id: 'ROBOT1.0_in', msg_seq: 2 }
    await expect(api.sendMessage({ kind: 'group', id: 'FBB1' }, body)).resolves.toEqual({
      id: 'ROBOT1.0_abc',
      timestamp: '1700000000',
    })
    expect(calls[0]).toMatchObject({ url: 'https://api.sgroup.qq.com/v2/groups/FBB1/messages', method: 'POST', data: body })
  })

  it('posts a C2C message to the users route', async () => {
    const { api, calls } = createApi()
    await api.sendMessage({ kind: 'user', id: 'DD82' }, { msg_type: 0, content: 'hi' })
    expect(calls[0]!.url).toBe('https://api.sgroup.qq.com/v2/users/DD82/messages')
  })

  it('rejects a message answer without an id, without claiming the platform published nothing', async () => {
    const { api } = createApi(() => ({ body: { timestamp: '1700000000' } }))
    const error = await api.sendMessage({ kind: 'group', id: 'G' }, { msg_type: 0 }).catch(error => error)
    expect(error).toBeInstanceOf(QqApiError)
    expect(error.message).toMatch(/without a message id/)
    expect(classify(error).published).toBe('unknown')
  })

  it('recalls a message with a DELETE on the chat route', async () => {
    const { api, calls } = createApi(() => ({ status: 200, body: undefined }))
    await api.deleteMessage({ kind: 'user', id: 'DD82' }, 'ROBOT1.0_abc')
    expect(calls[0]).toMatchObject({
      url: 'https://api.sgroup.qq.com/v2/users/DD82/messages/ROBOT1.0_abc',
      method: 'DELETE',
      data: undefined,
    })
  })

  it('uploads a file and returns its file_info', async () => {
    const { api, calls } = createApi(() => ({ body: { file_info: 'file-key', ttl: 300 } }))
    await expect(api.uploadFile({ kind: 'group', id: 'FBB1' }, {
      file_type: 1,
      url: 'https://example.com/a.png',
      srv_send_msg: false,
    })).resolves.toEqual({ file_info: 'file-key', ttl: 300 })
    expect(calls[0]).toMatchObject({ url: 'https://api.sgroup.qq.com/v2/groups/FBB1/files', method: 'POST' })
  })

  it('rejects an upload answer without file_info', async () => {
    const { api } = createApi(() => ({ body: {} }))
    await expect(api.uploadFile({ kind: 'group', id: 'FBB1' }, { file_type: 4, file_data: 'AA==', srv_send_msg: false }))
      .rejects.toThrow(/without file_info/)
  })

  it('acknowledges an interaction with code 0', async () => {
    const { api, calls } = createApi(() => ({ text: '{"code":0}' }))
    await api.acknowledgeInteraction('interaction-1')
    expect(calls[0]).toMatchObject({
      url: 'https://api.sgroup.qq.com/interactions/interaction-1',
      method: 'PUT',
      data: { code: 0 },
    })
  })

  it('streams into a C2C chat only', async () => {
    const { api, calls } = createApi(() => ({ body: { id: 'ROBOT1.0_stream', remain_msg_len: 100 } }))
    await expect(api.streamMessage({ kind: 'user', id: 'DD82' }, {
      content_type: 'markdown',
      content_raw: 'chunk',
      index: 0,
      input_state: 1,
    })).resolves.toEqual({ id: 'ROBOT1.0_stream', remain_msg_len: 100 })
    expect(calls[0]).toMatchObject({ url: 'https://api.sgroup.qq.com/v2/users/DD82/stream_messages', method: 'POST' })
    // The streaming endpoint names the text `content_raw`; a `content` key is accepted and carries no text.
    expect(calls[0]!.data).toMatchObject({ content_raw: 'chunk' })

    const group = await api.streamMessage({ kind: 'group', id: 'FBB1' }, { content_raw: 'chunk' }).catch(error => error)
    expect(group).toBeInstanceOf(PlatformError)
    expect(group.kind).toBe('fatal')
    expect(calls).toHaveLength(1)
  })

  it('turns a non-2xx answer into a QqApiError carrying code, status and body', async () => {
    const { api } = createApi(() => ({ status: 400, body: { code: 40054010, message: '不允许发送URL' } }))
    const error = await api.sendMessage({ kind: 'group', id: 'G' }, { msg_type: 0 }).catch(error => error)
    expect(error).toBeInstanceOf(QqApiError)
    expect(error.code).toBe(40054010)
    expect(error.status).toBe(400)
    expect(error.body).toEqual({ code: 40054010, message: '不允许发送URL' })
    // The platform's own code and sentence reach the operator, so a refusal the table does not list still says what
    // was refused.
    expect(error.message).toBe('POST /v2/groups/G/messages answered 400 (code 40054010: 不允许发送URL)')
  })

  it('turns a code in a 2xx body into a failure', async () => {
    const { api } = createApi(() => ({ status: 200, body: { code: 40034029, message: 'keyboard too large' } }))
    const error = await api.sendMessage({ kind: 'group', id: 'G' }, { msg_type: 2 }).catch(error => error)
    expect(error).toBeInstanceOf(QqApiError)
    expect(error.code).toBe(40034029)
    expect(error.message).toBe('POST /v2/groups/G/messages answered code 40034029: keyboard too large')
  })

  it('accepts a `code: 0` body and an answer the route does not type', async () => {
    const { api } = createApi(() => ({ status: 200, body: { code: 0 } }))
    await expect(api.request('POST', '/v2/groups/G/messages', { data: {} })).resolves.toEqual({ code: 0 })
    await expect(api.request('GET', '/gateway', { expect: 'text' })).resolves.toBe('{"code":0}')
    await expect(api.request('DELETE', '/v2/groups/G/messages/M', { expect: 'none' })).resolves.toBeUndefined()
  })

  it('keeps Retry-After of a throttled answer', async () => {
    const { api } = createApi(() => ({ status: 429, body: { code: 22009 }, headers: { 'retry-after': '3' } }))
    const error = await api.request('POST', '/v2/groups/G/messages', { data: {} }).catch(error => error)
    expect(error).toBeInstanceOf(QqApiError)
    expect((error as QqApiError).retryAfterMs).toBe(3000)
  })

  it('wraps a transport failure, keeping it as the cause', async () => {
    const failure = new Error('socket hang up')
    const http = async () => {
      throw failure
    }
    const api = new QqApi({ http, appId: 'a', token: async () => 't' })
    const error = await api.getGateway().catch(error => error)
    expect(error).toBeInstanceOf(QqApiError)
    expect(error.cause).toBe(failure)
    expect(error.status).toBeUndefined()
    expect(error.code).toBeUndefined()
  })

  it('passes the caller signal to both the token and the transport', async () => {
    const { api, calls, token } = createApi(() => ({ body: { url: 'wss://example' } }))
    const controller = new AbortController()
    await api.getGateway(controller.signal)
    expect(token).toHaveBeenCalledWith(controller.signal)
    expect(calls[0]!.signal).toBe(controller.signal)
  })

  it('resolves routes against the configured base URL', async () => {
    const calls: string[] = []
    const http = async (url: string) => {
      calls.push(url)
      return new Response('{"url":"wss://x"}', { status: 200 })
    }
    const defaults = new QqApi({ http, appId: 'a', token: async () => 't' })
    const sandbox = new QqApi({ http, appId: 'a', token: async () => 't', baseUrl: 'https://sandbox.api.sgroup.qq.com' })
    const absolute = new QqApi({ http, appId: 'a', token: async () => 't' })

    await defaults.getGateway()
    await sandbox.getGateway()
    await absolute.request('GET', 'https://api.bot.qq.com/app/getAppAccessToken')
    expect(calls).toEqual([
      'https://api.sgroup.qq.com/gateway',
      'https://sandbox.api.sgroup.qq.com/gateway',
      'https://api.bot.qq.com/app/getAppAccessToken',
    ])
    expect(defaults.baseUrl).toBe('https://api.sgroup.qq.com/')
    expect(sandbox.baseUrl).toBe('https://sandbox.api.sgroup.qq.com/')
  })

  it('lets the caller replace the Authorization scheme', async () => {
    const calls: Call[] = []
    const http = async (url: string, init: QqHttpInit) => {
      calls.push({ url, method: init.method, data: init.data, headers: init.headers, signal: init.signal })
      return new Response('{"url":"wss://x"}', { status: 200 })
    }
    const api = new QqApi({
      http,
      appId: 'a',
      token: async () => 'fixed',
      authorize: token => `Bot ${token}`,
    })
    expect(api.authorization('fixed')).toBe('Bot fixed')
    await api.getGateway()
    expect(calls[0]!.headers).toEqual({ Authorization: 'Bot fixed', 'X-Union-Appid': 'a' })
  })
})
