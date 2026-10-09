import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import { setImmediate } from 'node:timers/promises'
import SubagentRuntime, { NO_START_CAPABILITIES } from '@deepseek-ai/dsh-subagent'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import {
  errorResponse,
  makeBridgeHarness,
  maxTokensResponse,
  textResponse,
  type BridgeHarness,
} from './harness.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'test': { kind: 'test' } & ContextFormed
  }
}

async function newSession(harness: BridgeHarness): Promise<string> {
  await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  return (await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId
}

function messageText(harness: BridgeHarness): string {
  return harness.updates.flatMap(update => (
    update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text'
      ? [update.content.text]
      : []
  )).join('')
}

async function installDelegationTool(ctx: BridgeHarness['ctx']): Promise<() => boolean> {
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  ctx.subagents.registerProvider({
    name: 'local-test', capabilities: NO_START_CAPABILITIES, inheritsParentContext: false,
    prepareContinuable: () => Promise.resolve({}),
  })
  let delegated = false
  ctx.tools.register(defineContentToolFixture({
    name: 'delegate_again', description: 'Run a later child.', parameters: {},
    execute: async (_args, exec) => {
      if (exec.agent === undefined) throw new Error('delegation fixture requires an Agent')
      const child = await ctx.subagents.startActivation({
        provider: 'local-test', label: 'later child', delivery: 'caller', signal: exec.signal,
        request: { parent: exec.agent, prompt: [{ type: 'text', text: 'later child task' }] },
      })
      const result = await child.result
      delegated = result.stopReason === 'completed'
      return [...result.output]
    },
  }))
  return () => delegated
}

describe('ACP prompt lifecycle', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('reports a max-token turn without losing its committed text', async () => {
    harness = await makeBridgeHarness({ script: [maxTokensResponse('cut off')] })
    const sessionId = await newSession(harness)
    const result = await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    expect(result.stopReason).toBe('max_tokens')
    await vi.waitFor(() => { expect(messageText(harness!)).toBe('cut off') })
  })

  it('delivers a committed assistant image as verified ACP base64', async () => {
    const script: StreamChunk[][] = []
    harness = await makeBridgeHarness({ script })
    const ref = await harness.attachments!.saveImage({ data: Uint8Array.of(1), mediaType: 'image/png' })
    script.push([
      { type: 'block-start', index: 0, blockType: 'image' },
      {
        type: 'block-end',
        index: 0,
        block: {
          type: 'image',
          attachment: ref,
        },
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const sessionId = await newSession(harness)
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'show it' }] })
    const image = harness.updates.find(update => update.sessionUpdate === 'agent_message_chunk')
    expect(image).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'image', data: 'AQ==', mimeType: 'image/png' },
    })
    expect(image !== undefined && 'messageId' in image && typeof image.messageId === 'string').toBe(true)
  })

  it('preserves committed text/image/text order on the ACP wire', async () => {
    const script: StreamChunk[][] = []
    harness = await makeBridgeHarness({ script })
    const ref = await harness.attachments!.saveImage({ data: Uint8Array.of(2), mediaType: 'image/jpeg' })
    script.push([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'before' } },
      { type: 'block-start', index: 1, blockType: 'image' },
      { type: 'block-end', index: 1, block: { type: 'image', attachment: ref } },
      { type: 'block-start', index: 2, blockType: 'text' },
      { type: 'block-end', index: 2, block: { type: 'text', text: 'after' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const sessionId = await newSession(harness)

    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'show it' }] })

    expect(harness.updates.map(update => update.sessionUpdate)).toEqual([
      'agent_message_chunk', 'agent_message_chunk', 'agent_message_chunk',
    ])
    expect(harness.updates.map(update => 'content' in update ? update.content : undefined)).toEqual([
      { type: 'text', text: 'before' },
      { type: 'image', data: 'Ag==', mimeType: 'image/jpeg' },
      { type: 'text', text: 'after' },
    ])
    expect(new Set(harness.updates.map(update => 'messageId' in update ? update.messageId : undefined)).size).toBe(1)
  })

  it('does not settle a prompt before ordered output delivery drains', async () => {
    const script: StreamChunk[][] = []
    harness = await makeBridgeHarness({ script })
    const ref = await harness.attachments!.saveImage({ data: Uint8Array.of(3), mediaType: 'image/png' })
    script.push([
      { type: 'block-start', index: 0, blockType: 'image' },
      { type: 'block-end', index: 0, block: { type: 'image', attachment: ref } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const readStarted = Promise.withResolvers<undefined>()
    const delivery = Promise.withResolvers<undefined>()
    harness.attachments!.beforeRead = () => {
      readStarted.resolve(undefined)
      return delivery.promise
    }
    const sessionId = await newSession(harness)
    let settled = false

    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
      .finally(() => { settled = true })
    await readStarted.promise
    expect(settled).toBe(false)
    delivery.resolve(undefined)
    await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' })
  })

  it('fails prompt delivery when a committed image attachment is missing', async () => {
    const missing = {
      attachmentId: `sha256:${'a'.repeat(64)}` as never,
      mediaType: 'image/png' as const,
      bytes: 1,
      width: 1,
      height: 1,
    }
    harness = await makeBridgeHarness({ script: [[
      { type: 'block-start', index: 0, blockType: 'image' },
      { type: 'block-end', index: 0, block: { type: 'image', attachment: missing } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]] })
    const sessionId = await newSession(harness)

    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'show it' }] }))
      .rejects.toThrow(/assistant output delivery failed/)
    expect(harness.updates).toEqual([])
  })

  it('rejects a failed turn and never publishes its partial chunks', async () => {
    harness = await makeBridgeHarness({ script: [errorResponse('provider boom')] })
    const sessionId = await newSession(harness)
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }))
      .rejects.toThrow(/turn failed: provider boom/)
    expect(messageText(harness)).toBe('')
  })

  it('rejects an ordinary plugin failure through the same prompt boundary', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('must not run')] })
    harness.ctx.on('agent/pre-step', () => { throw new Error('plugin pre-step failed') })
    const sessionId = await newSession(harness)
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }))
      .rejects.toThrow(/turn failed: plugin pre-step failed/)
  })

  it('rejects a turn-start failure before the prompt is claimed', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('must not run')] })
    const sessionId = await newSession(harness)
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    const append = agent.session.append.bind(agent.session)
    vi.spyOn(agent.session, 'append').mockImplementation(((type: string, ...rest: never[]) => {
      if (type === 'turn/start') throw new Error('turn start unavailable')
      return (append as (...args: never[]) => unknown)(type as never, ...rest)
    }) as never)

    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }))
      .rejects.toThrow(/turn failed: turn start unavailable/)
    vi.restoreAllMocks()
  })

  it.each(['turn/start', 'turn/end'] as const)('rejects a later %s append failure after an earlier completed turn', async (failedEvent) => {
    harness = await makeBridgeHarness({ script: [textResponse('waiting'), textResponse('summary')] })
    const sessionId = await newSession(harness)
    const parent = harness.ctx.agents.get(SessionId(sessionId))!
    const append = parent.session.append.bind(parent.session)
    const appendSpy = vi.spyOn(parent.session, 'append')
    const failures: number[] = []
    harness.ctx.on('agent/error', ({ turn }) => { failures.push(turn) })
    const waitForChildren = vi.fn().mockImplementationOnce(() => {
      appendSpy.mockImplementation(((type: string, ...rest: never[]) => {
        if (type === failedEvent) throw new Error(`summary ${failedEvent} unavailable`)
        return (append as (...args: never[]) => unknown)(type as never, ...rest)
      }) as never)
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'child result' }], source: { kind: 'test' } }))
      return Promise.resolve(true)
    }).mockResolvedValue(false)
    harness.ctx.provide('subagents', { waitForChildren, drainDescendants: vi.fn() } as never)
    try {
      await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'delegate' }] }))
        .rejects.toThrow(`summary ${failedEvent} unavailable`)
      expect(failures).toEqual([failedEvent === 'turn/start' ? 1 : 2])
      expect(harness.adapter.requests).toHaveLength(failedEvent === 'turn/start' ? 1 : 2)
    } finally {
      appendSpy.mockRestore()
    }
  })

  it('settles even when an earlier turn observer throws', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('answer')] })
    harness.ctx.on('session/event', (_session, event) => {
      if (event.type === 'turn/start' || event.type === 'turn/end') throw new Error('peer listener boom')
    }, { prepend: true })
    const sessionId = await newSession(harness)
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
  })

  it('correlates the owning prompt when a synchronous injection joins its first step', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('real answer')] })
    const sessionId = await newSession(harness)
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    let injected = false
    harness.ctx.on('agent/inbox/inserted', ({ agent: subject, message }) => {
      if (subject === agent && message.source.kind === 'user' && !injected) {
        injected = true
        agent.inject(createUserMessage({ content: [{ type: 'text', text: 'context' }], source: { kind: 'test' } }))
      }
    })

    const result = await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    expect(result.stopReason).toBe('end_turn')
    await vi.waitFor(() => { expect(messageText(harness!)).toBe('real answer') })
  })

  it('ignores an autonomous message turn while correlating the client turn', async () => {
    harness = await makeBridgeHarness({ script: ['hang'] })
    const sessionId = await newSession(harness)
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    let autonomousStarted!: () => void
    const started = new Promise<void>((resolve) => { autonomousStarted = resolve })
    harness.ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
      if (subject === agent && frame.type === 'chunk') autonomousStarted()
    })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'autonomous work' }],
      source: { kind: 'test' },
    }))
    await started

    let settled = false
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
      .finally(() => { settled = true })
    await vi.waitFor(() => {
      expect(agent.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.length > 0)).toHaveLength(2)
    })
    expect(settled).toBe(false)
    await harness.client.cancel({ sessionId })
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
  })

  it('correlates a prompt whose step history is replaced', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('rewritten answer')] })
    harness.ctx.on('agent/pre-step', async () => ({
      kind: 'enter',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'rewritten prompt' }],
        source: { kind: 'test' },
      })],
    }))
    const sessionId = await newSession(harness)

    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'original' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
  })

  it('frees the prompt slot when the agent rejects the send synchronously', async () => {
    harness = await makeBridgeHarness({ script: [] })
    const sessionId = await newSession(harness)
    // Reload the loop out from under the bridge: its agents dispose while the
    // bridge record survives, so the next send() throws synchronously.
    await harness.loopFiber.dispose()
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'one' }] }))
      .rejects.toThrow(/prompt was not queued/)
    // The failed prompt must not wedge the session's single prompt slot.
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'two' }] }))
      .rejects.toThrow(/prompt was not queued/)
  })

  it('permits only one in-flight prompt per session', async () => {
    harness = await makeBridgeHarness({ script: ['hang'] })
    const sessionId = await newSession(harness)
    const first = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'one' }] })
    await vi.waitFor(() => { expect(harness!.ctx.agents.get(SessionId(sessionId))?.status).toBe('running') })
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'two' }] }))
      .rejects.toThrow(/already in flight/)
    await harness.client.cancel({ sessionId })
    await expect(first).resolves.toEqual({ stopReason: 'cancelled' })
  })

  it('routes JSON-RPC request cancellation through the prompt cancellation path', async () => {
    harness = await makeBridgeHarness({ script: ['hang'] })
    const sessionId = await newSession(harness)
    const controller = new AbortController()
    const prompt = harness.client.prompt(
      { sessionId, prompt: [{ type: 'text', text: 'one' }] },
      { cancellationSignal: controller.signal },
    )
    await vi.waitFor(() => { expect(harness!.ctx.agents.get(SessionId(sessionId))?.status).toBe('running') })

    controller.abort()

    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
    expect(harness.adapter.requests[0]?.signal?.aborted).toBe(true)
  })

  it('cancels a prompt request whose JSON-RPC signal is already aborted', async () => {
    harness = await makeBridgeHarness({ script: [] })
    const sessionId = await newSession(harness)
    const controller = new AbortController()
    controller.abort()

    await expect(harness.client.prompt(
      { sessionId, prompt: [{ type: 'text', text: 'never admitted' }] },
      { cancellationSignal: controller.signal },
    )).resolves.toEqual({ stopReason: 'cancelled' })
    expect(harness.adapter.requests).toEqual([])
  })

  it('reserves the prompt slot during image admission and cancels without a late followup', async () => {
    harness = await makeBridgeHarness({ imageCapable: true, script: [] })
    const validationStarted = Promise.withResolvers<undefined>()
    const releaseValidation = Promise.withResolvers<undefined>()
    harness.attachments!.beforeValidate = () => {
      validationStarted.resolve(undefined)
      return releaseValidation.promise
    }
    const sessionId = await newSession(harness)
    let settled = false
    const first = harness.client.prompt({
      sessionId,
      prompt: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }],
    }).finally(() => { settled = true })
    await validationStarted.promise

    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'second' }] }))
      .rejects.toThrow(/already in flight/)
    await harness.client.cancel({ sessionId })
    expect(settled).toBe(false)
    releaseValidation.resolve(undefined)

    await expect(first).resolves.toEqual({ stopReason: 'cancelled' })
    expect(harness.adapter.requests).toEqual([])
    const events = harness.ctx.agents.get(SessionId(sessionId))?.session.snapshotEvents() ?? []
    expect(events.some(event => event.type === 'user/message' || event.type === 'turn/start')).toBe(false)
  })

  it('does not cancel unrelated Agent work while its prompt is still in admission', async () => {
    harness = await makeBridgeHarness({ imageCapable: true, script: ['hang'] })
    const validationStarted = Promise.withResolvers<undefined>()
    const releaseValidation = Promise.withResolvers<undefined>()
    harness.attachments!.beforeValidate = () => {
      validationStarted.resolve(undefined)
      return releaseValidation.promise
    }
    const sessionId = await newSession(harness)
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'unrelated work' }],
      source: { kind: 'test' },
    }))
    await vi.waitFor(() => { expect(harness!.adapter.requests).toHaveLength(1) })

    const prompt = harness.client.prompt({
      sessionId,
      prompt: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }],
    })
    await validationStarted.promise
    await harness.client.cancel({ sessionId })

    expect(harness.adapter.requests[0]?.signal?.aborted).toBe(false)
    releaseValidation.resolve(undefined)
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
    expect(agent.status).toBe('running')
    agent.cancel({ kind: 'hook', reason: 'test cleanup' })
    await agent.whenIdle()
  })

  it('does not attribute an unrelated Agent failure during prompt admission', async () => {
    harness = await makeBridgeHarness({ imageCapable: true, script: [textResponse('answer')] })
    const validationStarted = Promise.withResolvers<undefined>()
    const releaseValidation = Promise.withResolvers<undefined>()
    harness.attachments!.beforeValidate = () => {
      validationStarted.resolve(undefined)
      return releaseValidation.promise
    }
    let failUnrelatedWork = true
    harness.ctx.on('agent/pre-step', (_payload, next) => {
      if (!failUnrelatedWork) return next()
      failUnrelatedWork = false
      throw new Error('unrelated pre-step failure')
    })
    const sessionId = await newSession(harness)
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    const prompt = harness.client.prompt({
      sessionId,
      prompt: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }],
    })
    await validationStarted.promise

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'unrelated work' }],
      source: { kind: 'test' },
    }))
    await agent.whenIdle()
    releaseValidation.resolve(undefined)

    await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' })
    expect(messageText(harness)).toBe('answer')
  })

  it('does not queue admitted content into an agent retired during storage', async () => {
    harness = await makeBridgeHarness({ imageCapable: true, script: [] })
    const validationStarted = Promise.withResolvers<undefined>()
    const releaseValidation = Promise.withResolvers<undefined>()
    harness.attachments!.beforeValidate = () => {
      validationStarted.resolve(undefined)
      return releaseValidation.promise
    }
    const sessionId = await newSession(harness)
    const prompt = harness.client.prompt({
      sessionId,
      prompt: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }],
    })
    await validationStarted.promise

    await harness.loopFiber.dispose()
    releaseValidation.resolve(undefined)

    await expect(prompt).rejects.toThrow(/disposed outside the bridge/)
    expect(harness.attachments!.saved).toHaveLength(1)
    expect(harness.adapter.requests).toEqual([])
  })

  it('honors cancellation in the admission-to-followup handoff gap', async () => {
    harness = await makeBridgeHarness({ imageCapable: true, script: [] })
    const sessionId = await newSession(harness)
    const saveImages = harness.attachments!.saveImages.bind(harness.attachments!)
    vi.spyOn(harness.attachments!, 'saveImages').mockImplementationOnce(async (inputs) => {
      const refs = await saveImages(inputs)
      queueMicrotask(() => { void harness!.client.cancel({ sessionId }) })
      return refs
    })

    await expect(harness.client.prompt({
      sessionId,
      prompt: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }],
    })).resolves.toEqual({ stopReason: 'cancelled' })
    expect(harness.adapter.requests).toEqual([])
  })

  it('wraps an unexpected same-process followup failure and frees the prompt slot', async () => {
    harness = await makeBridgeHarness({ script: [] })
    const sessionId = await newSession(harness)
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    vi.spyOn(agent, 'followup').mockImplementationOnce(() => { throw new Error('synthetic followup failure') })

    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }))
      .rejects.toThrow(/prompt was not queued: synthetic followup failure/)
  })

  it('cancels a running turn and records the aborted outcome', async () => {
    harness = await makeBridgeHarness({ script: ['hang'] })
    const sessionId = await newSession(harness)
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    await vi.waitFor(() => { expect(agent.status).toBe('running') })
    await harness.client.cancel({ sessionId })
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
    await agent.whenIdle()
    expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason)
      .toEqual({ kind: 'aborted', reason: { kind: 'user' } })
  })

  it('settles a hook-cancelled turn as end_turn, not cancelled', async () => {
    harness = await makeBridgeHarness({ script: ['hang'] })
    const sessionId = await newSession(harness)
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    await vi.waitFor(() => { expect(agent.status).toBe('running') })
    // A hook or another owner cancels the agent: the ACP client never called
    // session/cancel, so this is ordinary quiescence and reports end_turn.
    agent.cancel({ kind: 'hook', reason: 'owner intervention' })
    await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' })
  })

  it('cancels autonomous running work without an in-flight prompt', async () => {
    harness = await makeBridgeHarness({ script: ['hang'] })
    const sessionId = await newSession(harness)
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'autonomous work' }],
      source: { kind: 'test' },
    }))
    await vi.waitFor(() => {
      expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(true)
    })

    await harness.client.cancel({ sessionId })
    await agent.whenIdle()

    expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason)
      .toEqual({ kind: 'aborted', reason: { kind: 'user' } })
  })

  it('an idle cancel does not affect the following prompt', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('answer')] })
    const sessionId = await newSession(harness)
    await harness.client.cancel({ sessionId })
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
    await vi.waitFor(() => { expect(messageText(harness!)).toBe('answer') })
  })

  it('a late end from a cancelled turn cannot settle the next prompt', async () => {
    harness = await makeBridgeHarness({ script: ['hang', textResponse('next')] })
    const sessionId = await newSession(harness)
    const first = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'one' }] })
    await vi.waitFor(() => { expect(harness!.ctx.agents.get(SessionId(sessionId))?.status).toBe('running') })
    await harness.client.cancel({ sessionId })
    await expect(first).resolves.toEqual({ stopReason: 'cancelled' })

    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'two' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
    // 'partial' is the cancelled turn's finalized prefix update; 'next' proves
    // the second prompt settled independently of the aborted turn's late end.
    await vi.waitFor(() => { expect(messageText(harness!)).toBe('partialnext') })
  })

  it('a retry turn adopts the prompt instead of rejecting at the failed turn end', async () => {
    harness = await makeBridgeHarness({ script: [errorResponse('transient boom'), textResponse('recovered')] })
    // A recovery policy: schedule one retry for the failed request.
    let retried = false
    harness.ctx.on('agent/request-error', async () => {
      if (!retried) {
        retried = true
        return { kind: 'retry' }
      }
    })
    const sessionId = await newSession(harness)
    const result = await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    expect(result.stopReason).toBe('end_turn')
    await vi.waitFor(() => { expect(messageText(harness!)).toBe('recovered') })
  })

  it.each(['completed', 'error'] as const)('waits for descendants and reports the later %s summary turn', async (outcome) => {
    harness = await makeBridgeHarness({ script: [
      textResponse('waiting'),
      outcome === 'completed' ? textResponse('summary') : errorResponse('summary failed'),
    ] })
    const sessionId = await newSession(harness)
    const parent = harness.ctx.agents.get(SessionId(sessionId))!
    const waiting = Promise.withResolvers<undefined>()
    const children = Promise.withResolvers<boolean>()
    const waitForChildren = vi.fn()
      .mockImplementationOnce(() => { waiting.resolve(undefined); return children.promise })
      .mockResolvedValue(false)
    harness.ctx.provide('subagents', { waitForChildren, drainDescendants: vi.fn() } as never)
    let settled = false
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'delegate' }] })
    const observed = prompt.then(() => { settled = true }, () => { settled = true })
    await waiting.promise
    expect(settled).toBe(false)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'child result' }], source: { kind: 'test' } }))
    children.resolve(true)
    if (outcome === 'completed') {
      await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' })
      expect(messageText(harness)).toBe('waitingsummary')
    } else {
      await expect(prompt).rejects.toThrow('summary failed')
    }
    await observed
  })

  it('cancels the child wait without closing the session to its next prompt', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('waiting'), textResponse('next')] })
    const sessionId = await newSession(harness)
    const waiting = Promise.withResolvers<undefined>()
    const children = Promise.withResolvers<boolean>()
    const waitForChildren = vi.fn()
      .mockImplementationOnce(() => { waiting.resolve(undefined); return children.promise })
      .mockResolvedValue(false)
    const drainDescendants = vi.fn()
    harness.ctx.provide('subagents', { waitForChildren, drainDescendants } as never)
    const first = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'delegate' }] })
    await waiting.promise
    await harness.client.cancel({ sessionId })
    await expect(first).resolves.toEqual({ stopReason: 'cancelled' })
    expect(drainDescendants).not.toHaveBeenCalled()
    children.resolve(true)
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'again' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
    expect(messageText(harness)).toBe('waitingnext')
  })

  it('releases a cancelled prompt before a late child message finishes and permits another delegation', async () => {
    harness = await makeBridgeHarness({ script: [
      textResponse('waiting'), textResponse('late autonomous answer'),
      toolCallResponse('delegate-again', 'delegate_again', {}),
      textResponse('later child answer'), textResponse('later parent answer'),
    ] })
    const ctx = harness.ctx
    const delegated = await installDelegationTool(ctx)
    const sessionId = await newSession(harness)
    const parent = ctx.agents.get(SessionId(sessionId))!
    const waiting = Promise.withResolvers<undefined>()
    const children = Promise.withResolvers<boolean>()
    vi.spyOn(ctx.subagents, 'waitForChildren').mockImplementationOnce(() => {
      waiting.resolve(undefined)
      return children.promise
    })
    const lateStarted = Promise.withResolvers<undefined>()
    const releaseLate = Promise.withResolvers<undefined>()
    const stream = harness.adapter.stream.bind(harness.adapter)
    vi.spyOn(harness.adapter, 'stream').mockImplementation(async function* (options) {
      if (options.messages.at(-1)?.content.some(block => block.type === 'text' && block.text === 'late child result')) {
        lateStarted.resolve(undefined)
        await releaseLate.promise
      }
      yield* stream(options)
    })
    const cancel = parent.cancel.bind(parent)
    let delivered = false
    vi.spyOn(parent, 'cancel').mockImplementation((...args) => {
      cancel(...args)
      if (delivered) return
      delivered = true
      queueMicrotask(() => {
        parent.followup(createUserMessage({ content: [{ type: 'text', text: 'late child result' }], source: { kind: 'test' } }))
        children.resolve(true)
      })
    })
    let result: { stopReason: string } | undefined
    const first = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'delegate' }] })
      .then((value) => { result = value; return value })
    try {
      await waiting.promise
      await harness.client.cancel({ sessionId })
      await lateStarted.promise
      await setImmediate()
      expect(result).toEqual({ stopReason: 'cancelled' })
      expect(parent.status).toBe('running')
      releaseLate.resolve(undefined)
      await parent.whenIdle()
      await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'delegate again' }] }))
        .resolves.toEqual({ stopReason: 'end_turn' })
      expect(delegated()).toBe(true)
      expect(messageText(harness)).toContain('later parent answer')
    } finally {
      releaseLate.resolve(undefined)
      await first
    }
  })

  it('settles an initially cancelled prompt after its output without waiting for a later summary', async () => {
    const script: StreamChunk[][] = []
    harness = await makeBridgeHarness({ script })
    const ctx = harness.ctx
    const delegated = await installDelegationTool(ctx)
    const ref = await harness.attachments!.saveImage({ data: Uint8Array.of(6), mediaType: 'image/png' })
    ctx.tools.register(defineContentToolFixture({
      name: 'continue_stream', description: 'Continue the interrupted response.', parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'continue until cancelled' }]),
    }))
    // Interrupted streams retain only text/reasoning, so a completed step supplies the queued image.
    script.push([
      { type: 'block-start', index: 1, blockType: 'image' },
      { type: 'block-end', index: 1, block: { type: 'image', attachment: ref } },
      ...toolCallResponse('continue-stream', 'continue_stream', {}),
    ], textResponse('late autonomous answer'), toolCallResponse('delegate-again', 'delegate_again', {}),
    textResponse('later child answer'), textResponse('later parent answer'))
    const streaming = Promise.withResolvers<undefined>()
    const cleanupStarted = Promise.withResolvers<undefined>()
    const releaseCleanup = Promise.withResolvers<undefined>()
    const reading = Promise.withResolvers<undefined>()
    const releaseImage = Promise.withResolvers<undefined>()
    const lateStarted = Promise.withResolvers<undefined>()
    const releaseLate = Promise.withResolvers<undefined>()
    harness.attachments!.beforeRead = () => {
      reading.resolve(undefined)
      return releaseImage.promise
    }
    const stream = harness.adapter.stream.bind(harness.adapter)
    vi.spyOn(harness.adapter, 'stream').mockImplementation(async function* (options) {
      const prompt = options.messages.at(-1)?.content
      if (prompt?.some(block => block.type === 'text' && block.text === 'continue until cancelled')) {
        const signal = options.signal
        if (signal === undefined) throw new Error('interrupted stream requires a signal')
        try {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: 'partial' }
          streaming.resolve(undefined)
          await new Promise<void>((_resolve, reject) => {
            if (signal.aborted) {
              reject(new Error('aborted'))
              return
            }
            signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
          })
        } finally {
          cleanupStarted.resolve(undefined)
          await releaseCleanup.promise
        }
        return
      }
      if (prompt?.some(block => block.type === 'text' && block.text === 'late child result')) {
        lateStarted.resolve(undefined)
        await releaseLate.promise
      }
      yield* stream(options)
    })
    const sessionId = await newSession(harness)
    const parent = ctx.agents.get(SessionId(sessionId))!
    let result: { stopReason: string } | undefined
    const first = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'interrupted image' }] })
      .then((value) => { result = value; return value })
    try {
      await streaming.promise
      await harness.client.cancel({ sessionId })
      await cleanupStarted.promise
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'late child result' }], source: { kind: 'test' } }))
      expect(result).toBeUndefined()
      releaseCleanup.resolve(undefined)
      await Promise.all([reading.promise, lateStarted.promise])
      await setImmediate()
      expect(result).toBeUndefined()
      expect(messageText(harness)).toBe('')
      releaseImage.resolve(undefined)
      await vi.waitFor(() => { expect(result).toEqual({ stopReason: 'cancelled' }) })
      expect(parent.status).toBe('running')
      expect(harness.updates.filter(update => update.sessionUpdate === 'agent_message_chunk')).toEqual([
        expect.objectContaining({ content: { type: 'image', data: 'Bg==', mimeType: 'image/png' } }),
        expect.objectContaining({ content: { type: 'text', text: 'partial' } }),
      ])
      releaseLate.resolve(undefined)
      await parent.whenIdle()
      await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'delegate again' }] }))
        .resolves.toEqual({ stopReason: 'end_turn' })
      expect(delegated()).toBe(true)
      expect(messageText(harness)).toContain('later parent answer')
    } finally {
      releaseCleanup.resolve(undefined)
      releaseImage.resolve(undefined)
      releaseLate.resolve(undefined)
      await first
      await parent.whenIdle()
    }
  })

  it('waits for cancelled maintenance cleanup without following its later summary', async () => {
    harness = await makeBridgeHarness({ script: [
      textResponse('late autonomous answer'),
      toolCallResponse('delegate-again', 'delegate_again', {}),
      textResponse('later child answer'), textResponse('later parent answer'),
    ] })
    const ctx = harness.ctx
    const delegated = await installDelegationTool(ctx)
    const sessionId = await newSession(harness)
    const parent = ctx.agents.get(SessionId(sessionId))!
    const queued = Promise.withResolvers<undefined>()
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent === parent && message.content.some(block => block.type === 'text' && block.text === 'queued prompt')) {
        queued.resolve(undefined)
      }
    })
    const cleanupStarted = Promise.withResolvers<undefined>()
    const releaseCleanup = Promise.withResolvers<undefined>()
    const lateStarted = Promise.withResolvers<undefined>()
    const releaseLate = Promise.withResolvers<undefined>()
    const stream = harness.adapter.stream.bind(harness.adapter)
    vi.spyOn(harness.adapter, 'stream').mockImplementation(async function* (options) {
      if (options.messages.at(-1)?.content.some(block => block.type === 'text' && block.text === 'late child result')) {
        lateStarted.resolve(undefined)
        await releaseLate.promise
      }
      yield* stream(options)
    })
    const maintenance = parent.runMaintenance(async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      cleanupStarted.resolve(undefined)
      await releaseCleanup.promise
    })
    let result: { stopReason: string } | undefined
    const first = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'queued prompt' }] })
      .then((value) => { result = value; return value })
    try {
      await queued.promise
      await harness.client.cancel({ sessionId })
      await cleanupStarted.promise
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'late child result' }], source: { kind: 'test' } }))
      await setImmediate()
      expect(parent.status).toBe('idle')
      expect(result).toBeUndefined()
      releaseCleanup.resolve(undefined)
      await lateStarted.promise
      await maintenance
      await vi.waitFor(() => { expect(result).toEqual({ stopReason: 'cancelled' }) })
      expect(parent.status).toBe('running')
      releaseLate.resolve(undefined)
      await parent.whenIdle()
      await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'delegate again' }] }))
        .resolves.toEqual({ stopReason: 'end_turn' })
      expect(delegated()).toBe(true)
      expect(messageText(harness)).toContain('later parent answer')
    } finally {
      releaseCleanup.resolve(undefined)
      releaseLate.resolve(undefined)
      await maintenance
      await first
      await parent.whenIdle()
    }
  })

  it.each([false, true])('waits for the later summary output and reports its delivery failure (%s)', async (fail) => {
    const script: StreamChunk[][] = [textResponse('waiting')]
    harness = await makeBridgeHarness({ script })
    const ref = await harness.attachments!.saveImage({ data: Uint8Array.of(4), mediaType: 'image/png' })
    script.push([
      { type: 'block-start', index: 0, blockType: 'image' },
      { type: 'block-end', index: 0, block: { type: 'image', attachment: ref } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const sessionId = await newSession(harness)
    const parent = harness.ctx.agents.get(SessionId(sessionId))!
    const reading = Promise.withResolvers<undefined>()
    const delivery = Promise.withResolvers<undefined>()
    harness.attachments!.beforeRead = async () => {
      reading.resolve(undefined)
      await delivery.promise
      if (fail) throw new Error('summary image unavailable')
    }
    const waitForChildren = vi.fn().mockImplementationOnce(() => {
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'child result' }], source: { kind: 'test' } }))
      return Promise.resolve(true)
    }).mockResolvedValue(false)
    harness.ctx.provide('subagents', { waitForChildren, drainDescendants: vi.fn() } as never)
    let settled = false
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'delegate' }] })
    const observed = prompt.then(() => { settled = true }, () => { settled = true })
    await reading.promise
    expect(settled).toBe(false)
    delivery.resolve(undefined)
    if (fail) await expect(prompt).rejects.toThrow('assistant output delivery failed')
    else await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' })
    await observed
  })

  it('includes root work started during output draining and permits the next prompt to delegate', async () => {
    const script: StreamChunk[][] = []
    harness = await makeBridgeHarness({ script })
    const ctx = harness.ctx
    const delegated = await installDelegationTool(ctx)
    const ref = await harness.attachments!.saveImage({ data: Uint8Array.of(5), mediaType: 'image/png' })
    script.push([
      { type: 'block-start', index: 0, blockType: 'image' },
      { type: 'block-end', index: 0, block: { type: 'image', attachment: ref } },
      { type: 'finish', reason: { kind: 'stop' } },
    ], textResponse('late autonomous answer'), toolCallResponse('delegate-again', 'delegate_again', {}),
    textResponse('later child answer'), textResponse('later parent answer'))
    const reading = Promise.withResolvers<undefined>()
    const releaseImage = Promise.withResolvers<undefined>()
    harness.attachments!.beforeRead = () => {
      reading.resolve(undefined)
      return releaseImage.promise
    }
    const sessionId = await newSession(harness)
    const parent = ctx.agents.get(SessionId(sessionId))!
    const noChildren = Promise.withResolvers<undefined>()
    vi.spyOn(ctx.subagents, 'waitForChildren').mockImplementationOnce(() => {
      noChildren.resolve(undefined)
      return Promise.resolve(false)
    })
    const lateStarted = Promise.withResolvers<undefined>()
    const releaseLate = Promise.withResolvers<undefined>()
    const stream = harness.adapter.stream.bind(harness.adapter)
    vi.spyOn(harness.adapter, 'stream').mockImplementation(async function* (options) {
      if (options.messages.at(-1)?.content.some(block => block.type === 'text' && block.text === 'late autonomous turn')) {
        lateStarted.resolve(undefined)
        await releaseLate.promise
      }
      yield* stream(options)
    })
    let result: { stopReason: string } | undefined
    const first = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'render image' }] })
      .then((value) => { result = value; return value })
    try {
      await Promise.all([reading.promise, noChildren.promise])
      await setImmediate()
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'late autonomous turn' }], source: { kind: 'test' } }))
      await lateStarted.promise
      releaseImage.resolve(undefined)
      await setImmediate()
      expect(result).toBeUndefined()
      expect(parent.status).toBe('running')
      releaseLate.resolve(undefined)
      await expect(first).resolves.toEqual({ stopReason: 'end_turn' })
      expect(messageText(harness)).toContain('late autonomous answer')
      await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'delegate again' }] }))
        .resolves.toEqual({ stopReason: 'end_turn' })
      expect(delegated()).toBe(true)
    } finally {
      releaseImage.resolve(undefined)
      releaseLate.resolve(undefined)
      await first
    }
  })

  it('a failed turn with no retry still rejects', async () => {
    harness = await makeBridgeHarness({ script: [errorResponse('terminal boom')] })
    let offered = 0
    harness.ctx.on('agent/request-error', async () => { offered += 1 })
    const sessionId = await newSession(harness)
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }))
      .rejects.toThrow(/turn failed: terminal boom/)
    expect(offered).toBe(1)
  })

  it('a pre-step-rejected prompt settles instead of hanging', async () => {
    harness = await makeBridgeHarness({ script: [] })
    harness.ctx.on('agent/pre-step', async () => ({
      kind: 'reject' as const,
    }))
    const sessionId = await newSession(harness)
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
    // The rejected prompt closed a blocked turn without streaming anything.
    expect(messageText(harness)).toBe('')
  })

  it('cancels a prompt removed before its turn claims it', async () => {
    harness = await makeBridgeHarness({ script: [] })
    const sessionId = await newSession(harness)
    const dispose = harness.ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (message.source.kind === 'user') agent.inbox.remove(message.id)
    })

    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }))
      .resolves.toEqual({ stopReason: 'cancelled' })
    dispose()
  })

  it('rejects a prompt when pre-step fails inside its open turn', async () => {
    harness = await makeBridgeHarness({ script: [] })
    harness.ctx.on('agent/pre-step', async () => { throw new Error('pre-step exploded') })
    const sessionId = await newSession(harness)

    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }))
      .rejects.toThrow(/turn failed: pre-step exploded/)
  })
})
