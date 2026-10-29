import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionHeader, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-title'
import { brandNumber, brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { apply, inject } from '../src/index.ts'
import { SESSION_MARKDOWN_EXPORT_PATH } from '../src/routes.ts'

const SESSION_ID = 'session-markdown-route' as SessionId

const HEADER: SessionHeader = {
  version: SESSION_FORMAT_VERSION,
  id: SESSION_ID,
  createdAt: 1,
  isSeeded: false,
  cwd: '/workspace',
  delegationDepth: 0,
}

const EVENTS: SessionEvent[] = [
  { type: 'turn/start', seq: brandNumber<SessionSeq>(1), time: 1, data: { turn: 1 } },
  {
    type: 'user/message',
    seq: brandNumber<SessionSeq>(2),
    time: 2,
    surfaceOp: 'append',
    data: {
      role: 'user',
      id: brandString<MessageId>('message-1'),
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Route question' }],
    },
  },
  {
    type: 'session/title',
    seq: brandNumber<SessionSeq>(3),
    time: 3,
    data: { title: 'Route title from events', messageSeqs: [brandNumber<SessionSeq>(2)], source: { kind: 'fallback' } },
  },
  {
    type: 'assistant/message',
    seq: brandNumber<SessionSeq>(4),
    time: 4,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        id: brandString<MessageId>('message-2'),
        source: { kind: 'model', provider: 'test', model: 'test' },
        content: [{ type: 'text', text: 'Route answer' }],
      },
      stream: [],
    },
  },
  { type: 'turn/end', seq: brandNumber<SessionSeq>(5), time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
]

function missingSessionError(): Error {
  return Object.assign(new Error('not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
}

function query(overrides: {
  readonly readSession?: (id: SessionId) => Promise<unknown>
} = {}): unknown {
  return {
    readSession: overrides.readSession
      ?? (async () => ({ session: HEADER, inheritedEventCount: 0, events: EVENTS })),
  }
}

async function mounted(
  sessionQuery: unknown,
  persistence?: Pick<SessionPersistence, 'stat'>,
): Promise<{
  readonly shared: ReturnType<HostConnectionService['createSharedFetchHandler']>
  readonly connection: HostConnectionService
  readonly dispose: () => Promise<void>
}> {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  ctx.provide('commands', { register: () => () => {} } as never)
  if (sessionQuery !== undefined) ctx.provide('sessionQuery', sessionQuery as never)
  if (persistence !== undefined) ctx.provide('sessionPersistence', persistence as SessionPersistence)
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber
  return {
    shared: connection.createSharedFetchHandler('/api'),
    connection,
    dispose: () => fiber.dispose(),
  }
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://host${path}`, init)
}

describe('Session Markdown Fetch route', () => {
  it('registers one GET/HEAD route and removes it with the plugin fiber', async () => {
    const { shared, connection, dispose } = await mounted(query())
    const response = await shared.fetch(
      request(`${SESSION_MARKDOWN_EXPORT_PATH}?sessionId=${SESSION_ID}`),
      connection.browserPeer,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    const markdown = await response.text()
    expect(markdown).toContain('# Route title from events')
    expect(markdown).toContain('> Route question')
    expect(markdown).toContain('Route answer')
    expect(markdown).not.toContain('Session file:')
    expect(markdown.endsWith('\n')).toBe(true)

    const head = await shared.fetch(
      request(`${SESSION_MARKDOWN_EXPORT_PATH}?sessionId=${SESSION_ID}`, { method: 'HEAD' }),
      connection.browserPeer,
    )
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(head.body).toBeNull()

    await dispose()
    expect((await shared.fetch(
      request(`${SESSION_MARKDOWN_EXPORT_PATH}?sessionId=${SESSION_ID}`),
      connection.browserPeer,
    )).status).toBe(404)
  })


  it('emits the actual selected artifact path from persistence metadata', async () => {
    const sourcePath = '/tmp/project/session.v4.jsonl'
    const stat = vi.fn(async (_id: SessionId, _options?: { readonly signal?: AbortSignal }) => ({
      header: HEADER,
      revision: SessionPersistenceRevision('test:location'),
      location: { kind: 'jsonl', path: sourcePath },
    }))
    const { shared, connection, dispose } = await mounted(query(), { stat })
    const response = await shared.fetch(
      request(`${SESSION_MARKDOWN_EXPORT_PATH}?sessionId=${SESSION_ID}`),
      connection.browserPeer,
    )
    expect(response.status).toBe(200)
    const markdown = await response.text()
    expect(markdown).toContain(`Session file:\n\n\`\`\`text\n${sourcePath}\n\`\`\``)
    const [requestedId, statOptions] = stat.mock.calls[0]!
    expect(requestedId).toBe(SESSION_ID)
    expect(statOptions?.signal).toBeInstanceOf(AbortSignal)
    await dispose()
  })

  it('omits the source block when metadata has no materialized location', async () => {
    const stat = vi.fn(async () => ({
      header: HEADER,
      revision: SessionPersistenceRevision('test:no-location'),
    }))
    const { shared, connection, dispose } = await mounted(query(), { stat })
    const response = await shared.fetch(
      request(`${SESSION_MARKDOWN_EXPORT_PATH}?sessionId=${SESSION_ID}`),
      connection.browserPeer,
    )
    expect(response.status).toBe(200)
    expect(await response.text()).not.toContain('Session file:')
    await dispose()
  })

  it('sanitizes a metadata read failure as a preparation failure', async () => {
    const stat = vi.fn(async () => {
      throw new Error('metadata failed at /private/host/session.v4.jsonl')
    })
    const { shared, connection, dispose } = await mounted(query(), { stat })
    const response = await shared.fetch(
      request(`${SESSION_MARKDOWN_EXPORT_PATH}?sessionId=${SESSION_ID}`),
      connection.browserPeer,
    )
    expect(response.status).toBe(500)
    const detail = await response.text()
    expect(detail).toBe('session markdown export failed to read the stored log')
    expect(detail).not.toContain('/private/host')
    await dispose()
  })

  it('validates the query before reporting missing Markdown services', async () => {
    const { shared, connection, dispose } = await mounted(undefined)
    expect((await shared.fetch(request(SESSION_MARKDOWN_EXPORT_PATH), connection.browserPeer)).status).toBe(400)
    expect((await shared.fetch(
      request(`${SESSION_MARKDOWN_EXPORT_PATH}?sessionId=`),
      connection.browserPeer,
    )).status).toBe(400)
    expect((await shared.fetch(
      request(`${SESSION_MARKDOWN_EXPORT_PATH}?sessionId=${SESSION_ID}`),
      connection.browserPeer,
    )).status).toBe(500)
    await dispose()
  })

  it('maps a missing Session to 404 and sanitizes every other read failure', async () => {
    const missing = await mounted(query({ readSession: async () => { throw missingSessionError() } }))
    const missingResponse = await missing.shared.fetch(
      request(`${SESSION_MARKDOWN_EXPORT_PATH}?sessionId=${SESSION_ID}`),
      missing.connection.browserPeer,
    )
    expect(missingResponse.status).toBe(404)
    expect(await missingResponse.text()).toBe('session not found')
    await missing.dispose()

    const broken = await mounted(query({
      readSession: async () => { throw new Error('failed at /private/host/session.jsonl') },
    }))
    const brokenResponse = await broken.shared.fetch(
      request(`${SESSION_MARKDOWN_EXPORT_PATH}?sessionId=${SESSION_ID}`),
      broken.connection.browserPeer,
    )
    expect(brokenResponse.status).toBe(500)
    const detail = await brokenResponse.text()
    expect(detail).toBe('session markdown export failed to read the stored log')
    expect(detail).not.toContain('/private/host')
    await broken.dispose()
  })

  it('folds the title and body from one returned snapshot without a second title read', async () => {
    const readSession = vi.fn(async () => ({ session: HEADER, inheritedEventCount: 0, events: EVENTS }))
    const readTitle = vi.fn(async () => { throw new Error('must not read a second observation') })
    const { shared, connection, dispose } = await mounted({ readSession, readTitle })
    const response = await shared.fetch(
      request(`${SESSION_MARKDOWN_EXPORT_PATH}?sessionId=${SESSION_ID}`),
      connection.browserPeer,
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('# Route title from events')
    expect(readSession).toHaveBeenCalledOnce()
    expect(readTitle).not.toHaveBeenCalled()
    await dispose()
  })
})
