import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import * as WorkspaceContext from '@deepseek-ai/dsh-agent-instructions'
import { candidateScopeKey } from '../src/render.ts'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const PROBE = 'banana-271828'
const NESTED_PROBE = 'papaya-314159'
const UPDATED_PROBE = 'guava-161803'

let ctx: Context | undefined
let workdir: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

async function harness(): Promise<{ ctx: Context; agent: Agent }> {
  workdir = await mkdtemp(join(tmpdir(), 'dsh-workspace-context-e2e-'))
  await mkdir(join(workdir, '.git'), { recursive: true })
  await writeFile(join(workdir, 'AGENTS.md'), `If the user asks for the workspace context handshake, reply with exactly this string and nothing else: ${PROBE}.\n`)
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, {
    systemPrompt: { personaPrefix: 'Answer the user exactly and concisely.' },
  })
  await ctx.plugin(LocalFileSystem, { cwd: '/' })
  await ctx.plugin(ToolFs)
  await ctx.plugin(WorkspaceContext, { maxBytes: 65536 })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LlmDeepSeek, { models: [{ id: 'deepseek-v4-flash' }] })
  const handle = await ctx.agents.create({
    sessionId: SessionId('workspace-context-e2e-session'),
    meta: { cwd: workdir },
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  })
  return { ctx, agent: handle.agent }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function finalText(events: readonly SessionEvent[]): string {
  const message = events.findLast(event => event.type === 'assistant/message')
  if (message?.type !== 'assistant/message') return ''
  return message.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('workspace context e2e: real model sees AGENTS.md baseline', () => {
  it('obeys a probe instruction loaded from the workspace', async () => {
    const live = await harness()

    live.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Workspace context handshake?' }], source: { kind: 'user' } }))
    await waitForIdle(live.ctx, live.agent)

    expect(finalText(live.agent.session.snapshotEvents())).toContain(PROBE)
  }, 120_000)

  it('loads a nested AGENTS.md after the real read tool touches a descendant file', async () => {
    const live = await harness()
    await mkdir(join(workdir!, 'pkg/deep'), { recursive: true })
    await writeFile(join(workdir!, 'pkg/AGENTS.md'), `If the user asks for the nested instruction handshake, reply with exactly this string and nothing else: ${NESTED_PROBE}.\n`)
    await writeFile(join(workdir!, 'pkg/deep/file.txt'), 'This file exists only to trigger nested workspace instructions.\n')

    live.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Use the read tool to inspect pkg/deep/file.txt. After reading it, answer: nested instruction handshake?' }], source: { kind: 'user' } }))
    await waitForIdle(live.ctx, live.agent)

    expect(finalText(live.agent.session.snapshotEvents())).toContain(NESTED_PROBE)
  }, 120_000)

  it('appends changed baseline instructions after a real file-tool touch without rewriting the frozen prefix', async () => {
    const live = await harness()
    await writeFile(join(workdir!, 'trigger.txt'), 'This file triggers workspace instruction reconciliation.\n')
    live.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Workspace context handshake?' }], source: { kind: 'user' } }))
    await waitForIdle(live.ctx, live.agent)
    await writeFile(join(workdir!, 'AGENTS.md'), `The old workspace handshake no longer applies. If the user asks for the updated workspace context handshake, reply with exactly this string and nothing else: ${UPDATED_PROBE}.\n`)

    live.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'You must use the read tool to inspect trigger.txt. After reading it, answer: updated workspace context handshake?' }], source: { kind: 'user' } }))
    await waitForIdle(live.ctx, live.agent)

    const events = live.agent.session.snapshotEvents()
    const update = events.find(event => event.type === 'user/message'
      && event.data.source.kind === 'agent-instructions'
      && event.data.source.baseline !== true)
    expect(update?.type === 'user/message' && update.data.source).toMatchObject({
      changes: [{ action: 'replace', scope: candidateScopeKey('.', 'AGENTS.md'), path: 'AGENTS.md' }],
    })
    const updateText = update?.type === 'user/message'
      ? update.data.content.filter(block => block.type === 'text').map(block => block.text).join('')
      : ''
    expect(updateText).toContain('Updated instructions from: AGENTS.md')
    expect(finalText(events)).toContain(UPDATED_PROBE)
  }, 120_000)
})
