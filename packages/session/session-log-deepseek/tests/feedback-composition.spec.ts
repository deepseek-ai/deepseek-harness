import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import MessageFeedback from '@deepseek-ai/dsh-message-feedback'
import { recordFeedback } from '@deepseek-ai/dsh-command-feedback'
import LlmRuntime, { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import DeepSeekLlmApiExtensions from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import * as SessionLogDeepSeek from '../src/index.ts'
import type { DeepSeekSessionLogExtension } from '../src/types.ts'

let root: string | undefined
let ctx: Context | undefined
let server: MockLlmServer | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  await server?.close()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  ctx = undefined
  server = undefined
  root = undefined
  vi.unstubAllEnvs()
})

it('uploads freeform feedback and message put/edit/delete through the unchanged provider route', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-feedback-upload-'))
  vi.stubEnv('DSH_HOME', root)
  vi.stubEnv('DEEPSEEK_API_KEY', 'feedback-test-key')
  server = await startMockLlmServer({ sequence: ['invalid_request', 'success', 'success'] })
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
    ['@deepseek-ai/dsh-message-feedback', MessageFeedback],
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-llm-deepseek', LlmDeepSeek],
    ['@deepseek-ai/dsh-deepseek-llm-api-extensions', DeepSeekLlmApiExtensions],
    ['@deepseek-ai/dsh-session-log-deepseek', SessionLogDeepSeek],
  ])
  const config = join(root, 'cordis.yml')
  await writeFile(config, JSON.stringify([...modules.keys()].map(name => ({
    name,
    ...name === '@deepseek-ai/dsh-session-persistence-jsonl'
      ? { config: { root: join(root!, 'sessions'), compression: 'none' } }
      : name === '@deepseek-ai/dsh-message-feedback'
        ? { config: { maxNoteBytes: 1024 } }
        : name === '@deepseek-ai/dsh-llm-deepseek'
          ? { config: { baseURL: server!.baseURL } }
          : name === '@deepseek-ai/dsh-session-log-deepseek'
            ? { config: { enabled: true } }
            : {},
  }))))
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])

  const session = ctx.sessions.create(SessionId('feedback-upload'))
  const handle = await ctx.sessionPersistence.create(session.header)
  try {
    const user = createUserMessage({ content: [{ type: 'text', text: 'Question' }], source: { kind: 'user' } })
    const assistant = createAssistantMessage({ content: [{ type: 'text', text: 'Answer' }], source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })
    session.append('user/message', user, { surfaceOp: 'append' })
    session.append('assistant/message', { message: assistant, stream: [], turn: 1, step: 1 }, { surfaceOp: 'append' })
    const messages = session.deriveMessages()
    recordFeedback(session, '  The session needs a clearer explanation.  ')
    const created = await ctx.messageFeedback.put({ sessionId: session.id, messageId: assistant.id, rating: 'negative', note: 'Explain the result.', ifVersion: null })
    if (!created.ok) throw new Error(created.error.code)
    const initialPrefix = session.snapshotEvents()
    const request = async () => {
      const chunks = []
      for await (const chunk of ctx!.llm.stream({ provider: 'deepseek-official', model: 'deepseek-v4-flash', sessionId: session.id, messages: session.deriveMessages() })) chunks.push(chunk)
      return chunks.at(-1)
    }
    expect(await request()).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    expect(SessionLogDeepSeek.acceptedThrough(session)).toBe(-1)
    expect(await request()).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    const first = (server.requests[0]!.body as { dsh_session_log: DeepSeekSessionLogExtension }).dsh_session_log
    const retry = (server.requests[1]!.body as { dsh_session_log: DeepSeekSessionLogExtension }).dsh_session_log
    expect(retry).toEqual(first)
    expect(first.events).toEqual(initialPrefix)
    expect(first.events.slice(-2)).toMatchObject([
      { type: 'feedback/record', data: { text: 'The session needs a clearer explanation.' } },
      { type: 'feedback/message-put', data: { sessionId: session.id, item: created.value } },
    ])
    expect(SessionLogDeepSeek.acceptedThrough(session)).toBe(first.throughSeq)

    const edited = await ctx.messageFeedback.put({
      sessionId: session.id, messageId: assistant.id, rating: 'positive',
      note: 'The explanation is clear now.', ifVersion: created.value.version,
    })
    if (!edited.ok) throw new Error(edited.error.code)
    expect(await ctx.messageFeedback.delete({
      sessionId: session.id, messageId: assistant.id, ifVersion: edited.value.version,
    })).toEqual({ ok: true, value: { absent: true } })
    expect(await request()).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    const suffix = (server.requests[2]!.body as { dsh_session_log: DeepSeekSessionLogExtension }).dsh_session_log
    expect(suffix.afterSeq).toBe(first.throughSeq)
    expect(suffix.events).toMatchObject([
      { type: 'session-log-deepseek/delivery-accepted' },
      { type: 'feedback/message-put', data: { sessionId: session.id, item: edited.value } },
      { type: 'feedback/message-delete', data: { sessionId: session.id, messageId: assistant.id } },
    ])
    expect(suffix.events.every(event => event.seq > first.throughSeq)).toBe(true)
    expect(SessionLogDeepSeek.acceptedThrough(session)).toBe(suffix.throughSeq)
    expect(session.deriveMessages()).toEqual(messages)
    expect(await ctx.messageFeedback.list({ sessionId: session.id })).toEqual({ ok: true, value: { items: [] } })
    for (const wire of server.requests) {
      expect(wire.path).toBe('/chat/completions')
      expect(wire.body).not.toHaveProperty('dsh_feedback')
      expect(wire.body).toMatchObject({ model: 'deepseek-v4-flash', messages: [
        { role: 'user', content: 'Question' },
        { role: 'assistant', content: 'Answer' },
      ] })
    }
    await ctx.sessions.flush(session)
    expect((await handle.read()).events).toEqual(session.snapshotEvents())
  } finally {
    await handle.close()
  }
})
