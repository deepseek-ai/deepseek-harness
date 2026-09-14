import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { makeBridgeHarness, type BridgeHarness } from './harness.ts'

describe('ACP connection ownership', () => {
  let harness: BridgeHarness | undefined
  let releaseBlockedDisposal: (() => void) | undefined

  afterEach(async () => {
    const bridge = harness
    harness = undefined
    releaseBlockedDisposal?.()
    releaseBlockedDisposal = undefined
    await bridge?.dispose()
  })

  it('disposal cancels a running prompt and awaits agent teardown', async () => {
    harness = await makeBridgeHarness({ script: ['hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    await vi.waitFor(() => { expect(agent.status).toBe('running') })

    await harness.acpFiber.dispose()
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
    expect(agent.status).toBe('idle')
    expect(harness.ctx.agents.get(SessionId(sessionId))).toBeUndefined()
  })

  it('disposal drains asynchronous assistant image delivery before releasing sessions', async () => {
    const script: StreamChunk[][] = []
    harness = await makeBridgeHarness({ script })
    const ref = await harness.attachments!.saveImage({ data: Uint8Array.of(4), mediaType: 'image/png' })
    script.push([
      { type: 'block-start', index: 0, blockType: 'image' },
      { type: 'block-end', index: 0, block: { type: 'image', attachment: ref } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const readStarted = Promise.withResolvers<undefined>()
    const releaseRead = Promise.withResolvers<undefined>()
    harness.attachments!.beforeRead = () => {
      readStarted.resolve(undefined)
      return releaseRead.promise
    }
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'show it' }] })
    await readStarted.promise

    let disposed = false
    const disposal = harness.acpFiber.dispose().finally(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)

    releaseRead.resolve(undefined)
    await disposal
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
    expect(harness.ctx.agents.get(SessionId(sessionId))).toBeUndefined()
  })

  it('drains continuable subagents before disposing its own sessions', async () => {
    harness = await makeBridgeHarness()
    const order: string[] = []
    let drainedParents: readonly Agent[] = []
    // A continuable Activation outlives the turn that started it, so the bridge
    // must release that forest before the agents whose runtime it depends on.
    harness.ctx.provide('subagents', {
      drainContinuableDescendants: (parents: readonly Agent[]) => {
        drainedParents = parents
        order.push('drained')
        return Promise.resolve()
      },
    } as never)
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    harness.ctx.on('agent/disposed', () => { order.push('agent disposed') })

    await harness.acpFiber.dispose()

    expect(order).toEqual(['drained', 'agent disposed'])
    expect(drainedParents).toEqual([agent])
    expect(harness.ctx.agents.get(SessionId(sessionId))).toBeUndefined()
  })

  it('cancels its own prompt before awaiting the descendant drain', async () => {
    harness = await makeBridgeHarness({ script: ['hang'] })
    const order: string[] = []
    const release = Promise.withResolvers<undefined>()
    harness.ctx.provide('subagents', {
      drainContinuableDescendants: async () => {
        order.push('drain started')
        await release.promise
        order.push('drain finished')
      },
    } as never)
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    void harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }).catch(() => {})
    await vi.waitFor(() => { expect(agent.status).toBe('running') })
    const cancel = agent.cancel.bind(agent)
    let cancelObserved = false
    vi.spyOn(agent, 'cancel').mockImplementation((...args) => {
      if (!cancelObserved) {
        cancelObserved = true
        order.push('parent cancelled')
      }
      cancel(...args)
    })

    const disposal = harness.acpFiber.dispose()
    // A drain can block on persistence, so the bridge's own turn must already be
    // cancelled rather than running for its whole duration.
    await vi.waitFor(() => { expect(order).toContain('drain started') })
    expect(order).toEqual(['parent cancelled', 'drain started'])
    release.resolve(undefined)
    await disposal
    expect(harness.ctx.agents.get(SessionId(sessionId))).toBeUndefined()
  })

  it('reports a failed continuable drain and still disposes its sessions', async () => {
    harness = await makeBridgeHarness()
    const warnings: string[] = []
    harness.ctx.logger.warn = (message: string) => { warnings.push(message) }
    harness.ctx.provide('subagents', {
      drainContinuableDescendants: () => Promise.reject(new Error('activation teardown failed')),
    } as never)
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await harness.acpFiber.dispose()

    // A stuck descendant must not strand the bridge's own teardown.
    expect(warnings.some(warning => warning.includes('continuable subagent teardown failed'))).toBe(true)
    expect(harness.ctx.agents.get(SessionId(sessionId))).toBeUndefined()
  })

  it('awaits every owned session disposal and reports nested failure reasons', async () => {
    harness = await makeBridgeHarness()
    const create = harness.ctx.agents.create.bind(harness.ctx.agents)
    const releaseSecond = Promise.withResolvers<undefined>()
    const warnings: string[] = []
    let created = 0
    let secondStarted = false
    harness.ctx.logger.warn = (message: string) => { warnings.push(message) }
    const createSpy = vi.spyOn(harness.ctx.agents, 'create').mockImplementation(async (options) => {
      const handle = await create(options)
      const originalDispose = handle.dispose.bind(handle)
      if (created++ === 0) {
        handle.dispose = async () => {
          await originalDispose()
          throw new AggregateError([
            new Error('scope cleanup failed', { cause: new Error('sqlite busy') }),
            new Error('hook cleanup failed'),
          ], 'first session cleanup failed')
        }
      } else {
        handle.dispose = async () => {
          secondStarted = true
          await releaseSecond.promise
          await originalDispose()
        }
      }
      return handle
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const first = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const second = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await harness.closeClientTransport()
    await vi.waitFor(() => { expect(secondStarted).toBe(true) })
    expect(warnings.some(warning => warning.includes('connection-close teardown failed'))).toBe(false)

    releaseSecond.resolve(undefined)
    await vi.waitFor(() => {
      expect(warnings.some(warning =>
        warning.includes(
          'ACP agent teardown failed for 1 session(s): '
          + 'first session cleanup failed [scope cleanup failed: sqlite busy; hook cleanup failed]',
        ))).toBe(true)
      expect(harness!.ctx.agents.get(SessionId(first.sessionId))).toBeUndefined()
      expect(harness!.ctx.agents.get(SessionId(second.sessionId))).toBeUndefined()
    })

    createSpy.mockRestore()
    const disposed = harness
    harness = undefined
    await disposed.dispose().catch(() => undefined)
  })

  it('an ACP-only reload rejects new sessions before creating an orphan', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await harness.acpFiber.dispose()
    await expect(harness.client.newSession({ cwd: process.cwd(), mcpServers: [] }))
      .rejects.toThrow(/disposed/)
    expect(harness.ctx.agents.list()).toHaveLength(0)
  })

  it.each([
    ['a client disconnect', 'closeClientTransport'],
    ['a failed client transport', 'abortClientTransport'],
  ] as const)('%s disposes its session without plugin disposal', async (_name, disconnect) => {
    harness = await makeBridgeHarness({ script: ['hang'] })
    const bridge = harness
    const create = bridge.ctx.agents.create.bind(bridge.ctx.agents)
    const disposalStarted = Promise.withResolvers<undefined>()
    const releaseDisposal = Promise.withResolvers<undefined>()
    releaseBlockedDisposal = () => { releaseDisposal.resolve(undefined) }
    const disposalCompleted = Promise.withResolvers<undefined>()
    const createSpy = vi.spyOn(bridge.ctx.agents, 'create').mockImplementation(async (options) => {
      const handle = await create(options)
      const dispose = handle.dispose.bind(handle)
      handle.dispose = () => {
        const completion = (async () => {
          disposalStarted.resolve(undefined)
          await releaseDisposal.promise
          await dispose()
          return undefined
        })()
        disposalCompleted.resolve(completion)
        return completion
      }
      return handle
    })
    const running = Promise.withResolvers<undefined>()
    let stopListening: (() => void) | undefined
    try {
      await bridge.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      const { sessionId } = await bridge.client.newSession({ cwd: process.cwd(), mcpServers: [] })
      const agent = bridge.ctx.agents.get(SessionId(sessionId))!
      stopListening = bridge.ctx.on('agent/status', ({ agent: changed, status }) => {
        if (changed === agent && status === 'running') running.resolve(undefined)
      })
      void bridge.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }).catch(() => {})
      await running.promise

      await bridge[disconnect]()
      await disposalStarted.promise
      expect(bridge.ctx.agents.get(SessionId(sessionId))).toBe(agent)
      expect(bridge.ctx.sessions.get(SessionId(sessionId))).toBe(agent.session)
      releaseDisposal.resolve(undefined)
      await disposalCompleted.promise
      expect(agent.status).toBe('idle')
      expect(bridge.ctx.agents.get(SessionId(sessionId))).toBeUndefined()
      expect(bridge.ctx.sessions.get(SessionId(sessionId))).toBeUndefined()
    } finally {
      releaseDisposal.resolve(undefined)
      stopListening?.()
      createSpy.mockRestore()
    }
  })

  it('disconnect and plugin disposal share one quiescence boundary', async () => {
    harness = await makeBridgeHarness({ script: ['hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    void harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }).catch(() => {})
    await vi.waitFor(() => { expect(agent.status).toBe('running') })

    await Promise.all([harness.closeClientTransport(), harness.acpFiber.dispose()])
    expect(agent.status).toBe('idle')
    expect(harness.ctx.agents.get(SessionId(sessionId))).toBeUndefined()
  })

  it('disposing a session-less bridge is idempotent', async () => {
    harness = await makeBridgeHarness()
    await Promise.all([harness.acpFiber.dispose(), harness.acpFiber.dispose()])
    expect(harness.ctx.agents.list()).toHaveLength(0)
  })
})
