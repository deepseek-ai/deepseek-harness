import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { makeBridgeHarness, textResponse, type BridgeHarness, type CapturedUpdate } from './harness.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

function messageTextFor(
  updates: { sessionId: string; update: CapturedUpdate }[],
  sessionId: string,
): string {
  return updates.flatMap(({ sessionId: owner, update }) => (
    owner === sessionId && update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text'
      ? [update.content.text]
      : []
  )).join('')
}

describe('ACP multi-session isolation', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('demultiplexes concurrent answers by session id', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('answer-A'), textResponse('answer-B')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const a = (await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId
    const b = (await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId

    const [resultA, resultB] = await Promise.all([
      harness.client.prompt({ sessionId: a, prompt: [{ type: 'text', text: 'go A' }] }),
      harness.client.prompt({ sessionId: b, prompt: [{ type: 'text', text: 'go B' }] }),
    ])
    expect(resultA.stopReason).toBe('end_turn')
    expect(resultB.stopReason).toBe('end_turn')
    await vi.waitFor(() => {
      expect(messageTextFor(harness!.sessionUpdates, a)).toBe('answer-A')
      expect(messageTextFor(harness!.sessionUpdates, b)).toBe('answer-B')
    })
  })

  it('cancels one session without affecting another', async () => {
    harness = await makeBridgeHarness({ script: ['hang', textResponse('B done')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const a = (await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId
    const b = (await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId

    const pendingA = harness.client.prompt({ sessionId: a, prompt: [{ type: 'text', text: 'hang A' }] })
    await vi.waitFor(() => { expect(harness!.ctx.agents.get(brandString<SessionId>(a))?.status).toBe('running') })
    await harness.client.cancel({ sessionId: a })
    await expect(pendingA).resolves.toEqual({ stopReason: 'cancelled' })
    await expect(harness.client.prompt({ sessionId: b, prompt: [{ type: 'text', text: 'go B' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
    await vi.waitFor(() => { expect(messageTextFor(harness!.sessionUpdates, b)).toBe('B done') })
  })

  it('enforces one in-flight prompt independently for each session', async () => {
    harness = await makeBridgeHarness({ script: ['hang', 'hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const a = (await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId
    const b = (await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId
    const pendingA = harness.client.prompt({ sessionId: a, prompt: [{ type: 'text', text: 'A' }] })
    const pendingB = harness.client.prompt({ sessionId: b, prompt: [{ type: 'text', text: 'B' }] })
    await vi.waitFor(() => {
      expect(harness!.ctx.agents.get(brandString<SessionId>(a))?.status).toBe('running')
      expect(harness!.ctx.agents.get(brandString<SessionId>(b))?.status).toBe('running')
    })

    await expect(harness.client.prompt({ sessionId: a, prompt: [{ type: 'text', text: 'again' }] }))
      .rejects.toThrow(/already in flight/)
    await Promise.all([harness.client.cancel({ sessionId: a }), harness.client.cancel({ sessionId: b })])
    await expect(pendingA).resolves.toEqual({ stopReason: 'cancelled' })
    await expect(pendingB).resolves.toEqual({ stopReason: 'cancelled' })
  })

  it('drains every live session on bridge disposal', async () => {
    harness = await makeBridgeHarness({ script: ['hang', 'hang'] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const a = (await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId
    const b = (await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId
    const agentA = harness.ctx.agents.get(brandString<SessionId>(a))!
    const agentB = harness.ctx.agents.get(brandString<SessionId>(b))!
    void harness.client.prompt({ sessionId: a, prompt: [{ type: 'text', text: 'A' }] }).catch(() => {})
    void harness.client.prompt({ sessionId: b, prompt: [{ type: 'text', text: 'B' }] }).catch(() => {})
    await vi.waitFor(() => {
      expect(agentA.status).toBe('running')
      expect(agentB.status).toBe('running')
    })

    await harness.acpFiber.dispose()
    expect(harness.ctx.agents.get(brandString<SessionId>(a))).toBeUndefined()
    expect(harness.ctx.agents.get(brandString<SessionId>(b))).toBeUndefined()
  })
})
