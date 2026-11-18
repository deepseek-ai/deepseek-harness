/** Target Session permissions are enforced before subagent input or cancellation is admitted. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import type { RemoteAccessBinding } from '@deepseek-ai/dsh-api-remote-access'
import type { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { PeerId, PeerScope, Principal } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { createSessionTestController } from './test-remote.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test-only non-owner caller shared by the access specs. */
    'test-guest': { readonly kind: 'test-guest'; readonly guest: string }
  }
}

const GUEST: Principal = { kind: 'test-guest', guest: 'subagent-controls' }
const ACTIONS = ['subagents/prompt', 'subagents/interruptByUser'] as const
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-subagent-access-'))
  const ctx = new Context()
  cleanups.push(async () => {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  })
  await ctx.plugin(TypertRegistry)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  await createSessionTestController(ctx, { defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }), cwd: root })
  await ctx.plugin(SubagentRuntime)
  ctx.subagents.registerProvider({
    name: 'test', inheritsParentContext: false,
    capabilities: { agentOptions: true, agentPreset: false, outputSchema: false, depthLimit: false },
    prepareContinuable: async () => ({}),
  })
  const adapter = new MockAdapter(['hang'])
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(brandString<SessionId>('parent'), { provider: 'mock', model: 'mock' })
  const run = await ctx.subagents.startActivation({
    provider: 'test', label: 'access target', delivery: 'caller',
    parent, prompt: [{ type: 'text', text: 'hold' }],
    signal: new AbortController().signal,
  })
  await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
  const child = ctx.agents.get(run.childId)!
  await ctx.plugin(TypertGatewayService)
  const bindings: RemoteAccessBinding[] = []
  ctx.remoteAccess.registerPolicy('test-guest', { bindings: () => bindings })
  const call = (method: 'prompt' | 'interruptByUser', principal: Principal = GUEST, image = false) => {
    const peer: PeerScope = {
      id: 'subagent-access-peer' as PeerId, ctx, principal, interactions: 'answer',
      signal: new AbortController().signal, dispose: async () => {},
    }
    return ctx.typertGateway.invoke({
      peer, namespace: 'subagents', method,
      args: method === 'prompt' ? { request: {
        requestId: 'access-follow-up', childSessionId: child.id, delivery: 'queue',
        content: image ? [{ type: 'image', mediaType: 'image/png', data: 'aGk=' }] : [{ type: 'text', text: 'follow-up' }],
      } } : { childSessionId: child.id },
    })
  }
  return { ctx, parent, child, bindings, call }
}

describe('subagent target Session access', () => {
  it.each(['prompt', 'interruptByUser'] as const)('requires the target permission for %s', async (method) => {
    const { ctx, parent, child, bindings, call } = await harness()
    const attachments = vi.spyOn(ctx.attachments, 'admitPromptContent')
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession')
    const cancel = vi.spyOn(child, 'cancel')
    const grants: RemoteAccessBinding[][] = [
      [],
      [{ role: { name: 'global controls', resource: 'global', actions: ACTIONS }, resource: { kind: 'global' } }],
      [{ role: { name: 'parent controls', resource: 'session', actions: ACTIONS }, resource: { kind: 'session', id: parent.id } }],
      [{ role: { name: 'other control', resource: 'session', actions: [method === 'prompt' ? ACTIONS[1] : ACTIONS[0]] }, resource: { kind: 'session', id: child.id } }],
    ]
    for (const grant of grants) {
      bindings.splice(0, bindings.length, ...grant)
      await expect(call(method, GUEST, true)).rejects.toMatchObject({
        code: 'remote-access/denied', details: { action: `subagents/${method}`, reason: 'no-allow' },
      })
    }
    expect(attachments).not.toHaveBeenCalled()
    expect(observe).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
    expect(child.inbox.nextTurn).toHaveLength(0)

    bindings.splice(0, bindings.length, {
      role: { name: 'target control', resource: 'session', actions: [`subagents/${method}`] },
      resource: { kind: 'session', id: child.id },
    })
    const accepted = await call(method)
    if (method === 'prompt') {
      expect(child.inbox.nextTurn).toHaveLength(1)
      expect(accepted).toEqual({ messageId: child.inbox.nextTurn[0]?.id })
      expect(child.inbox.nextTurn[0]?.source).toMatchObject({ kind: 'user', principal: GUEST })
    } else {
      expect(accepted).toEqual({ accepted: true })
      expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
      await child.whenIdle()
    }
  })

  it('allows the owner without target bindings', async () => {
    const { child, call } = await harness()
    const accepted = await call('prompt', { kind: 'owner' })
    expect(child.inbox.nextTurn).toHaveLength(1)
    expect(accepted).toEqual({ messageId: child.inbox.nextTurn[0]?.id })
    await expect(call('interruptByUser', { kind: 'owner' })).resolves.toEqual({ accepted: true })
    await child.whenIdle()
  })
})
