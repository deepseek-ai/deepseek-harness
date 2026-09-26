import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { createUserMessage, ToolCallId, type StreamChunk  } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'test': { kind: 'test' } & ContextFormed
  }
}

function toolCallResponse(): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'inspect first' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'inspect first' } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: ToolCallId('call-1'), name: 'echo', argumentsDelta: '{}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('call-1'), name: 'echo', arguments: '{}' } },
    { type: 'usage', usage: { inputTokens: 8, outputTokens: 2, reasoningTokens: 1 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

describe('ACP automation output boundary', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('emits committed reasoning, generic tool lifecycle, usage, and final text in order', async () => {
    harness = await makeBridgeHarness({ script: [toolCallResponse(), textResponse('done')] })
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'Return a deterministic result.',
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'tool result' }]),
    }))
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })

    await vi.waitFor(() => { expect(harness!.updates.at(-1)?.sessionUpdate).toBe('usage_update') })
    expect(harness.updates.map(update => update.sessionUpdate)).toEqual([
      'agent_thought_chunk',
      'usage_update',
      'tool_call',
      'tool_call_update',
      'agent_message_chunk',
      'usage_update',
    ])
    expect(harness.updates[0]).toMatchObject({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'inspect first' },
    })
    expect('messageId' in harness.updates[0]!).toBe(true)
    expect(harness.updates[2]).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'echo',
      kind: 'other',
      status: 'in_progress',
      rawInput: {},
    })
    expect(harness.updates[3]).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'tool result' } }],
    })
    expect(harness.updates[4]).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'done' },
    })
    expect('messageId' in harness.updates[4]!).toBe(true)
    expect(harness.updates[5]).toMatchObject({
      sessionUpdate: 'usage_update',
      size: 1_024,
    })
    if (harness.updates[5]?.sessionUpdate !== 'usage_update') throw new Error('expected usage update')
    expect(typeof harness.updates[5].used).toBe('number')
  })

  it('ignores events from agents the bridge does not own', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('foreign')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const { agent } = await harness.ctx.agents.create({
      sessionId: SessionId('foreign'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(harness.updates).toHaveLength(0)
  })

  it('delivers output from a bridge-owned session driven by another in-process producer', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('external')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'test' } }))
    await agent.whenIdle()
    await vi.waitFor(() => { expect(harness!.updates.at(-1)?.sessionUpdate).toBe('usage_update') })

    expect(harness.updates[0]).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'external' },
    })
    expect('messageId' in harness.updates[0]!).toBe(true)
  })

  it('contains output conversion failure outside an ACP prompt', async () => {
    harness = await makeBridgeHarness({ script: [[
      { type: 'block-start', index: 0, blockType: 'image' },
      {
        type: 'block-end',
        index: 0,
        block: {
          type: 'image',
          attachment: {
            attachmentId: `sha256:${'a'.repeat(64)}` as never,
            mediaType: 'image/png',
            bytes: 1,
            width: 1,
            height: 1,
          },
        },
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ]] })
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'test' } }))
    await agent.whenIdle()
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('output conversion failed')) })
    expect(harness.updates).toEqual([])
  })

  // `session/update` is a JSON-RPC notification, so a client-side handler
  // failure never reaches the bridge; this pins that the prompt still settles
  // normally with such a client. The bridge's own write-failure guard is
  // transport-level and documented untestable at `notify`.
  it('settles the prompt normally when the client rejects update notifications', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('answer')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    harness.onSessionUpdateError = () => {}
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
  })
})
