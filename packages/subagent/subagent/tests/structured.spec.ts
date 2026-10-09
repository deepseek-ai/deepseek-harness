import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId, type ContentBlock, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type {} from '@deepseek-ai/dsh-system-prompt'
import SubagentRuntime, {
  type SubagentStartRequest,
  type SubagentActivation,
  type SubagentResult,
} from '@deepseek-ai/dsh-subagent'
import type { Config as ToolConfig, ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { defineContentToolFixture, RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { mountLocalActivations, startTestActivation } from './local-activation.ts'
import { queueHostSubagentPrompt } from '../src/internal.ts'
import {
  STRUCTURED_OUTPUT_INSTRUCTION,
  STRUCTURED_OUTPUT_TOOL,
} from '../src/structured.ts'

const testToolSignal = new AbortController().signal

type Script = ConstructorParameters<typeof MockAdapter>[0]

interface PtcRunRequestLike {
  bindings: { global: string; functions: Record<string, (args: unknown) => Promise<unknown>> }[]
}

interface SetupOptions {
  toolMode?: ToolConfig['mode']
  codeRun?: (request: PtcRunRequestLike) => Promise<{ logs: never[]; value?: unknown }>
}

const SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: { answer: { type: 'number' }, note: { type: 'string' } },
  required: ['answer'],
}

/**
 * Real loop and local preparation isolate activation-scoped structured output.
 */
async function setup(script: Script, options: SetupOptions = {}) {
  const ctx = new Context()
  const adapter = new MockAdapter(script)
  await mountAgentLoopTestDependencies(ctx, {
    tools: { mode: options.toolMode ?? 'native' },
  })
  if (options.toolMode === 'ptc') {
    ctx.provide('ptcRuntime', {
      language: 'typescript',
      isolation: 'test',
      resolve: (request: import('@deepseek-ai/dsh-ptc-runtime').PtcRunRequest) => ({ ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: 120_000 }),
      run: options.codeRun ?? (() => Promise.resolve({ logs: [] })),
    } as never)
  }
  await mountLocalActivations(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  const disposeProvider = ctx.subagents.registerProvider({
    name: 'spawn',
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: false, persona: false },
    inheritsParentContext: false,
    prepareContinuable: () => Promise.resolve({}),
  })
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent, adapter, disposeProvider }
}

function structuredRequest(parent: SubagentStartRequest['parent'], extra?: Partial<SubagentStartRequest>): SubagentStartRequest {
  return {
    label: 'produce the answer',
    prompt: [{ type: 'text', text: 'produce the answer' }],
    parent,
    signal: new AbortController().signal,
    outputSchema: SCHEMA,
    ...extra,
  }
}

/** The tool names of one recorded model request. */
function toolNames(request: GenerateOptions): string[] {
  return (request.tools ?? []).map(tool => tool.name)
}

/** Text of a loop-built request's leading system message; `''` when the request has none. */
function requestSystem(request: GenerateOptions): string {
  const head = request.messages[0]
  if (head?.role !== 'system') return ''
  return head.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

function deliverInput(
  ctx: Context,
  parent: SubagentStartRequest['parent'],
  childId: SessionId,
  delivery: 'steer' | 'queue',
) {
  const content: ContentBlock[] = [{ type: 'text', text: 'Correction: submit answer 42 instead.' }]
  return delivery === 'steer'
    ? ctx.subagents.sendMessage(parent, childId, content, { signal: testToolSignal })
    : queueHostSubagentPrompt(ctx.subagents, parent, childId, content, { kind: 'user' }, testToolSignal)
}

describe('in-process structured output', () => {
  it.each(['steer', 'queue'] as const)('consumes accepted %s input before committing a structured result', async (delivery) => {
    const { ctx, parent, adapter } = await setup([
      toolCallResponse('before-input', STRUCTURED_OUTPUT_TOOL, { answer: 1 }),
      ...delivery === 'queue' ? [textResponse('Ready for the queued correction.')] : [],
      toolCallResponse('after-input', STRUCTURED_OUTPUT_TOOL, { answer: 42 }),
    ])
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.callId === 'before-input') {
        entered.resolve(undefined)
        await release.promise
      }
      return next()
    })
    const run = await startTestActivation(ctx, 'spawn', structuredRequest(parent))
    try {
      await entered.promise
      const messageId = await deliverInput(ctx, parent, run.childId, delivery)
      const pending = delivery === 'steer' ? run.localAgent.inbox.nextStep : run.localAgent.inbox.nextTurn
      expect(pending.some(message => message.id === messageId)).toBe(true)
      release.resolve(undefined)

      await expect(run.result).resolves.toMatchObject({ stopReason: 'completed', structured: { answer: 42 } })
      const events = run.localAgent.session.snapshotEvents()
      const first = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'before-input')
      expect(first?.type === 'tool/result' && first.data.message.isError).toBe(true)
      expect(events.some(event => event.type === 'user/message' && event.data.id === messageId)).toBe(true)
      expect(JSON.stringify(adapter.requests.at(-1)?.messages)).toContain('Correction: submit answer 42 instead.')
    } finally {
      release.resolve(undefined)
      await run.dispose()
    }
  })

  it.each([
    { toolMode: 'native', blocked: false },
    { toolMode: 'native', blocked: true },
    { toolMode: 'ptc', blocked: false },
    { toolMode: 'ptc', blocked: true },
  ] as const)('closes input through $toolMode result policy and reopens only after rejection ($blocked)', async ({ toolMode, blocked }) => {
    const { ctx, parent } = await setup(['hang'], {
      toolMode,
      codeRun: async (request) => {
        const capture = request.bindings.at(0)?.functions[STRUCTURED_OUTPUT_TOOL]
        if (capture === undefined) throw new Error('structured_output binding missing')
        await capture({ answer: 42 })
        return { logs: [], value: 'captured' }
      },
    })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const toolName = toolMode === 'native' ? STRUCTURED_OUTPUT_TOOL : RUN_CODE_NAME
    ctx.on('tools/post-execute', async (exec, _result, next) => {
      if (exec.name !== toolName) return next()
      entered.resolve(undefined)
      await release.promise
      return blocked ? { kind: 'block', feedback: [{ type: 'text', text: 'Result policy rejected capture.' }] } : next()
    })
    const run = await startTestActivation(ctx, 'spawn', structuredRequest(parent))
    const execution = ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('capture'),
      name: toolName,
      arguments: toolMode === 'native'
        ? { answer: 42 }
        : { code: 'return await tools.structured_output({ answer: 42 })', description: 'Capture answer' },
      agent: run.localAgent,
    })
    try {
      await entered.promise
      for (const delivery of ['steer', 'queue'] as const) {
        await expect(deliverInput(ctx, parent, run.childId, delivery)).rejects.toMatchObject({ code: 'INPUT_CLOSED' })
      }
      release.resolve(undefined)
      expect((await execution).isError).toBe(blocked)
      for (const delivery of ['steer', 'queue'] as const) {
        const input = deliverInput(ctx, parent, run.childId, delivery)
        if (blocked) await expect(input).resolves.toEqual(expect.any(String))
        else await expect(input).rejects.toMatchObject({ code: 'INPUT_CLOSED' })
      }
    } finally {
      release.resolve(undefined)
      await execution
      await run.dispose()
    }
    expect((await run.result).structured).toEqual(blocked ? undefined : { answer: 42 })
  })

  it('captures a valid structured_output call and surfaces result.structured', async () => {
    const { ctx, parent } = await setup([
      toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 42, note: 'done' }),
    ])
    let acknowledgement: unknown
    ctx.on('tools/result', (exec, toolResult) => {
      if (exec.name === STRUCTURED_OUTPUT_TOOL && !toolResult.isError) acknowledgement = toolResult.value
    })
    const run = await startTestActivation(ctx, 'spawn', structuredRequest(parent))
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.structured).toEqual({ answer: 42, note: 'done' })
    expect(acknowledgement).toEqual({ recorded: true })
    await run.dispose()
  })

  it('stops the turn after a successful capture — no extra model step is spent', async () => {
    const { ctx, parent, adapter } = await setup([
      toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 1 }),
      textResponse('MUST NOT BE CONSUMED'),
    ])
    const run = await startTestActivation(ctx, 'spawn', structuredRequest(parent))
    await run.result
    // The structured tool marks its successful result as turn-concluding.
    expect(adapter.requests.length).toBe(1)
    await run.dispose()
  })

  it('denies tool calls that FOLLOW the capture in the same response — terminal means terminal', async () => {
    // One model response carrying structured_output FIRST and a side-effecting
    // call after it: the continuation veto only fires at step end, so without
    // the pre-execute deny the trailing call would still run after the final
    // answer was accepted.
    const response = [
      ...toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 5 }).slice(0, -2),
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('c2'), name: 'side_effect', arguments: '{}' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] as Script[number]
    const { ctx, parent } = await setup([response])
    let sideEffectRan = false
    ctx.tools.register(defineContentToolFixture({
      name: 'side_effect',
      description: 'probe',
      parameters: {},
      execute(): Promise<ContentBlock[]> {
        sideEffectRan = true
        return Promise.resolve([{ type: 'text', text: 'ran' }])
      },
    }))
    const run = await startTestActivation(ctx, 'spawn', structuredRequest(parent))
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.structured).toEqual({ answer: 5 })
    // The deny skipped dispatch entirely: the probe body never ran.
    expect(sideEffectRan).toBe(false)
    await run.dispose()
  })

  it('a later prepended pre-execute listener cannot resurrect dispatch after capture', async () => {
    const response = [
      ...toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 5 }).slice(0, -2),
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('c2'), name: 'side_effect', arguments: '{}' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] as Script[number]
    const { ctx, parent } = await setup([response])
    let sideEffectRan = false
    ctx.tools.register(defineContentToolFixture({
      name: 'side_effect',
      description: 'probe',
      parameters: {},
      execute(): Promise<ContentBlock[]> {
        sideEffectRan = true
        return Promise.resolve([{ type: 'text', text: 'ran' }])
      },
    }))
    const run = await startTestActivation(ctx, 'spawn', structuredRequest(parent))
    // Registered after the child and prepended: this listener returns allow
    // after every downstream pre-execute decision. The service-owned guard
    // runs after the waterfall and can only deny, so the body still cannot run.
    ctx.on('tools/pre-execute', async (_exec, next) => {
      await next()
      return { kind: 'allow' as const }
    }, { prepend: true })

    const result = await run.result
    expect(result.structured).toEqual({ answer: 5 })
    expect(sideEffectRan).toBe(false)
    const child = run.localAgent
    const sideEffectResult = child?.session.snapshotEvents().find(event =>
      event.type === 'tool/result' && event.data.message.source.callId === 'c2')
    expect(sideEffectResult?.type === 'tool/result' && sideEffectResult.data.message.isError).toBe(true)
    await run.dispose()
  })

  it('leaves tool calls that PRECEDE the capture in the same response untouched', async () => {
    const response = [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('c1'), name: 'side_effect', arguments: '{}' } },
      ...toolCallResponse('c2', STRUCTURED_OUTPUT_TOOL, { answer: 6 }).map(chunk =>
        'index' in chunk ? { ...chunk, index: 1 } : chunk),
    ] as Script[number]
    const { ctx, parent } = await setup([response])
    let sideEffectRan = false
    ctx.tools.register(defineContentToolFixture({
      name: 'side_effect',
      description: 'probe',
      parameters: {},
      execute(): Promise<ContentBlock[]> {
        sideEffectRan = true
        return Promise.resolve([{ type: 'text', text: 'ran' }])
      },
    }))
    const run = await startTestActivation(ctx, 'spawn', structuredRequest(parent))
    const result = await run.result
    // The call ran BEFORE captured was set: the deny gate only guards the
    // window after the terminal answer landed.
    expect(sideEffectRan).toBe(true)
    expect(result.structured).toEqual({ answer: 6 })
    await run.dispose()
  })

  it('an invalid call gets an INVALID_ARGS isError result and the model retries in-turn', async () => {
    const { ctx, parent } = await setup([
      toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 'not-a-number' }),
      toolCallResponse('c2', STRUCTURED_OUTPUT_TOOL, { answer: 7 }),
    ])
    const run = await startTestActivation(ctx, 'spawn', structuredRequest(parent))
    const result = await run.result
    expect(result.structured).toEqual({ answer: 7 })
    expect(result.stopReason).toBe('completed')
    // The child's log carries the isError tool/result for the invalid call.
    const child = run.localAgent
    const results = child.session.snapshotEvents().filter(e => e.type === 'tool/result')
    expect(results.length).toBe(2)
    expect(results[0]!.data.message.isError).toBe(true)
    await run.dispose()
  })

  it('a clean finish without a capture is an immediate error to the parent — deliberately NO re-prompt', async () => {
    const { ctx, parent, adapter } = await setup([
      textResponse('here is my answer in prose'),
      textResponse('MUST NOT BE CONSUMED'),
    ])
    const run = await startTestActivation(ctx, 'spawn', structuredRequest(parent))
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.structured).toBeUndefined()
    // Exactly one model request and one caller-supplied user message: no nudge turn exists.
    expect(adapter.requests.length).toBe(1)
    const child = run.localAgent
    expect(child.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source.kind !== 'runtime-context').length).toBe(1)
    await run.dispose()
  })

  it('an errored child keeps its honest error result (no capture expected)', async () => {
    // Script exhaustion on the first call → the child turn errors.
    const { ctx, parent, adapter } = await setup([])
    const run = await startTestActivation(ctx, 'spawn', structuredRequest(parent))
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(adapter.requests.length).toBe(1)
    await run.dispose()
  })

  it('disposing a running structured child settles aborted without requiring a capture', async () => {
    const { ctx, parent } = await setup(['hang'])
    const run = await startTestActivation(ctx, 'spawn', structuredRequest(parent))
    await run.dispose()
    expect((await run.result).stopReason).toBe('aborted')
  })

  it('keeps descendant messages and completion notices before accepting the final structured result', async () => {
    const { ctx, parent } = await setup([
      toolCallResponse('spawn-child', 'start_descendant', {}),
      toolCallResponse('too-early', STRUCTURED_OUTPUT_TOOL, { answer: 1 }),
      toolCallResponse('finish-child', 'finish_descendant', {}),
      toolCallResponse('final-capture', STRUCTURED_OUTPUT_TOOL, { answer: 42 }),
    ])
    ctx.llm.registerAdapter(['descendant'], new MockAdapter(['hang']))
    let descendant: SubagentActivation | undefined
    ctx.tools.register(defineContentToolFixture({
      name: 'start_descendant', description: 'Start delegated work', parameters: {},
      async execute(_args, exec): Promise<ContentBlock[]> {
        if (exec.agent === undefined) throw new Error('expected the structured parent')
        descendant = await ctx.subagents.startActivation({
          provider: 'spawn', label: 'Nested work', signal: testToolSignal, delivery: 'parent',
          request: {
            parent: exec.agent, prompt: [{ type: 'text', text: 'Work until released' }],
            agentOptions: { provider: 'descendant', model: 'mock' },
          },
        })
        return [{ type: 'text', text: 'Child accepted' }]
      },
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'finish_descendant', description: 'Return delegated work', parameters: {},
      async execute(_args, exec): Promise<ContentBlock[]> {
        if (descendant === undefined || exec.agent === undefined) throw new Error('expected resident child and parent')
        const sender = ctx.agents.get(descendant.childId)
        if (sender === undefined) throw new Error('expected a resident descendant')
        await ctx.subagents.sendMessage(sender, exec.agent.id, [{ type: 'text', text: 'Descendant result reached parent' }], {
          signal: testToolSignal,
        })
        await descendant.dispose()
        return [{ type: 'text', text: 'Child released' }]
      },
    }))
    const activation = await startTestActivation(ctx, 'spawn', structuredRequest(parent))
    try {
      await expect(activation.result).resolves.toMatchObject({ stopReason: 'completed', structured: { answer: 42 } })
      const events = activation.localAgent.session.snapshotEvents()
      const captures = events.filter(event => event.type === 'tool/result')
        .map(event => event.data.message)
        .filter(block => block.toolCallId === 'too-early' || block.toolCallId === 'final-capture')
      expect(captures).toHaveLength(2)
      expect(captures[0]?.isError).toBe(true)
      expect(JSON.stringify(captures[0]?.content)).toContain('Wait for all delegated child tasks to finish')
      expect(captures[1]?.isError).not.toBe(true)
      const messages = events.filter(event => event.type === 'user/message')
      expect(JSON.stringify(messages)).toContain('Descendant result reached parent')
      expect(messages.some(event => event.data.source.kind === 'subagent-settled')).toBe(true)
    } finally {
      await descendant?.dispose()
      await activation.dispose()
    }
  })

  it('waits through interim idle while delegated work supplies the final structured answer', async () => {
    const { ctx, parent } = await setup([
      toolCallResponse('delegate', 'delegate_answer', {}),
      textResponse('Waiting for the delegated answer.'),
      toolCallResponse('capture', STRUCTURED_OUTPUT_TOOL, { answer: 42 }),
    ])
    const delegated = Promise.withResolvers<SubagentResult>()
    ctx.subagents.registerProvider({
      name: 'delayed-answer',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: () => Promise.resolve({
        id: SessionId('delegated-answer'),
        result: delegated.promise,
        dispose: () => { delegated.resolve({ output: [], stopReason: 'aborted' }); return Promise.resolve() },
      }),
    })
    ctx.tools.register(defineContentToolFixture({
      name: 'delegate_answer', description: 'Delegate answer computation', parameters: {},
      async execute(_args, exec): Promise<ContentBlock[]> {
        if (exec.agent === undefined) throw new Error('expected the structured parent')
        await ctx.subagents.startActivation({
          provider: 'delayed-answer', label: 'Compute answer', signal: testToolSignal, delivery: 'parent',
          request: { parent: exec.agent, prompt: [{ type: 'text', text: 'Compute the answer' }] },
        })
        return [{ type: 'text', text: 'Answer computation accepted' }]
      },
    }))
    const activation = await startTestActivation(ctx, 'spawn', structuredRequest(parent))
    let resultReady = false
    void activation.result.then(() => { resultReady = true })
    try {
      await activation.localAgent.whenIdle()
      await Promise.resolve()
      expect(resultReady).toBe(false)
      delegated.resolve({ output: [{ type: 'text', text: 'The answer is 42.' }], stopReason: 'completed' })
      await expect(activation.result).resolves.toMatchObject({ stopReason: 'completed', structured: { answer: 42 } })
    } finally {
      await activation.dispose()
    }
  })

  it('rejects new input after capture until closure, then cold-resumes without the schema', async () => {
    const { ctx, parent, adapter } = await setup([
      toolCallResponse('capture', STRUCTURED_OUTPUT_TOOL, { answer: 42 }),
      textResponse('ordinary resumed answer'),
    ])
    await ctx.plugin(TestSessionQuery)
    const flushing = Promise.withResolvers<undefined>()
    const releaseFlush = Promise.withResolvers<undefined>()
    let held = false
    ctx.on('session/flush', async (session) => {
      if (session.header.parentSession === undefined || held) return
      held = true
      flushing.resolve(undefined)
      await releaseFlush.promise
    })
    const run = await startTestActivation(ctx, 'spawn', structuredRequest(parent))
    try {
      await flushing.promise
      await expect(ctx.subagents.sendMessage(parent, run.childId, [{ type: 'text', text: 'too early' }], {
        signal: testToolSignal,
      })).rejects.toMatchObject({ code: 'INPUT_CLOSED' })
    } finally {
      releaseFlush.resolve(undefined)
      await run.dispose()
    }
    expect((await run.result).structured).toEqual({ answer: 42 })
    await ctx.subagents.sendMessage(parent, run.childId, [{ type: 'text', text: 'continue normally' }], {
      signal: testToolSignal,
    })
    await ctx.subagents.waitForChildren(parent)
    expect(adapter.requests).toHaveLength(2)
    expect(toolNames(adapter.requests[1]!)).not.toContain(STRUCTURED_OUTPUT_TOOL)
  })

  it('rejects a schema outside the subset loud, before any child exists', async () => {
    const { ctx, parent } = await setup([])
    await expect(startTestActivation(ctx, 'spawn', structuredRequest(parent, {
      outputSchema: { type: 'object', oneOf: [] },
    }))).rejects.toThrow(/unsupported JSON schema/)
    expect(ctx.agents.get(SessionId('parent'))).toBeDefined()
  })

  it('a schema carrying non-JSON values fails as JsonSchemaError at the validation boundary', async () => {
    const { ctx, parent } = await setup([])
    const schema: ObjectJsonSchema = { type: 'object' }
    Object.defineProperty(schema, 'default', { value: () => {}, enumerable: true })
    await expect(startTestActivation(ctx, 'spawn', structuredRequest(parent, {
      outputSchema: schema,
    }))).rejects.toThrow(/unsupported JSON schema.*annotation must be lossless JSON data/)
  })

  it('a post-execute BLOCK on the capture call denies the capture: log and result agree on failure', async () => {
    const { ctx, parent, adapter } = await setup([
      toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 7 }),
      textResponse('continues after the blocked capture'),
    ])
    // A PostToolUse-style hook turns the tool body's provisional success into
    // the authoritative final error observed by the commit notification.
    ctx.on('tools/post-execute', (exec, _result, next) => {
      if (exec.name === STRUCTURED_OUTPUT_TOOL) {
        return Promise.resolve({ kind: 'block' as const, feedback: [{ type: 'text' as const, text: 'capture rejected by hook' }] })
      }
      return next()
    })
    const run = await startTestActivation(ctx, 'spawn', structuredRequest(parent))
    const result = await run.result
    // No capture was committed: the run reports the schema shortfall...
    expect(result.structured).toBeUndefined()
    expect(result.stopReason).toBe('error')
    // ...the logged tool result is the blocked isError with the feedback...
    const child = run.localAgent
    const results = child.session.snapshotEvents().filter(e => e.type === 'tool/result')
    expect(results[0]!.data.message.isError).toBe(true)
    expect(JSON.stringify(results[0]!.data.message.content)).toContain('capture rejected by hook')
    // ...and the turn CONTINUED past the blocked call (no captured veto):
    // the model got to react to the failure with a second step.
    expect(adapter.requests.length).toBe(2)
    await run.dispose()
  })

  it('a post-execute accept-with-replacement still commits the capture', async () => {
    const { ctx, parent } = await setup([
      toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 8 }),
    ])
    ctx.on('tools/post-execute', (exec, _result, next) => {
      if (exec.name === STRUCTURED_OUTPUT_TOOL) {
        return Promise.resolve({ kind: 'accept' as const, content: [{ type: 'text' as const, text: 'recorded (rewritten)' }] })
      }
      return next()
    })
    const run = await startTestActivation(ctx, 'spawn', structuredRequest(parent))
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.structured).toEqual({ answer: 8 })
    await run.dispose()
  })

  it('commits only after a later prepended post-execute wrapper returns the authoritative result', async () => {
    const { ctx, parent } = await setup([
      toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 8 }),
      textResponse('capture was rejected'),
    ])
    const run = await startTestActivation(ctx, 'spawn', structuredRequest(parent))
    // Registered after attachment and prepended, so it wraps every listener
    // the child installed. It delegates first, then converts the apparent
    // capture success into the pipeline's authoritative failure.
    ctx.on('tools/post-execute', async (exec, _result, next) => {
      const downstream = await next()
      if (exec.name !== STRUCTURED_OUTPUT_TOOL) return downstream
      return { kind: 'block' as const, feedback: [{ type: 'text' as const, text: 'rejected after downstream' }] }
    }, { prepend: true })

    const result = await run.result
    expect(result.structured).toBeUndefined()
    expect(result.stopReason).toBe('error')
    const child = run.localAgent
    const captureResult = child?.session.snapshotEvents().find(event =>
      event.type === 'tool/result' && event.data.message.source.callId === 'c1')
    expect(captureResult?.type === 'tool/result' && captureResult.data.message.isError).toBe(true)
    await run.dispose()
  })

  it('appends the structured instruction to the child REQUEST\'s system text (base prompt preserved)', async () => {
    const { ctx, parent, adapter } = await setup([toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 1 })])
    // A context-wide section stands in for the deployment persona: the
    // instruction must APPEND to the other scoped and global sections, not
    // replace them (AgentOptions has no prompt field — the instruction is an
    // ordinary child-scoped prompt registration).
    ctx.systemPrompt.section({ name: 'test:persona', order: 10, text: 'You are a counter.' })
    const run = await startTestActivation(ctx, 'spawn', structuredRequest(parent))
    await run.result
    const childSystem = requestSystem(adapter.requests.at(-1)!)
    expect(childSystem).toContain('You are a counter.')
    expect(childSystem.endsWith(STRUCTURED_OUTPUT_INSTRUCTION)).toBe(true)
    expect(childSystem.indexOf(STRUCTURED_OUTPUT_INSTRUCTION)).toBeGreaterThan(0)
    await run.dispose()
  })

  it('keeps pure PTC mode at one wire tool and exposes structured capture through the SDK only', async () => {
    const { ctx, parent, adapter } = await setup([
      toolCallResponse('c1', RUN_CODE_NAME, { code: 'return await tools.structured_output({ answer: 12 })', description: 'Capture the structured answer' }),
    ], {
      toolMode: 'ptc',
      codeRun: async (request) => {
        const capture = request.bindings.at(0)?.functions[STRUCTURED_OUTPUT_TOOL]
        if (!capture) throw new Error('structured_output binding missing')
        await capture({ answer: 12 })
        return { logs: [], value: 'captured' }
      },
    })
    const run = await startTestActivation(ctx, 'spawn', structuredRequest(parent))

    const result = await run.result
    expect(result.structured).toEqual({ answer: 12 })
    const request = adapter.requests[0]!
    expect(toolNames(request)).toEqual([RUN_CODE_NAME])
    const system = requestSystem(request)
    expect(system).toContain('interface ToolArgsMap')
    expect(system).toContain('interface ToolOutputMap')
    expect(system).toContain('recorded: true;')
    expect(system).toContain('Promise<ToolOutputMap[K]>')
    expect(system).toContain(STRUCTURED_OUTPUT_INSTRUCTION)
    await run.dispose()
  })

  it('discards a nested capture when the enclosing run_code execution fails', async () => {
    const { ctx, parent, adapter } = await setup([
      toolCallResponse('c1', RUN_CODE_NAME, { code: 'await tools.structured_output({ answer: 12 }); throw new Error("boom")', description: 'Capture then fail the program' }),
      textResponse('outer code failed'),
    ], {
      toolMode: 'ptc',
      codeRun: async (request) => {
        const capture = request.bindings.at(0)?.functions[STRUCTURED_OUTPUT_TOOL]
        if (!capture) throw new Error('structured_output binding missing')
        await capture({ answer: 12 })
        return {
          logs: [],
          error: { kind: 'runtime', message: 'boom after capture' },
        } as never
      },
    })
    const run = await startTestActivation(ctx, 'spawn', structuredRequest(parent))

    const result = await run.result
    expect(result.structured).toBeUndefined()
    expect(result.stopReason).toBe('error')
    expect(adapter.requests).toHaveLength(2)
    const child = run.localAgent
    const outer = child.session.snapshotEvents().find(event =>
      event.type === 'tool/result' && event.data.message.source.callId === ToolCallId('c1'))
    expect(outer?.type === 'tool/result' && outer.data.message.isError).toBe(true)
    await run.dispose()
  })

  it('discards a nested capture when post-policy blocks the enclosing run_code result', async () => {
    const { ctx, parent, adapter } = await setup([
      toolCallResponse('c1', RUN_CODE_NAME, { code: 'return await tools.structured_output({ answer: 12 })', description: 'Capture the structured answer' }),
      textResponse('outer code was blocked'),
    ], {
      toolMode: 'ptc',
      codeRun: async (request) => {
        const capture = request.bindings.at(0)?.functions[STRUCTURED_OUTPUT_TOOL]
        if (!capture) throw new Error('structured_output binding missing')
        await capture({ answer: 12 })
        return { logs: [], value: 'captured' }
      },
    })
    ctx.on('tools/post-execute', (exec, _result, next) => exec.name === RUN_CODE_NAME
      ? Promise.resolve({ kind: 'block' as const, feedback: [{ type: 'text' as const, text: 'outer blocked' }] })
      : next())
    const run = await startTestActivation(ctx, 'spawn', structuredRequest(parent))

    const result = await run.result
    expect(result.structured).toBeUndefined()
    expect(result.stopReason).toBe('error')
    expect(adapter.requests).toHaveLength(2)
    await run.dispose()
  })

  it('the instruction rides ONLY structured requests: appended for the child, absent for a plain agent', async () => {
    const { ctx, parent, adapter } = await setup([
      textResponse('parent answer'),
      toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 1 }),
    ])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    expect(requestSystem(adapter.requests[0]!)).not.toContain(STRUCTURED_OUTPUT_INSTRUCTION)
    const run = await startTestActivation(ctx, 'spawn', structuredRequest(parent))
    await run.result
    // The loop always assembles a base prompt (the harness identity section),
    // so the instruction APPENDS — never replaces.
    const childSystem = requestSystem(adapter.requests.at(-1)!)
    expect(childSystem.endsWith(STRUCTURED_OUTPUT_INSTRUCTION)).toBe(true)
    expect(childSystem.length).toBeGreaterThan(STRUCTURED_OUTPUT_INSTRUCTION.length)
    await run.dispose()
  })

  describe('scoped registration (each child owns its capture tool)', () => {
    it('a plain agent never sees the tool: nothing is registered globally at all', async () => {
      const { ctx, parent, adapter } = await setup([textResponse('parent answer')])
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
      await parent.whenIdle()
      // Scoped registration: the global view has no capture tool, ever.
      expect(ctx.tools.get(STRUCTURED_OUTPUT_TOOL)).toBeUndefined()
      expect(toolNames(adapter.requests[0]!)).not.toContain(STRUCTURED_OUTPUT_TOOL)
    })

    it('a structured child sees structured_output with ITS schema; a plain agent never sees the tool', async () => {
      const { ctx, parent, adapter } = await setup([
        // Parent turn (a plain agent): must NOT see the tool.
        textResponse('parent answer'),
        // Child turn: must see it, with the run's schema.
        toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 42 }),
      ])
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
      await parent.whenIdle()
      expect(toolNames(adapter.requests[0]!)).not.toContain(STRUCTURED_OUTPUT_TOOL)

      const run = await startTestActivation(ctx, 'spawn', structuredRequest(parent))
      await run.result
      const childRequest = adapter.requests[1]!
      expect(toolNames(childRequest)).toContain(STRUCTURED_OUTPUT_TOOL)
      const entry = childRequest.tools!.find(tool => tool.name === STRUCTURED_OUTPUT_TOOL)!
      expect(entry.parameters).toEqual(SCHEMA)
      await run.dispose()
    })

    it('two concurrent structured children each see their OWN schema', async () => {
      const otherSchema: ObjectJsonSchema = {
        type: 'object',
        properties: { verdict: { type: 'string', enum: ['real', 'bogus'] } },
        required: ['verdict'],
      }
      const { ctx, parent, adapter } = await setup([
        (options: GenerateOptions) => {
          // Answer with whatever schema this child was given — proves each
          // request carried the right one regardless of scheduling order.
          const entry = options.tools!.find(tool => tool.name === STRUCTURED_OUTPUT_TOOL)!
          const args = 'verdict' in (entry.parameters.properties as Record<string, unknown>)
            ? { verdict: 'real' }
            : { answer: 1 }
          return toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, args)
        },
        (options: GenerateOptions) => {
          const entry = options.tools!.find(tool => tool.name === STRUCTURED_OUTPUT_TOOL)!
          const args = 'verdict' in (entry.parameters.properties as Record<string, unknown>)
            ? { verdict: 'real' }
            : { answer: 1 }
          return toolCallResponse('c2', STRUCTURED_OUTPUT_TOOL, args)
        },
      ])
      const runA = await startTestActivation(ctx, 'spawn', structuredRequest(parent))
      const runB = await startTestActivation(ctx, 'spawn', structuredRequest(parent, { outputSchema: otherSchema }))
      const [a, b] = await Promise.all([runA.result, runB.result])
      expect(a.structured).toEqual({ answer: 1 })
      expect(b.structured).toEqual({ verdict: 'real' })
      const schemas = adapter.requests.map(request =>
        request.tools!.find(tool => tool.name === STRUCTURED_OUTPUT_TOOL)!.parameters)
      expect(schemas).toContainEqual(SCHEMA)
      expect(schemas).toContainEqual(otherSchema)
      await runA.dispose()
      await runB.dispose()
    })

    it('places the capture tool and instruction in their canonical orders', async () => {
      const { ctx, parent, adapter } = await setup([
        toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 7 }),
      ])
      // A global tool sorts lexicographically after structured_output, while a
      // global section after the final-output slot follows the capture instruction.
      ctx.tools.register(defineContentToolFixture({
        name: 'zz_probe',
        description: 'probe',
        parameters: {},
        execute: () => Promise.resolve([{ type: 'text', text: 'x' }]),
      }))
      ctx.systemPrompt.section({
        name: 'after-band',
        order: ctx.systemPrompt.getSectionOrder('STRUCTURED_OUTPUT') + 10,
        text: 'AFTER-BAND',
      })
      const run = await startTestActivation(ctx, 'spawn', structuredRequest(parent))
      await run.result
      const request = adapter.requests[0]!
      const names = toolNames(request)
      expect(names.indexOf(STRUCTURED_OUTPUT_TOOL)).toBeGreaterThanOrEqual(0)
      expect(names.indexOf(STRUCTURED_OUTPUT_TOOL)).toBeLessThan(names.indexOf('zz_probe'))
      const system = requestSystem(request)
      const instructionAt = system.indexOf(STRUCTURED_OUTPUT_INSTRUCTION)
      expect(instructionAt).toBeGreaterThanOrEqual(0)
      expect(system.indexOf('AFTER-BAND')).toBeGreaterThan(instructionAt)
      await run.dispose()
    })

    it('a non-structured agent request keeps tools ABSENT when it had none (no tools: [] materialized)', async () => {
      const { parent, adapter } = await setup([textResponse('plain')])
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }))
      await parent.whenIdle()
      const request = adapter.requests[0]!
      expect(request.tools).toBeUndefined()
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    it('registrations survive provider reload and are removed before result delivery', async () => {
      const { ctx, parent, disposeProvider } = await setup([
        toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 4 }),
      ])
      expect(ctx.tools.get(STRUCTURED_OUTPUT_TOOL)).toBeUndefined()
      const run = await startTestActivation(ctx, 'spawn', structuredRequest(parent))
      // A backend hot-reload mid-run must not unregister the capture tool out
      // from under the live child: the registration rides the CHILD's fiber.
      disposeProvider()
      const child = run.localAgent
      expect(ctx.tools.get(STRUCTURED_OUTPUT_TOOL, child)).toBeDefined()
      const result = await run.result
      expect(result.structured).toEqual({ answer: 4 })
      expect(ctx.agents.get(run.id)).toBeUndefined()
      await run.dispose()
      expect(ctx.tools.get(STRUCTURED_OUTPUT_TOOL, child)).toBeUndefined()
    })
  })

  it('a structured_output call from an agent WITHOUT a structured run is UNKNOWN_TOOL (the tool does not exist for it)', async () => {
    const { ctx, parent } = await setup([])
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: 'x' as never,
      name: STRUCTURED_OUTPUT_TOOL,
      arguments: { answer: 1 },
      agent: parent,
    })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('UNKNOWN_TOOL')
  })

  it('a structured_output call with NO calling agent at all is UNKNOWN_TOOL', async () => {
    const { ctx } = await setup([])
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: 'x' as never,
      name: STRUCTURED_OUTPUT_TOOL,
      arguments: { answer: 1 },
    })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('UNKNOWN_TOOL')
  })

  it('a failed execution stage is discarded and never promoted by a later call', async () => {
    const { ctx, parent } = await setup(['hang'])
    const run = await startTestActivation(ctx, 'spawn', structuredRequest(parent))
    // A prepended post-execute listener blocks the first capture without
    // delegating. The final-result notification discards that execution's
    // stage when it observes the error.
    let blocks = 1
    ctx.on('tools/post-execute', (exec, _result, next) => {
      if (exec.name === STRUCTURED_OUTPUT_TOOL && blocks > 0) {
        blocks -= 1
        return Promise.resolve({ kind: 'block' as const, feedback: [{ type: 'text' as const, text: 'rejected' }] })
      }
      return next()
    }, { prepend: true })
    const failed = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('c1'),
      name: STRUCTURED_OUTPUT_TOOL,
      arguments: { answer: 1 },
      agent: run.localAgent,
    })
    expect(failed.isError).toBe(true)
    const child = run.localAgent
    // Invalid calls must not commit a preceding execution's discarded value.
    const invalid = await ctx.tools.execute({
      signal: testToolSignal,
      callId: 'c2' as never,
      name: STRUCTURED_OUTPUT_TOOL,
      arguments: { answer: 'not-a-number' },
      agent: child,
    })
    expect(invalid.isError).toBe(true)
    // A fresh valid call still captures ITS OWN value.
    const valid = await ctx.tools.execute({
      signal: testToolSignal,
      callId: 'c3' as never,
      name: STRUCTURED_OUTPUT_TOOL,
      arguments: { answer: 9 },
      agent: child,
    })
    expect(valid.isError).toBeFalsy()
    await run.dispose()
    expect((await run.result).structured).toEqual({ answer: 9 })
  })

  it('reusing a failed execution\'s call id never promotes its discarded stage', async () => {
    const { ctx, parent } = await setup(['hang'])
    const run = await startTestActivation(ctx, 'spawn', structuredRequest(parent))
    // Block the first capture after its body stages a value. Its final error
    // discards that execution's stage.
    let blocks = 1
    ctx.on('tools/post-execute', (exec, _result, next) => {
      if (exec.name === STRUCTURED_OUTPUT_TOOL && blocks > 0) {
        blocks -= 1
        return Promise.resolve({ kind: 'block' as const, feedback: [{ type: 'text' as const, text: 'rejected' }] })
      }
      return next()
    }, { prepend: true })
    const failed = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('c1'),
      name: STRUCTURED_OUTPUT_TOOL,
      arguments: { answer: 1 },
      agent: run.localAgent,
    })
    expect(failed.isError).toBe(true)
    const child = run.localAgent
    // A SECOND capture call with the SAME call id whose body never stages
    // (invalid args throw before the stage): the discarded value must not ride
    // its acceptance.
    const reused = await ctx.tools.execute({
      signal: testToolSignal,
      callId: 'c1' as never,
      name: STRUCTURED_OUTPUT_TOOL,
      arguments: { answer: 'not-a-number' },
      agent: child,
    })
    expect(reused.isError).toBe(true)
    // Nothing was ever committed: a fresh valid call is still required.
    const valid = await ctx.tools.execute({
      signal: testToolSignal,
      callId: 'c1' as never,
      name: STRUCTURED_OUTPUT_TOOL,
      arguments: { answer: 5 },
      agent: child,
    })
    expect(valid.isError).toBeFalsy()
    await run.dispose()
    expect((await run.result).structured).toEqual({ answer: 5 })
  })

  it('a pre-execute deny with call-id reuse cannot promote another execution\'s stage', async () => {
    const { ctx, parent } = await setup(['hang'])
    const run = await startTestActivation(ctx, 'spawn', structuredRequest(parent))
    // Discard the first capture's stage via a final post-execute block.
    let blocks = 1
    ctx.on('tools/post-execute', (exec, _result, next) => {
      if (exec.name === STRUCTURED_OUTPUT_TOOL && blocks > 0) {
        blocks -= 1
        return Promise.resolve({ kind: 'block' as const, feedback: [{ type: 'text' as const, text: 'rejected' }] })
      }
      return next()
    }, { prepend: true })
    const failed = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('c1'),
      name: STRUCTURED_OUTPUT_TOOL,
      arguments: { answer: 1 },
      agent: run.localAgent,
    })
    expect(failed.isError).toBe(true)
    const child = run.localAgent
    // A prepended pre-execute deny skips the body, while the denied call still
    // reaches the final notification with the same adapter-minted call id.
    const offDeny = ctx.on('tools/pre-execute', (exec) => {
      if (exec.name === STRUCTURED_OUTPUT_TOOL) {
        return Promise.resolve({ kind: 'deny' as const, reason: 'outer veto' })
      }
      return undefined as never
    }, { prepend: true })
    const denied = await ctx.tools.execute({
      signal: testToolSignal,
      callId: 'c1' as never,
      name: STRUCTURED_OUTPUT_TOOL,
      arguments: { answer: 2 },
      agent: child,
    })
    expect(denied.isError).toBe(true)
    offDeny()
    // The discarded value was never promoted: a fresh valid call is required
    // (and succeeds, proving the runtime is not wedged).
    const valid = await ctx.tools.execute({
      signal: testToolSignal,
      callId: 'c1' as never,
      name: STRUCTURED_OUTPUT_TOOL,
      arguments: { answer: 5 },
      agent: child,
    })
    expect(valid.isError).toBeFalsy()
    await run.dispose()
    expect((await run.result).structured).toEqual({ answer: 5 })
  })
})
