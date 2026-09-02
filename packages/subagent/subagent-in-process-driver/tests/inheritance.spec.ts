/**
 * Delegation policy through child session events appended before publication:
 * the parent's sandbox override plus the pinned `approval/policy: never`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { startInProcessRun } from '../src/index.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

const READ_ONLY_DENIAL = '[sandbox: file access denied under read-only mode]'
const contexts: Context[] = []
let workspace: string

beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'dsh-inherit-')))
})

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  await rm(workspace, { recursive: true, force: true })
})

async function setupWalled(script: Script): Promise<{ ctx: Context; parent: Agent }> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
  await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
  await ctx.plugin(ToolFs)
  await ctx.plugin(ApprovalService)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const parent = await ctx.agentLoop.create(
    SessionId('parent'),
    { provider: 'mock', model: 'mock' },
    { cwd: workspace },
  )
  return { ctx, parent }
}

function spawnRequest(parent: Agent) {
  return {
    label: 'child task',
    prompt: [{ type: 'text' as const, text: 'child task' }],
    parent,
    signal: new AbortController().signal,
    descriptor: snapshotSubagentDescriptor({
      mode: 'one-shot',
      provider: 'spawn',
      label: 'child task',
    }),
  }
}

function toolResultTexts(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result')
    .map(event => event.data.message.content
      .flatMap(block => block.content)
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join(''))
}

describe('in-process policy inheritance', () => {
  it('records the parent sandbox override and the approval pin before publishing a spawn child', async () => {
    const script: Script = []
    const { ctx, parent } = await setupWalled(script)
    const blocked = join(workspace, 'spawn-blocked.txt')
    setSandboxMode(parent.session, 'read-only')
    // No parent approval override: the child pin must not depend on one.
    expect(ctx.approval.overrideOf(parent.session)).toBeUndefined()
    const parentLogLength = parent.session.snapshotEvents().length
    script.push(
      toolCallResponse('write', 'write', { file_path: blocked, content: 'escaped' }),
      textResponse('child done'),
    )

    const run = await startInProcessRun(spawnRequest(parent), {})
    try {
      const result = await run.result
      const child = run.localAgent as Agent

      await expect(readFile(blocked, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(toolResultTexts(child).join('\n')).toContain(READ_ONLY_DENIAL)
      expect(result.stopReason).toBe('completed')
      expect(child.session.snapshotEvents().slice(0, 2)).toMatchObject([
        { type: 'sandbox/mode', seq: 0, data: { mode: 'read-only', source: 'delegation' } },
        { type: 'approval/policy', seq: 1, data: { policy: 'never', source: 'delegation' } },
      ])
      expect(child.session.firstLiveSeq).toBe(0)
      expect(child.session.header.isSeeded).toBe(false)
      expect(child.session.inheritedEventCount).toBe(0)
      expect(ctx.sandboxPolicy.overrideOf(child.session)).toBe('read-only')
      expect(ctx.approval.overrideOf(child.session)).toBe('never')
      const request = child.session.snapshotEvents().find(
        (event): event is SessionEvent<'request/header'> => event.type === 'request/header',
      )
      const runtimeContext = child.session.snapshotEvents().find(
        (event): event is SessionEvent<'user/message'> => event.type === 'user/message'
          && event.data.source.kind === 'plugin'
          && event.data.source.plugin === '@deepseek-ai/dsh-system-prompt',
      )
      if (request === undefined || runtimeContext === undefined) throw new Error('child request lacks its runtime policy context')
      expect(runtimeContext.seq).toBeLessThan(request.seq)
      const contextText = runtimeContext.data.content
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('\n')
      expect(contextText).toContain('Current DSH file policy: read-only')
      expect(contextText).toContain('Approval prompts are disabled')
      // The statement rides runtime context; the system prompt stays uniform.
      expect(contextText).toContain('You are a delegated subagent')
      expect(request.data.header.system).not.toContain('Approval prompts are disabled')
      expect(request.data.header.system).not.toContain('You are a delegated subagent')
      expect(parent.session.snapshotEvents()).toHaveLength(parentLogLength)
    } finally {
      await run.dispose()
    }
  })

  it('places inherited events after a fork prefix so fresh policy wins stale seed state', async () => {
    const script: Script = []
    const { ctx, parent } = await setupWalled(script)
    const blocked = join(workspace, 'fork-blocked.txt')
    setSandboxMode(parent.session, 'workspace-write')
    const seed = parent.session.snapshotEvents()
    setSandboxMode(parent.session, 'read-only')
    script.push(
      toolCallResponse('write', 'write', { file_path: blocked, content: 'escaped' }),
      textResponse('child done'),
    )

    const run = await startInProcessRun(spawnRequest(parent), { seed })
    try {
      await run.result
      const child = run.localAgent as Agent

      expect(child.session.header.isSeeded).toBe(true)
      expect(child.session.inheritedEventCount).toBe(1)
      expect(child.session.firstLiveSeq).toBe(seed.length)
      // seq 1 is the constructor's end-seed marker.
      expect(child.session.snapshotEvents().filter(event => event.type === 'sandbox/mode')).toMatchObject([
        { seq: 0, data: { mode: 'workspace-write' } },
        { seq: 2, data: { mode: 'read-only', source: 'delegation' } },
      ])
      await expect(readFile(blocked, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(ctx.sandboxPolicy.overrideOf(child.session)).toBe('read-only')

      setSandboxMode(child.session, 'danger-full-access')
      expect(ctx.sandboxPolicy.overrideOf(child.session)).toBe('danger-full-access')
    } finally {
      await run.dispose()
    }
  })

  it('captures policy at delegation before asynchronous child creation', async () => {
    const script: Script = [textResponse('child done')]
    const { ctx, parent } = await setupWalled(script)
    setSandboxMode(parent.session, 'read-only')

    const starting = startInProcessRun(spawnRequest(parent), {})
    setSandboxMode(parent.session, 'danger-full-access')
    const run = await starting
    try {
      await run.result
      const child = run.localAgent as Agent
      expect(ctx.sandboxPolicy.overrideOf(parent.session)).toBe('danger-full-access')
      expect(ctx.sandboxPolicy.overrideOf(child.session)).toBe('read-only')
    } finally {
      await run.dispose()
    }
  })

  it('leaves an unswitched sandbox on the deployment default while still pinning approval', async () => {
    const script: Script = []
    const { parent } = await setupWalled(script)
    const allowed = join(workspace, 'default-allowed.txt')
    script.push(
      toolCallResponse('write', 'write', { file_path: allowed, content: 'fine' }),
      textResponse('child done'),
    )

    const run = await startInProcessRun(spawnRequest(parent), {})
    try {
      await run.result
      const child = run.localAgent as Agent
      expect(await readFile(allowed, 'utf8')).toBe('fine')
      expect(child.session.snapshotEvents().some(event => event.type === 'sandbox/mode')).toBe(false)
      expect(child.session.snapshotEvents().filter(event => event.type === 'approval/policy')).toMatchObject([
        { seq: 0, data: { policy: 'never', source: 'delegation' } },
      ])
      expect(child.session.firstLiveSeq).toBe(0)
    } finally {
      await run.dispose()
    }
  })

  it('rejects a child escalation deterministically even when an answerer would allow it', async () => {
    const script: Script = []
    const { ctx, parent } = await setupWalled(script)
    // A granting answerer proves the pin resolves before any answerer runs.
    let consulted = false
    ctx.on('approval/request', () => {
      consulted = true
      return Promise.resolve('allowed-once' as const)
    })
    const blocked = join(workspace, 'escalation-blocked.txt')
    setSandboxMode(parent.session, 'read-only')
    script.push(
      toolCallResponse('write', 'write', {
        file_path: blocked,
        content: 'escaped',
        sandbox_permissions: 'workspace-write',
        justification: 'test escalation from a delegated child',
      }),
      textResponse('child done'),
    )

    const run = await startInProcessRun(spawnRequest(parent), {})
    try {
      await run.result
      const child = run.localAgent as Agent

      await expect(readFile(blocked, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(consulted).toBe(false)
      expect(toolResultTexts(child).join('\n'))
        .toContain('the user rejected escalating this operation to "workspace-write"')
      const asked = child.session.snapshotEvents().find(
        (event): event is SessionEvent<'approval/asked'> => event.type === 'approval/asked',
      )
      const decided = child.session.snapshotEvents().find(
        (event): event is SessionEvent<'approval/decided'> => event.type === 'approval/decided',
      )
      expect(asked?.data.toolName).toBe('write')
      expect(decided?.data).toMatchObject({ id: asked?.data.id, outcome: 'rejected' })
    } finally {
      await run.dispose()
    }
  })
})
