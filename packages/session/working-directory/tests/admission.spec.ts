/** Actual request admission follows directory and permission changes made after assembly. */
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import SandboxPolicy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

describe.each(['pre-step', 'prepareCall'] as const)('%s context changes', (phase) => {
  it.each([false, true])('admits current directory and permissions with optional context=%s', async (optional) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-directory-admission-')))
    const selected = join(root, 'selected')
    await mkdir(selected)
    const ctx = new Context()
    try {
      await mountAgentLoopTestDependencies(ctx, {
        workingDirectory: true, systemPrompt: { includeRuntimeContext: optional, includeHarnessIdentity: false },
      })
      await ctx.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: root })
      await ctx.plugin(ApprovalService, { policy: 'never' })
      const adapter = new MockAdapter([textResponse('first reply'), textResponse('notice received')])
      ctx.llm.registerAdapter(['mock'], adapter)
      const harness = await mountAgentLoopTestHarness(ctx)
      const agent = await harness.create(SessionId(`directory-admission-${phase}-${optional}`), { provider: 'mock', model: 'mock' }, { cwd: root })
      let changed = false
      const change = async (): Promise<void> => {
        if (changed) return
        changed = true
        await ctx.workingDirectory.set(agent, selected)
        setSandboxMode(agent.session, 'danger-full-access')
        ctx.approval.setPolicy(agent, 'ask')
      }
      if (phase === 'pre-step') {
        ctx.on('agent/pre-step', async (_payload, next) => { await change(); return next() })
      } else {
        const prepare = adapter.prepareCall.bind(adapter)
        vi.spyOn(adapter, 'prepareCall').mockImplementation(async (provider, model, signal) => {
          await change()
          return prepare(provider, model, signal)
        })
      }
      ctx.on('llm/stream', (request, next) => {
        expect(request.messages).toEqual(Session.create(agent.id, agent.session.snapshotEvents(), agent.session.header).deriveMessages())
        expect(Object.isFrozen(request.messages)).toBe(true)
        expect(request.messages.every(message => Object.isFrozen(message))).toBe(true)
        return next()
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read the active project.' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      const first = adapter.requests[0]
      expect(first).toBeDefined()
      const snapshots = first?.messages.filter(message => message.role === 'user' && message.source?.kind === 'runtime-context') ?? []
      expect(snapshots).toHaveLength(1)
      const body = snapshots.flatMap(message => message.content).map(block => block.type === 'text' ? block.text : '').join('')
      expect(body).toContain(`Current working directory: ${JSON.stringify(selected)}.`)
      expect(body).not.toContain(`Current working directory: ${JSON.stringify(root)}.`)
      expect(body.includes('Current DSH file policy: danger-full-access')).toBe(optional)
      expect(body.includes('Approval policy: ask.')).toBe(optional)
      expect(body).not.toContain('Current DSH file policy: read-only')
      expect(body).not.toContain('Approval prompts are disabled')
      expect(ctx.workingDirectory.get(agent.session)).toBe(selected)
      expect(agent.session.header.cwd).toBe(root)
      expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
      expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
