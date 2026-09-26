/** Direct one-shot Agent driving, exact Session adoption, machine-readable projection, and exit mapping. */

import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type {
  Agent,
  AgentHandle,
  AssistantStreamFrame,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { LlmAttemptId, ToolCallId, createAssistantMessage, createToolResultMessage, type MessageId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Session, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { apply, Config } from '../src/index.ts'
import { internals } from '../src/runner-internals.ts'

const originalInternals = { ...internals }
afterEach(() => { Object.assign(internals, originalInternals) })

interface Script {
  before?(session: Session): void
  afterPrompt(session: Session, message: UserMessage, agent: Agent): Promise<void> | void
}

/** Observation stub returned by the `--session-id` query path. */
interface ObservationStub {
  header: { cwd?: string; origin?: string; parentSession?: string; agentPreset?: string }
  events: readonly { type: string; data: unknown }[]
  [Symbol.dispose](): void
}

/** Runner invocation options layered over the scripted Agent factory. */
interface BenchOptions {
  /** Provider-resolved cwd, which can differ from the harness process directory. */
  filesystemCwd?: string
  task?: string
  useStdin?: boolean
  readStdin?: () => Promise<string>
  sessionId?: string
  json?: boolean
  observe?: () => Promise<ObservationStub>
  /** Leave the query service unmounted to exercise the fail-loud path. */
  omitSessionQuery?: boolean
  /** Leave the persistence service unmounted to exercise the fail-loud path. */
  omitPersistence?: boolean
  /** Register a live Agent under `sessionId` before the runner starts. */
  prelive?: boolean
  /** Header facts for that pre-registered live Agent. */
  preliveMeta?: { cwd?: string; origin?: 'subagent'; agentPreset?: string }
  /** Run when the runner awaits idle, e.g. to append to the attached log. */
  onWhenIdle?: (agent: Agent) => void
}

const frameStates = new WeakMap<Agent, { attemptId: ReturnType<typeof LlmAttemptId>; revision: number; index: number }>()

function startFrames(agent: Agent, turn = 1, step = 1): void {
  const state = { attemptId: LlmAttemptId(`${agent.id}:test`), revision: 1, index: 0 }
  frameStates.set(agent, state)
  agent.ctx.emit('agent/assistant-stream', {
    agent,
    frame: {
      type: 'start', attemptId: state.attemptId, revision: state.revision, turn, step,
    },
  })
}

function emitChunk(agent: Agent, chunk: StreamChunk): void {
  const state = frameStates.get(agent)
  if (state === undefined) throw new Error('test Assistant frames have not started')
  const frame: AssistantStreamFrame = {
    type: 'chunk', attemptId: state.attemptId, revision: ++state.revision,
    index: state.index++, time: Date.now(), chunk,
  }
  agent.ctx.emit('agent/assistant-stream', { agent, frame })
}

function appendTurn(
  session: Session,
  turn: number,
  message: UserMessage,
  text: string | undefined,
  completed: boolean,
): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', message, { surfaceOp: 'append' })
  if (text !== undefined) {
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text }],
        source: { provider: 'test-provider', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' })
  }
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', {
    turn,
    reason: completed
      ? { kind: 'completed' }
      : { kind: 'aborted', reason: { kind: 'user' } },
  })
}

/** Append the preset-selection event owned by dsh-agent-preset-registry. */
function selectPreset(session: Session, agentPreset: string): void {
  const target = session as unknown as { append(type: string, data: unknown): void }
  target.append('agent-preset/selected', { agentPreset })
}

/** Mount the real registries around a small scripted Agent factory. */
async function bench(script: Script, options: BenchOptions = {}): Promise<{
  ctx: Context
  output(): { out: string; err: string; order: string[] }
  run(): Promise<{ code: number; out: string; err: string; order: string[] }>
}> {
  const ctx = new Context()
  if (options.filesystemCwd !== undefined) {
    const cwd = options.filesystemCwd
    ctx.provide('fs', {
      resolve: async () => ({ targetKey: cwd, displayPath: cwd }),
      processPath: () => cwd,
    } as never)
  }
  let out = ''
  let err = ''
  const order: string[] = []

  const mount = async (
    ownerCtx: Context,
    session: Session,
    createOptions: CreateAgentOptions | ResumeAgentOptions,
  ): Promise<Agent> => {
    const inbox = createInboxStub()
    let idle = Promise.resolve()
    const agent: Agent = {
      id: session.id,
      options: createOptions.agentOptions ?? {},
      session,
      inbox,
      status: 'idle',
      ctx: ownerCtx,
      cancel: () => {},
      runMaintenance: () => Promise.reject(new Error('not used')),
      send: () => {},
      followup: (message: UserMessage) => {
        agent.inbox.append('next-turn', message)
        idle = Promise.resolve().then(() => script.afterPrompt(session, message, agent))
      },
      steer: () => {},
      inject: () => {},
      whenIdle: () => {
        options.onWhenIdle?.(agent)
        return idle
      },
    }
    await createOptions.setup?.(ownerCtx, agent)
    await ctx.agents.register(agent)
    return agent
  }

  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
  ctx.agents.setFactory({
    async createAgent(ownerCtx: Context, createOptions: CreateAgentOptions): Promise<AgentHandle> {
      const session = ctx.sessions.create(createOptions.sessionId, {
        ...createOptions.meta === undefined ? {} : { meta: createOptions.meta },
      })
      script.before?.(session)
      const agent = await mount(ownerCtx, session, createOptions)
      return { agent, dispose: () => Promise.resolve() }
    },
    async resume(ownerCtx: Context, resumeOptions: ResumeAgentOptions): Promise<AgentHandle> {
      const session = ctx.sessions.get(resumeOptions.resumeSessionId)
      if (session === undefined) throw new Error(`no attached Session ${resumeOptions.resumeSessionId}`)
      const agent = await mount(ownerCtx, session, resumeOptions)
      return { agent, dispose: () => Promise.resolve() }
    },
  })
  if (options.omitSessionQuery !== true && (options.sessionId !== undefined || options.observe !== undefined)) {
    const observe = options.observe ?? (() => Promise.reject(new SessionQueryError('missing', 'SESSION_QUERY_SESSION_NOT_FOUND')))
    ctx.provide('sessionQuery', { observeSession: () => observe() } as never)
  }
  if (options.omitPersistence !== true) {
    ctx.provide('sessionPersistence', {} as never)
  }
  return {
    ctx,
    output: () => ({ out, err, order: [...order] }),
    run: async () => {
      ctx.on('session/flush', () => { order.push('flush') })
      internals.stdout = { write: (chunk: string) => { out += chunk; return true } }
      internals.stderr = { write: (chunk: string) => { err += chunk; return true } }
      if (options.readStdin !== undefined) internals.readStdin = options.readStdin
      const exited = new Promise<number>((resolve) => {
        ctx.provide('appExit', (code: number) => { order.push('exit'); resolve(code) })
      })
      if (options.prelive === true || options.preliveMeta !== undefined) {
        await ctx.agents.create({
          sessionId: brandString<SessionId>(options.sessionId ?? 'session-exact'),
          meta: { cwd: process.cwd(), ...options.preliveMeta },
        })
      }
      apply(ctx, {
        ...options.useStdin === true ? {} : { task: options.task ?? 'do the thing' },
        ...options.sessionId === undefined ? {} : { sessionId: options.sessionId },
        ...options.json === undefined ? {} : { json: options.json },
      })
      return { code: await exited, out, err, order }
    },
  }
}

describe('headless runner', () => {
  it('records a fresh Session in the filesystem provider working directory', async () => {
    const cwd = '/remote/workspace'
    const test = await bench({
      before(session) { expect(session.header.cwd).toBe(cwd) },
      afterPrompt(session, message) { appendTurn(session, 1, message, 'remote answer', true) },
    }, { filesystemCwd: cwd })
    try { expect(await test.run()).toMatchObject({ code: 0, out: 'remote answer\n' }) }
    finally { await test.ctx.fiber.dispose() }
  })

  it('reports the provider cwd in its opening JSON event', async () => {
    const cwd = '/remote/workspace'
    const test = await bench({
      afterPrompt(session, message) { appendTurn(session, 1, message, 'remote answer', true) },
    }, { filesystemCwd: cwd, json: true })
    try {
      const result = await test.run()
      expect(result.code).toBe(0)
      expect(JSON.parse(result.out.split('\n')[0] as string)).toMatchObject({ type: 'session', cwd })
    } finally { await test.ctx.fiber.dispose() }
  })

  it('resumes against the provider cwd instead of the host launch directory', async () => {
    const cwd = '/remote/workspace'
    const test = await bench({
      afterPrompt(session, message) { appendTurn(session, 1, message, 'remote resumed', true) },
    }, {
      filesystemCwd: cwd, sessionId: 'session-exact',
      observe: async () => ({ header: { cwd, origin: 'user' }, events: [], [Symbol.dispose]() {} }),
    })
    test.ctx.sessions.create(brandString<SessionId>('session-exact'), { meta: { cwd } })
    try { expect(await test.run()).toMatchObject({ code: 0, out: 'remote resumed\n' }) }
    finally { await test.ctx.fiber.dispose() }
  })

  it('aggregates the final text across the complete idle-to-idle interval and flushes before exit', async () => {
    const test = await bench({
      before(session) {
        const setupMessage = {
          role: 'user', content: [{ type: 'text', text: 'setup' }], source: { kind: 'user' }, id: brandString<MessageId>('setup'),
        } satisfies UserMessage
        appendTurn(session, 0, setupMessage, 'pre-task noise', true)
      },
      async afterPrompt(session, message) {
        await Promise.resolve()
        appendTurn(session, 1, message, '', true)
        appendTurn(session, 2, message, 'final answer', true)
      },
    })
    const result = await test.run()
    expect(result).toEqual({
      code: 0,
      out: 'final answer\n',
      err: '',
      order: ['flush', 'exit'],
    })
    await test.ctx.fiber.dispose()
  })

  it('ignores durable inbox events before the first owned turn', async () => {
    const test = await bench({
      afterPrompt(session, message) {
        session.append('agent/inbox/spliced', {
          target: 'next-turn',
          start: 0,
          inserted: [message],
        })
        appendTurn(session, 1, message, 'answer after inbox activity', true)
      },
    })
    expect(await test.run()).toMatchObject({
      code: 0,
      out: 'answer after inbox activity\n',
      err: '',
    })
    await test.ctx.fiber.dispose()
  })

  it('waits for asynchronously appended events instead of racing Agent idleness', async () => {
    const test = await bench({
      afterPrompt: async (session, message) => {
        await new Promise(resolve => setTimeout(resolve, 5))
        appendTurn(session, 1, message, 'race-free answer', true)
      },
    })
    expect(await test.run()).toMatchObject({ code: 0, out: 'race-free answer\n', err: '' })
    await test.ctx.fiber.dispose()
  })

  it('streams reasoning before the Agent becomes idle and terminates its stderr line', async () => {
    const reasoningAppended = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const test = await bench({
      async afterPrompt(session, message, agent) {
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        startFrames(agent)
        emitChunk(agent, { type: 'block-start', index: 0, blockType: 'reasoning' })
        emitChunk(agent, { type: 'reasoning-delta', index: 0, text: '' })
        emitChunk(agent, { type: 'reasoning-delta', index: 0, text: 'checking the workspace' })
        emitChunk(agent, { type: 'reasoning-delta', index: 0, text: ' safely\n' })
        emitChunk(agent, { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'checking the workspace safely\n' } })
        emitChunk(agent, { type: 'usage', usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 2 } })
        emitChunk(agent, { type: 'block-start', index: 1, blockType: 'reasoning' })
        emitChunk(agent, { type: 'reasoning-delta', index: 1, text: 'second pass\n' })
        reasoningAppended.resolve(undefined)
        await release.promise
        emitChunk(agent, { type: 'block-start', index: 2, blockType: 'text' })
        emitChunk(agent, { type: 'text-delta', index: 2, text: 'done' })
        emitChunk(agent, { type: 'block-end', index: 2, block: { type: 'text', text: 'done' } })
        session.append('assistant/message', {
          stream: [],
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: 'text', text: 'done' }],
            source: { provider: 'test-provider', model: 'test-model' },
          }),
        }, { surfaceOp: 'append' })
        session.append('step/end', { turn: 1, step: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      },
    })
    const running = test.run()
    await reasoningAppended.promise
    const other = test.ctx.sessions.create()
    other.append('turn/start', { turn: 1 })
    other.append('step/start', { turn: 1, step: 1 })
    test.ctx.emit('agent/assistant-stream', {
      agent: { session: other } as Agent,
      frame: {
        type: 'chunk', attemptId: LlmAttemptId('other'), revision: 1,
        index: 0, time: Date.now(), chunk: { type: 'reasoning-delta', index: 0, text: 'other session' },
      },
    })
    const streamed = test.output()
    release.resolve(undefined)
    const result = await running
    expect(streamed).toEqual({
      out: '',
      err: 'dsh: reasoning:\nchecking the workspace safely\nsecond pass\n',
      order: [],
    })
    expect(result).toEqual({
      code: 0,
      out: 'done\n',
      err: 'dsh: reasoning:\nchecking the workspace safely\nsecond pass\n',
      order: ['flush', 'exit'],
    })
    await test.ctx.fiber.dispose()
  })

  it('closes an unterminated reasoning line as soon as the attempt ends', async () => {
    const reasoningAppended = Promise.withResolvers<undefined>()
    const releaseEnd = Promise.withResolvers<undefined>()
    const ended = Promise.withResolvers<undefined>()
    const finish = Promise.withResolvers<undefined>()
    const test = await bench({
      async afterPrompt(session, message, agent) {
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        startFrames(agent)
        emitChunk(agent, { type: 'reasoning-delta', index: 0, text: 'unfinished reasoning' })
        reasoningAppended.resolve(undefined)
        await releaseEnd.promise
        const state = frameStates.get(agent)
        if (state === undefined) throw new Error('test Assistant frames have not started')
        agent.ctx.emit('agent/assistant-stream', {
          agent,
          frame: {
            type: 'end', attemptId: state.attemptId, revision: ++state.revision,
            index: state.index, outcome: { kind: 'abandoned' },
          },
        })
        ended.resolve(undefined)
        await finish.promise
        session.append('step/end', { turn: 1, step: 1 })
        session.append('turn/end', {
          turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } },
        })
      },
    })
    const running = test.run()
    await reasoningAppended.promise
    expect(test.output().err).toBe('dsh: reasoning:\nunfinished reasoning')

    releaseEnd.resolve(undefined)
    await ended.promise
    expect(test.output().err).toBe('dsh: reasoning:\nunfinished reasoning\n')

    finish.resolve(undefined)
    await expect(running).resolves.toMatchObject({ code: 1 })
    await test.ctx.fiber.dispose()
  })

  it('exits 1 when the final turn does not complete', async () => {
    const test = await bench({
      afterPrompt(session, message) { appendTurn(session, 1, message, undefined, false) },
    })
    expect(await test.run()).toMatchObject({ code: 1, out: '\n', err: '' })
    await test.ctx.fiber.dispose()
  })

  it('prints the durable model failure when the final turn ends in error', async () => {
    const test = await bench({
      afterPrompt(session, message) {
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        session.append('step/end', { turn: 1, step: 1 })
        session.append('turn/end', {
          turn: 1,
          reason: { kind: 'error', error: { code: 'SERVER', message: 'provider unavailable' } },
        })
      },
    })
    expect(await test.run()).toMatchObject({
      code: 1,
      out: '\n',
      err: 'dsh: SERVER: provider unavailable\n',
    })
    await test.ctx.fiber.dispose()
  })

  it('separates an unterminated reasoning prefix from the terminal model failure', async () => {
    const test = await bench({
      afterPrompt(session, message, agent) {
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        startFrames(agent)
        emitChunk(agent, { type: 'reasoning-delta', index: 0, text: 'trying recovery' })
        session.append('step/end', { turn: 1, step: 1 })
        session.append('turn/end', {
          turn: 1,
          reason: { kind: 'error', error: { code: 'SERVER', message: 'provider unavailable' } },
        })
      },
    })
    expect(await test.run()).toMatchObject({
      code: 1,
      out: '\n',
      err: 'dsh: reasoning:\ntrying recovery\ndsh: SERVER: provider unavailable\n',
    })
    await test.ctx.fiber.dispose()
  })

  it('exits 1 when the owned interval contains no turn', async () => {
    const test = await bench({ afterPrompt: () => {} })
    expect(await test.run()).toMatchObject({ code: 1, out: '\n', err: '' })
    await test.ctx.fiber.dispose()
  })

  it('fails when an event below the captured Session length cannot be read', async () => {
    let capturedLength = 0
    const test = await bench({
      afterPrompt(session, message) {
        appendTurn(session, 1, message, 'unreachable', true)
        capturedLength = session.seq
        Object.defineProperty(session, 'eventAt', { value: () => undefined })
      },
    })
    const result = await test.run()
    expect(capturedLength).toBeGreaterThan(0)
    expect(result).toMatchObject({
      code: 1,
      out: '',
      err: `dsh: headless summary cannot read seq 0 below captured length ${String(capturedLength)}\n`,
    })
    await test.ctx.fiber.dispose()
  })

  it('reads the task from stdin when the invocation omits one', async () => {
    const test = await bench({
      afterPrompt(session, message) { appendTurn(session, 1, message, 'stdin answer', true) },
    }, {
      useStdin: true,
      readStdin: () => Promise.resolve('task from stdin'),
    })
    expect(await test.run()).toMatchObject({ code: 0, out: 'stdin answer\n', err: '' })
    await test.ctx.fiber.dispose()
  })

  it('rejects an empty stdin task', async () => {
    const test = await bench({ afterPrompt: () => {} }, {
      useStdin: true,
      readStdin: () => Promise.resolve('   \n'),
    })
    expect(await test.run()).toMatchObject({
      code: 1,
      err: 'dsh: a task is required, for example: dsh --profile headless "run the tests"\n',
    })
    await test.ctx.fiber.dispose()
  })

  it('reads the default process stdin when no override is installed', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'stdin')
    Object.defineProperty(process, 'stdin', {
      value: Readable.from([Buffer.from('piped'), Buffer.from(' task')]),
      configurable: true,
    })
    try {
      await expect(originalInternals.readStdin()).resolves.toBe('piped task')
    } finally {
      if (original !== undefined) Object.defineProperty(process, 'stdin', original)
    }
  })

  it('treats a bare dash positional as the stdin marker', async () => {
    const test = await bench({
      afterPrompt(session, message) { appendTurn(session, 1, message, 'dash answer', true) },
    }, {
      task: '-',
      readStdin: () => Promise.resolve('piped dash task'),
    })
    expect(await test.run()).toMatchObject({ code: 0, out: 'dash answer\n', err: '' })
    await test.ctx.fiber.dispose()
  })

  it('rejects --session-id when the query reports the id missing', async () => {
    const seen: string[] = []
    const test = await bench({
      afterPrompt(session, message) {
        seen.push(session.id)
        appendTurn(session, 1, message, 'created', true)
      },
    }, {
      sessionId: 'session-exact',
      observe: () => Promise.reject(new SessionQueryError('missing', 'SESSION_QUERY_SESSION_NOT_FOUND')),
    })
    const result = await test.run()
    expect(result.code).toBe(1)
    expect(result.err).toContain('session "session-exact" does not exist; omit --session-id to start a new Session')
    expect(result.out).toBe('')
    expect(seen).toEqual([])
    await test.ctx.fiber.dispose()
  })

  it('rejects --session-id when persistence is not mounted', async () => {
    const test = await bench({
      afterPrompt(session, message) { appendTurn(session, 1, message, 'created', true) },
    }, {
      sessionId: 'session-exact',
      observe: () => Promise.reject(new SessionQueryError('missing', 'SESSION_QUERY_SESSION_NOT_FOUND')),
      omitPersistence: true,
    })
    const result = await test.run()
    expect(result.code).toBe(1)
    expect(result.err).toContain('requires the sessionPersistence service')
    expect(result.out).toBe('')
    await test.ctx.fiber.dispose()
  })

  it('rejects adopting a live Session when persistence is not mounted', async () => {
    const test = await bench({
      afterPrompt(session, message) { appendTurn(session, 1, message, 'live', true) },
    }, {
      sessionId: 'session-exact',
      prelive: true,
      omitPersistence: true,
    })
    const result = await test.run()
    expect(result.code).toBe(1)
    expect(result.err).toContain('requires the sessionPersistence service')
    expect(result.out).toBe('')
    await test.ctx.fiber.dispose()
  })

  it('resumes the persisted Session when the query finds it', async () => {
    const test = await bench({
      afterPrompt(session, message) { appendTurn(session, 1, message, 'resumed answer', true) },
    }, {
      sessionId: 'session-exact',
      observe: () => Promise.resolve({
        header: { cwd: process.cwd(), origin: 'user' },
        events: [],
        [Symbol.dispose]() {},
      }),
    })
    const session = test.ctx.sessions.create(brandString<SessionId>('session-exact'), { meta: { cwd: process.cwd() } })
    const history = {
      role: 'user', content: [{ type: 'text', text: 'earlier' }], source: { kind: 'user' }, id: brandString<MessageId>('history'),
    } satisfies UserMessage
    appendTurn(session, 0, history, 'earlier answer', true)
    const before = session.seq
    expect(await test.run()).toMatchObject({ code: 0, out: 'resumed answer\n', err: '' })
    expect(session.seq).toBeGreaterThan(before)
    await test.ctx.fiber.dispose()
  })

  it('rejects a persisted Session recorded in another working directory', async () => {
    const test = await bench({ afterPrompt: () => {} }, {
      sessionId: 'session-exact',
      observe: () => Promise.resolve({
        header: { cwd: '/somewhere/else', origin: 'user' },
        events: [],
        [Symbol.dispose]() {},
      }),
    })
    const result = await test.run()
    expect(result.code).toBe(1)
    expect(result.err).toContain('was recorded in "/somewhere/else"')
    await test.ctx.fiber.dispose()
  })

  it('rejects a persisted Session created under an agent preset', async () => {
    const test = await bench({ afterPrompt: () => {} }, {
      sessionId: 'session-exact',
      observe: () => Promise.resolve({
        header: { cwd: process.cwd(), agentPreset: 'minimal' },
        events: [],
        [Symbol.dispose]() {},
      }),
    })
    const result = await test.run()
    expect(result.code).toBe(1)
    expect(result.err).toContain('runs under agent preset "minimal"')
    await test.ctx.fiber.dispose()
  })

  it('rejects a persisted Session that switched to an agent preset after creation', async () => {
    const test = await bench({ afterPrompt: () => {} }, {
      sessionId: 'session-exact',
      observe: () => Promise.resolve({
        header: { cwd: process.cwd() },
        events: [{ type: 'agent-preset/selected', data: { agentPreset: 'minimal' } }],
        [Symbol.dispose]() {},
      }),
    })
    const result = await test.run()
    expect(result.code).toBe(1)
    expect(result.err).toContain('runs under agent preset "minimal"')
    await test.ctx.fiber.dispose()
  })

  it('rejects a persisted Session whose preset record names no preset', async () => {
    const test = await bench({ afterPrompt: () => {} }, {
      sessionId: 'session-exact',
      observe: () => Promise.resolve({
        header: { cwd: process.cwd() },
        events: [{ type: 'agent-preset/selected', data: {} }],
        [Symbol.dispose]() {},
      }),
    })
    const result = await test.run()
    expect(result.code).toBe(1)
    expect(result.err).toContain('malformed agent-preset/selected event')
    await test.ctx.fiber.dispose()
  })

  it('rejects a persisted Session that recorded no working directory', async () => {
    const test = await bench({ afterPrompt: () => {} }, {
      sessionId: 'session-exact',
      observe: () => Promise.resolve({
        header: {},
        events: [],
        [Symbol.dispose]() {},
      }),
    })
    const result = await test.run()
    expect(result.code).toBe(1)
    expect(result.err).toContain('recorded no working directory')
    await test.ctx.fiber.dispose()
  })

  it('rejects a persisted Session owned by a subagent', async () => {
    const test = await bench({ afterPrompt: () => {} }, {
      sessionId: 'session-exact',
      observe: () => Promise.resolve({
        header: { cwd: process.cwd(), origin: 'subagent' },
        events: [],
        [Symbol.dispose]() {},
      }),
    })
    const result = await test.run()
    expect(result.code).toBe(1)
    expect(result.err).toContain('is a subagent or forked session')
    await test.ctx.fiber.dispose()
  })

  it('requires the Session query service for an exact Session identity', async () => {
    const test = await bench({ afterPrompt: () => {} }, { sessionId: 'session-exact', omitSessionQuery: true })
    const result = await test.run()
    expect(result.code).toBe(1)
    expect(result.err).toContain('requires the sessionQuery service')
    await test.ctx.fiber.dispose()
  })

  it('requires the Session query service even when a live Agent holds the identity', async () => {
    const test = await bench({
      afterPrompt(session, message) { appendTurn(session, 1, message, 'live', true) },
    }, {
      sessionId: 'session-exact',
      prelive: true,
      omitSessionQuery: true,
    })
    const result = await test.run()
    expect(result.code).toBe(1)
    expect(result.err).toContain('requires the sessionQuery service')
    expect(result.out).toBe('')
    await test.ctx.fiber.dispose()
  })

  it('rejects a whitespace-only session identity from configuration', async () => {
    const test = await bench({ afterPrompt: () => {} }, { sessionId: '   ' })
    const result = await test.run()
    expect(result.code).toBe(1)
    expect(result.err).toContain('sessionId must not be blank')
    expect(result.out).toBe('')
    await test.ctx.fiber.dispose()
  })

  it('refuses a live Agent identity it cannot own exclusively', async () => {
    const test = await bench({
      afterPrompt(session, message) { appendTurn(session, 1, message, 'live answer', true) },
    }, {
      sessionId: 'session-exact',
      prelive: true,
    })
    const result = await test.run()
    expect(result.code).toBe(1)
    expect(result.err).toContain('is live in this process, so the one-shot runner cannot own an exclusive run interval')
    expect(result.out).toBe('')
    await test.ctx.fiber.dispose()
  })

  it('rejects a live Agent recorded in another working directory', async () => {
    const test = await bench({ afterPrompt: () => {} }, {
      sessionId: 'session-exact',
      preliveMeta: { cwd: '/somewhere/else' },
    })
    const result = await test.run()
    expect(result.code).toBe(1)
    expect(result.err).toContain('was recorded in "/somewhere/else"')
    await test.ctx.fiber.dispose()
  })

  it('rejects a live Agent owned by a subagent', async () => {
    const test = await bench({ afterPrompt: () => {} }, {
      sessionId: 'session-exact',
      preliveMeta: { origin: 'subagent' },
    })
    const result = await test.run()
    expect(result.code).toBe(1)
    expect(result.err).toContain('is a subagent or forked session')
    await test.ctx.fiber.dispose()
  })

  it('rejects a live Agent created under an agent preset', async () => {
    const test = await bench({ afterPrompt: () => {} }, {
      sessionId: 'session-exact',
      preliveMeta: { agentPreset: 'minimal' },
    })
    const result = await test.run()
    expect(result.code).toBe(1)
    expect(result.err).toContain('runs under agent preset "minimal"')
    await test.ctx.fiber.dispose()
  })

  it('rejects a live Agent that switched to an agent preset while blank', async () => {
    const test = await bench({
      before(session) {
        const history = {
          role: 'user', content: [{ type: 'text', text: 'earlier' }], source: { kind: 'user' }, id: brandString<MessageId>('history'),
        } satisfies UserMessage
        appendTurn(session, 0, history, 'earlier answer', true)
        selectPreset(session, 'minimal')
      },
      afterPrompt: () => {},
    }, {
      sessionId: 'session-exact',
      prelive: true,
    })
    const result = await test.run()
    expect(result.code).toBe(1)
    expect(result.err).toContain('runs under agent preset "minimal"')
    await test.ctx.fiber.dispose()
  })

  it('rejects a preset appended after the observation snapshot was taken', async () => {
    const test = await bench({ afterPrompt: () => {} }, {
      sessionId: 'session-exact',
      observe: () => Promise.resolve({
        header: { cwd: process.cwd() },
        events: [],
        [Symbol.dispose]() {},
      }),
    })
    const session = test.ctx.sessions.create(brandString<SessionId>('session-exact'), { meta: { cwd: process.cwd() } })
    selectPreset(session, 'minimal')
    const result = await test.run()
    expect(result.code).toBe(1)
    expect(result.err).toContain('runs under agent preset "minimal"')
    await test.ctx.fiber.dispose()
  })

  it('rejects a preset an overlay appends while the runner awaits idle', async () => {
    const test = await bench({ afterPrompt: () => {} }, {
      sessionId: 'session-exact',
      observe: () => Promise.resolve({
        header: { cwd: process.cwd() },
        events: [],
        [Symbol.dispose]() {},
      }),
      onWhenIdle: (agent) => { selectPreset(agent.session, 'minimal') },
    })
    test.ctx.sessions.create(brandString<SessionId>('session-exact'), { meta: { cwd: process.cwd() } })
    const result = await test.run()
    expect(result.code).toBe(1)
    expect(result.err).toContain('runs under agent preset "minimal"')
    expect(result.out).toBe('')
    await test.ctx.fiber.dispose()
  })

  it('fails when a live event below the captured Session length cannot be read', async () => {
    let capturedLength = 0
    const test = await bench({
      before(session) {
        const history = {
          role: 'user', content: [{ type: 'text', text: 'earlier' }], source: { kind: 'user' }, id: brandString<MessageId>('history'),
        } satisfies UserMessage
        appendTurn(session, 0, history, 'earlier answer', true)
        capturedLength = session.seq
        Object.defineProperty(session, 'eventAt', { value: () => undefined })
      },
      afterPrompt: () => {},
    }, {
      sessionId: 'session-exact',
      prelive: true,
    })
    const result = await test.run()
    expect(capturedLength).toBeGreaterThan(0)
    expect(result.code).toBe(1)
    expect(result.err).toContain(`headless adoption cannot read seq 0 below captured length ${String(capturedLength)}`)
    await test.ctx.fiber.dispose()
  })

  it('bounds the error event message in --json mode', async () => {
    const test = await bench({ afterPrompt: () => {} }, {
      sessionId: 'session-exact',
      json: true,
      observe: () => Promise.reject(new SessionQueryError('x'.repeat(9 * 1024), 'SESSION_QUERY_CORRUPT_SESSION')),
    })
    const result = await test.run()
    const event = JSON.parse(result.out.trim()) as { message: string; truncated?: boolean }
    expect(event.truncated).toBe(true)
    expect(event.message.length).toBe(8 * 1024)
    await test.ctx.fiber.dispose()
  })

  it('rejects a persisted Session linked to a parent', async () => {
    const test = await bench({ afterPrompt: () => {} }, {
      sessionId: 'session-exact',
      observe: () => Promise.resolve({
        header: { cwd: process.cwd(), origin: 'user', parentSession: 'parent-1' },
        events: [],
        [Symbol.dispose]() {},
      }),
    })
    const result = await test.run()
    expect(result.code).toBe(1)
    expect(result.err).toContain('is a subagent or forked session')
    await test.ctx.fiber.dispose()
  })

  it('propagates a Session query failure that is not a missing log', async () => {
    const test = await bench({ afterPrompt: () => {} }, {
      sessionId: 'session-exact',
      observe: () => Promise.reject(new SessionQueryError('log is corrupt', 'SESSION_QUERY_CORRUPT_SESSION')),
    })
    const result = await test.run()
    expect(result.code).toBe(1)
    expect(result.err).toBe('dsh: log is corrupt\n')
    await test.ctx.fiber.dispose()
  })

  it('projects the run as ordered newline-delimited events in --json mode', async () => {
    const test = await bench({
      afterPrompt(session, message, agent) {
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        startFrames(agent)
        // A live attempt that never commits must not reach the projection.
        emitChunk(agent, { type: 'reasoning-delta', index: 0, text: 'discarded attempt' })
        emitChunk(agent, { type: 'text-delta', index: 0, text: 'discarded answer' })
        session.append('assistant/message', {
          stream: [],
          turn: 1,
          step: 1,
          usage: { inputTokens: 3, outputTokens: 4 },
          message: createAssistantMessage({
            content: [
              { type: 'reasoning', text: 'thinking hard' },
              { type: 'text', text: 'answer' },
              { type: 'tool-call', id: ToolCallId('call-1'), name: 'bash', arguments: '{"command":"ls"}' },
            ],
            source: { provider: 'test-provider', model: 'test-model' },
          }),
        }, { surfaceOp: 'append' })
        session.append('tool/call', {
          turn: 1, step: 1, callId: ToolCallId('call-1'), name: 'bash', arguments: '{"command":"ls"}',
        })
        session.append('tool/result', {
          turn: 1,
          step: 1,
          message: createToolResultMessage({
            callId: ToolCallId('call-1'),
            content: [{ type: 'text', text: 'a.txt' }],
            isError: false,
          }),
        }, { surfaceOp: 'append' })
        session.append('step/end', { turn: 1, step: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      },
    }, { json: true })
    const result = await test.run()
    const events = result.out.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(events.map(event => event.type)).toEqual([
      'session', 'status', 'status', 'thinking', 'text',
      'tool_call', 'tool_result', 'status', 'status', 'final',
    ])
    expect(events[0]).toMatchObject({ type: 'session', cwd: process.cwd() })
    expect(typeof events[0]?.sessionId).toBe('string')
    expect(events[1]).toMatchObject({ type: 'status', phase: 'turn_start', turn: 1 })
    expect(events[3]).toMatchObject({ type: 'thinking', text: 'thinking hard' })
    expect(events[4]).toMatchObject({ type: 'text', text: 'answer' })
    expect(result.out).not.toContain('discarded')
    expect(events[5]).toMatchObject({ type: 'tool_call', callId: 'call-1', tool: 'bash', input: { command: 'ls' } })
    expect(events[6]).toMatchObject({ type: 'tool_result', callId: 'call-1', status: 'completed', result: 'a.txt' })
    expect(events[7]).toMatchObject({ type: 'status', phase: 'step_end', usage: { inputTokens: 3, outputTokens: 4 } })
    expect(events[8]).toMatchObject({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } })
    expect(events[9]).toMatchObject({ type: 'final', text: 'answer' })
    expect(result.err).toBe('')
    expect(result.code).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('reports a direct failure as an error event in --json mode', async () => {
    const test = await bench({ afterPrompt: () => {} }, {
      useStdin: true,
      readStdin: () => Promise.resolve(''),
      json: true,
    })
    const result = await test.run()
    expect(result.code).toBe(1)
    expect(JSON.parse(result.out.trim())).toMatchObject({ type: 'error' })
    expect(result.err).toContain('a task is required')
    await test.ctx.fiber.dispose()
  })

  it('reports a direct Agent creation failure', async () => {
    const ctx = new Context()
    let err = ''
    internals.stdout = { write: () => true }
    internals.stderr = { write: (chunk: string) => { err += chunk; return true } }
    const exited = new Promise<number>((resolve) => {
      ctx.provide('appExit', resolve)
    })
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) } as never)
    ctx.provide('sessions', { flush: () => Promise.resolve(true) } as never)
    ctx.provide('agents', { create: () => Promise.reject(new Error('factory exploded')) } as never)
    apply(ctx, { task: 't' })
    expect(await exited).toBe(1)
    expect(err).toBe('dsh: factory exploded\n')
    await ctx.fiber.dispose()
  })

  it('stringifies a non-Error Agent creation failure', async () => {
    const ctx = new Context()
    let err = ''
    internals.stdout = { write: () => true }
    internals.stderr = { write: (chunk: string) => { err += chunk; return true } }
    const exited = new Promise<number>((resolve) => {
      ctx.provide('appExit', resolve)
    })
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) } as never)
    ctx.provide('sessions', { flush: () => Promise.resolve(true) } as never)
    const rejected = {
      then(_resolve: (value: never) => void, reject: (reason: unknown) => void): void {
        reject('factory exploded')
      },
    }
    ctx.provide('agents', { create: () => rejected } as never)
    apply(ctx, { task: 't' })
    expect(await exited).toBe(1)
    expect(err).toBe('dsh: factory exploded\n')
    await ctx.fiber.dispose()
  })

  it('abandons a run when the tree is disposed during Loader settlement', async () => {
    const ctx = new Context()
    let exited = false
    internals.stdout = { write: () => true }
    internals.stderr = { write: () => true }
    ctx.provide('appExit', () => { exited = true })
    const services = ctx.plugin((child: Context) => {
      child.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) } as never)
      child.provide('sessions', {} as never)
      child.provide('agents', {} as never)
    })
    await services
    let release: () => void
    const settlement = new Promise<void>((resolve) => { release = resolve })
    ctx.provide('loader', { await: () => settlement } as never)
    apply(ctx, { task: 't' })
    await services.dispose()
    release!()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(exited).toBe(false)
    await ctx.fiber.dispose()
  })

  it('fails loud without the launcher-provided exit request', () => {
    const ctx = new Context()
    expect(() => { apply(ctx, { task: 't' }) }).toThrow('must provide ctx.appExit')
  })

  it('validates config: the task and run options are optional', () => {
    expect(new Config({})).toEqual({})
    expect(new Config({ task: 'x', sessionId: 'session-x', json: true }))
      .toEqual({ task: 'x', sessionId: 'session-x', json: true })
  })
})
