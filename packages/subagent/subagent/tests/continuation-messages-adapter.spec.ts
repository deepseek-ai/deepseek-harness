import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { end, MODEL, server, sse, start } from '../../../llm/llm-deepseek/tests/messages/helpers.ts'
import SubagentRuntime, { type SubagentRunEndInfo } from '../src/index.ts'
import { loadStoredSession } from './persistence-helpers.ts'

it('continues the parent through default Messages after a reasoning-bearing continuable child settles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-settlement-messages-'))
  const ctx = new Context()
  let http: Awaited<ReturnType<typeof server>> | undefined
  try {
    http = await server((response, count) => {
      const blocks = count === 1
        ? [{ type: 'thinking', thinking: 'child reasoning' }, { type: 'text', text: 'child answer' }]
        : [{ type: 'text', text: 'parent answer' }]
      response.end(sse([
        start,
        ...blocks.flatMap((content_block, index) => [
          { type: 'content_block_start', index, content_block },
          { type: 'content_block_stop', index },
        ]),
        ...end(),
      ]))
    })
    const { requests } = http
    const connection = resolveAdapterOptions({ baseURL: http.url })
    const adapter = new DeepSeekAdapter({
      options: () => connection,
      resolveApiKey: () => Promise.resolve('test-key'),
      resolveUserId: () => '00000000-0000-4000-8000-000000000001' as AnonymousUserId,
      prepareExtensions: () => Promise.resolve({ fields: {}, accept: () => Promise.resolve() }),
    })
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    ctx.llm.registerAdapter(['deepseek-official'], adapter)
    const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'deepseek-official', model: MODEL })
    const ends: SubagentRunEndInfo[] = []
    const settled = Promise.withResolvers<undefined>()
    ctx.on('subagent/end', (info) => {
      ends.push(info)
      settled.resolve(undefined)
    })

    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'child task',
      request: { parent, prompt: [{ type: 'text', text: 'child task' }] },
      signal: new AbortController().signal,
    })
    await settled.promise
    await parent.whenIdle()

    const output = [{ type: 'reasoning', text: 'child reasoning' }, { type: 'text', text: 'child answer' }]
    expect(ends).toHaveLength(1)
    expect(ends[0]?.lastAssistantMessage).toEqual(output)
    const child = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(child.events.filter(event => event.type === 'assistant/message').at(-1))
      .toMatchObject({ data: { message: { content: output } } })
    expect(parent.session.snapshotEvents().at(-1))
      .toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    expect(requests).toHaveLength(2)
    expect(requests.map(request => request.path)).toEqual(['/anthropic/v1/messages', '/anthropic/v1/messages'])
    const notice = parent.session.deriveMessages().find(message => message.source.kind === 'subagent-settled')
    expect(notice?.content).toEqual([
      { type: 'text', text: `Background subagent ${started.childId} finished and will do no further work unless you send it more.` },
      { type: 'text', text: 'Its closing message:' },
      { type: 'text', text: 'child answer' },
    ])
    expect(requests[1]?.body).toMatchObject({ messages: [{ role: 'user', content: notice?.content }] })

    parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] }))
    await parent.whenIdle()
    expect(parent.session.snapshotEvents().filter(event => event.type === 'turn/end'))
      .toMatchObject([{ data: { reason: { kind: 'completed' } } }, { data: { reason: { kind: 'completed' } } }])
    expect(requests).toHaveLength(3)
    expect(requests[2]?.body).toMatchObject({ messages: [
      { role: 'user', content: notice?.content },
      { role: 'assistant', content: [{ type: 'text', text: 'parent answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
    ] })
  } finally {
    try {
      await ctx.fiber.dispose()
    } finally {
      try {
        await http?.close()
      } finally {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    }
  }
})
