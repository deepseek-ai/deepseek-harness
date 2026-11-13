/** An imported Session resumes through the production agent loop with the imported history as model context. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { importDeepseekChatExport } from '../src/importer.ts'

const BASE = Date.UTC(2026, 10, 11, 2, 0, 0)
const at = (ms: number): string => new Date(BASE + ms).toISOString()
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

function text(content: readonly ContentBlock[]): string {
  return content.map(block => block.type === 'text' || block.type === 'reasoning' ? `${block.type}:${block.text}`
    : block.type === 'tool-call' ? `call:${block.name}` : block.type).join(' | ')
}

it('continues an imported conversation with its finished history and without excluded replies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-deepseek-import-resume-'))
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
  const conversation = {
    id: 'c1', title: 'Bus route', inserted_at: at(0),
    messages: [
      { id: 1, parent_id: null, role: 'USER', status: 'FINISHED', inserted_at: at(1_000), fragments: [{ type: 'REQUEST', content: 'Find a bus route' }] },
      {
        id: 2, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', inserted_at: at(1_000), fragments: [
          { type: 'THINK', content: 'Search first.', elapsed_secs: 1 },
          { type: 'TOOL_SEARCH', queries: ['bus route'], results: [{ url: 'https://a.example/', title: 'A', snippet: 'Bus 1', published_at: null, site_name: null }] },
          { type: 'THINK', content: 'Found it.', elapsed_secs: 1 },
          { type: 'RESPONSE', content: 'Take bus 1.' },
        ],
      },
      { id: 3, parent_id: 2, role: 'USER', status: 'FINISHED', inserted_at: at(5_000), fragments: [{ type: 'REQUEST', content: 'Anything faster?' }] },
      { id: 4, parent_id: 3, role: 'ASSISTANT', status: 'CONTENT_FILTER', inserted_at: at(5_000), fragments: [{ type: 'RESPONSE', content: 'withdrawn answer' }] },
    ],
  }
  const archive = zipSync({
    'manifest.json': strToU8('{"export_format_version":3}'),
    'chat_session_index.json': strToU8(JSON.stringify([
      { id: 'c1', title: 'Bus route', pinned: false, inserted_at: at(0), updated_at: at(5_000), message_count: 4 },
    ])),
    'chat_sessions/c1.json': strToU8(JSON.stringify(conversation)),
  })

  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await mountAgentLoopTestHarness(ctx)
  const adapter = new MockAdapter([textResponse('Bus 2 is faster.')])
  ctx.llm.registerAdapter(['mock'], adapter)

  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const result = await importDeepseekChatExport({
    persistence: ctx.sessionPersistence,
    workspaceRegistered: () => true,
    createId: () => randomUUID(),
    warn: (message) => { throw new Error(message) },
  }, {
    archive,
    workspace: { id: 'workspace', path: workspace, attachSession: () => Promise.resolve() },
    limits: { maxSessions: 10, maxEntryBytes: 1024 * 1024, maxTitleBytes: 80 },
    onProgress: () => {},
  }, new AbortController().signal)
  expect(result.workspacePath).toBe(workspace)

  const sessionId = SessionId(result.sessionIds[0]!)
  const handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
  cleanups.push(async () => { await handle.dispose() })
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Thanks' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, handle.agent)

  expect(adapter.requests).toHaveLength(1)
  const visible = adapter.requests[0]!.messages
    .filter(message => message.role !== 'system' && !(message.role === 'user' && message.source?.kind !== 'user'))
    .map(message => `${message.role} ${text(message.content)}`)
  expect(visible).toEqual([
    'user text:Find a bus route',
    'assistant reasoning:Search first. | call:web_search',
    expect.stringMatching(/^tool text:External web content follows\./u),
    'assistant reasoning:Found it. | text:Take bus 1.',
    'user text:Thanks',
  ])
  // The question whose reply was withdrawn is left out together with the reply.
  expect(JSON.stringify(adapter.requests[0]!.messages)).not.toMatch(/withdrawn answer|Anything faster/u)
  // The resumed Agent replaces the imported empty system head instead of appending a second prompt.
  expect(adapter.requests[0]!.messages.filter(message => message.role === 'system')).toHaveLength(1)
  const events = handle.agent.session.snapshotEvents()
  const systems = events.filter(event => event.type === 'system/message')
  expect(systems.map(event => [event.surfaceOp, event.data.message.content.length > 0])).toEqual([
    ['append', false],
    [{ op: 'replace', startSeq: systems[0]!.seq, endSeq: systems[0]!.seq }, true],
  ])
  expect(handle.agent.session.surface.nodes.filter(seq => events[seq]?.type === 'system/message')).toEqual([systems[1]!.seq])

  // Reading the stored log back runs the released-format relationship checks.
  await handle.dispose()
  const reopened = await ctx.sessionPersistence.open(sessionId, 'read')
  try {
    const stored = await reopened.read()
    expect(stored.events.map(event => event.type)).toEqual(events.map(event => event.type))
  } finally {
    await reopened.close()
  }
})
