import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { RUN_CODE_NAME, defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { Session, SessionId, type SessionEvent, type UserMessage } from '@deepseek-ai/dsh-session'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import UserQuestionService, {
  UserQuestionError, type AskUserQuestionAnswer, type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { CodeRuntime, type CodeRunRequest, type CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import PlanModeController, { EXIT_PLAN_MODE, planProjectionDefinition, resolveConfig } from '../src/index.ts'
import type { PlanModeConfig } from '../src/index.ts'
import type { PlanUnitState } from '../src/types.ts'

const TEST_PLAN_SECTION = 'Test plan mode instructions.'
const PLAN_CONFIG = { section: TEST_PLAN_SECTION } satisfies PlanModeConfig

interface QuestionAnswerer {
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
}

function registerQuestionAnswerer(ctx: Context, answerer: QuestionAnswerer): () => void {
  return ctx.on('user-questions/request', request => answerer.ask(request))
}

/**
 * Drives the REAL plugin: mounts `dsh-plan-mode` beside real `SystemPrompt` and
 * `ToolRuntime` services, with fake Agents carrying real `Session`s and a
 * real scoped `agent.ctx` minted through `createScope`.
 * Request boundaries are simulated by dispatching the real pre-step waterfall
 * and the following `step/start` session event used by the loop.
 */

async function agentWithSession(
  ctx: Context,
  id = 'agent-1',
  { active, owner }: { active?: boolean; owner?: Agent } = {},
): Promise<Agent & { session: Session }> {
  // A live store session when a store is mounted (the command executor logs
  // lifecycle events through it); bare otherwise (fold/tool-only benches).
  const session = Session.create(SessionId(id))
  const agent = {
    id: SessionId(id),
    session,
    options: {},
    inject(message: UserMessage) {
      session.append('user/message', message, { surfaceOp: 'append' })
    },
  } as unknown as Agent & { session: Session }
  let scoped!: Context
  await ctx.plugin(Object.assign((inner: Context) => { scoped = createScope(inner, agent).ctx }, {
    inject: ['tools'],
  }))
  ;(agent as { ctx?: Context }).ctx = scoped
  // Seeded plan state lands before the creation announcement, matching resume.
  if (active !== undefined) session.append('plan/mode', { active })
  // The loop publishes through the live registry when it is composed; narrow
  // fold-only benches retain the direct lifecycle event used before it exists.
  const agents = ctx.get('agents')
  if (agents === undefined) {
    ctx.emit('agent/created', { agent })
  } else {
    agents.enter(agent, owner)
    agents.announce(agent)
  }
  return agent
}

function assembleFor(ctx: Context, agent: Agent) {
  return ctx.systemPrompt.assemble({ agent, scope: agent })
}

function foldPlanMode(events: readonly SessionEvent[], end = events.length): boolean {
  let state: PlanUnitState = planProjectionDefinition.init()
  let index = 0
  for (const event of events) {
    if (index >= end) break
    index++
    state = planProjectionDefinition.apply(state, event)
  }
  return state.active
}

async function mountProjectionSeam(ctx: Context): Promise<void> {
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
}

async function setup(config: PlanModeConfig = PLAN_CONFIG): Promise<Context> {
  const ctx = new Context()
  await mountProjectionSeam(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(PlanModeController, config)
  return ctx
}

/**
 * Dispatch pre-step processing and optionally its following step-start commit.
 */
async function boundary(ctx: Context, agent: Agent & { session: Session }, type: 'pre-step' | 'step-start'): Promise<void> {
  const events = agentEvents(ctx, agent)
  const message = createUserMessage({
    content: [{ type: 'text', text: 'boundary probe' }],
    source: { kind: 'user' },
  })
  const signal = new AbortController().signal
  const decision = await events.waterfall(
    'agent/pre-step',
    { messages: [message], turn: 1, step: 1, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [message] }),
  )
  if (decision.kind === 'enter') {
    for (const message of decision.messages.slice(1)) {
      agent.session.append('user/message', message, { surfaceOp: 'append' })
    }
  }
  if (type === 'step-start') {
    const event = agent.session.append('step/start', { turn: 1, step: 1 })
    ctx.emit('session/event', agent.session, event)
  }
}

/** Open a turn so a selection queues for the boundary flush (the mid-turn shape). */
function openTurn(session: Session, turn = 0): void {
  session.append('turn/start', { turn })
}

/** Close the open turn (the between-turns shape: selections commit immediately). */
function closeTurn(session: Session, turn = 0): void {
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Append a minimal `request/header` snapshot so the log has a "what the model was told" anchor. */
function header(session: Session): void {
  session.append('request/header', { header: { config: { provider: 'test', model: 'test-model' } }, reason: 'initial' })
}

function noticeTexts(session: Session): string[] {
  return session.snapshotEvents()
    .filter(event => event.type === 'user/message' && event.data.source.kind === 'plugin')
    .map(event => (event.data as { content: { type: string; text?: string }[] }).content.map(block => block.text ?? '').join(''))
}

function registerNamedTools(ctx: Context, names: string[]): void {
  for (const name of names) {
    ctx.tools.register(defineContentToolFixture({
      name,
      description: `test tool ${name}`,
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: `ran ${name}` }]),
    }))
  }
}

/** Assert the mapped PTC mode SDK includes the stable plan exit binding and test tools. */
function expectPlanCodeSdkBindings(sdk: string): void {
  expect(sdk).toContain('interface ToolArgsMap {')
  expect(sdk).toContain('read: Record<string, JsonValue>;')
  expect(sdk).toContain('write: Record<string, JsonValue>;')
  expect(sdk).toContain('interface ToolOutputMap {')
  expect(sdk).toContain('exit_plan_mode: {\n    approved: true;\n  };')
  expect(sdk).toContain('[K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>;')
}

let callCounter = 0
function execute(ctx: Context, name: string, agent?: Agent) {
  return ctx.tools.execute({
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: {},
    signal: new AbortController().signal,
    ...agent ? { agent } : {},
  })
}

describe('resolveConfig', () => {
  it('requires string, non-empty plan instructions', () => {
    expect(() => resolveConfig({} as PlanModeConfig))
      .toThrow('needs a string `section`')
    expect(() => resolveConfig({ section: 5 } as unknown as PlanModeConfig))
      .toThrow('needs a string `section`')
    expect(() => resolveConfig({ section: '   ' }))
      .toThrow('needs a non-empty `section`')
  })

  it('returns a detached plan config', () => {
    const config = { section: TEST_PLAN_SECTION }
    const resolved = resolveConfig(config)
    expect(resolved).toEqual(config)
    expect(resolved).not.toBe(config)
  })

  it('rejects fields outside the plan policy config', () => {
    expect(() => resolveConfig({ section: TEST_PLAN_SECTION, tools: ['read'] } as unknown as PlanModeConfig))
      .toThrow('unknown key(s) tools — config is { section }')
  })
})

describe('foldPlanMode', () => {
  it('folds an empty log to inactive and takes the last plan/mode otherwise', () => {
    const session = Session.create(SessionId('fold'))
    expect(foldPlanMode(session.snapshotEvents())).toBe(false)
    session.append('plan/mode', { active: true })
    session.append('plan/mode', { active: false })
    session.append('plan/mode', { active: true })
    expect(foldPlanMode(session.snapshotEvents())).toBe(true)
  })

  it('folds a prefix when `end` is given', () => {
    const session = Session.create(SessionId('fold-prefix'))
    session.append('plan/mode', { active: true })
    session.append('plan/mode', { active: false })
    expect(foldPlanMode(session.snapshotEvents(), 1)).toBe(true)
    expect(foldPlanMode(session.snapshotEvents(), 0)).toBe(false)
  })
})

describe('ctx.planMode: get/set', () => {
  it('does not activate without the required projection registry', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(PlanModeController, PLAN_CONFIG)
    expect(ctx.get('planMode')).toBeUndefined()
  })

  it('fails when the required plan projection key is absent', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx, 'missing-plan-projection')
    vi.spyOn(ctx.sessionProjections, 'stateOf').mockReturnValue(undefined)
    expect(() => ctx.planMode.get(agent)).toThrow('plan-mode requires the plan session projection')
  })

  it('registers plan state directly but requires turnBoundary state', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const agent = await agentWithSession(ctx, 'missing-plan-projection-keys')
    const planMode = new PlanModeController(ctx, PLAN_CONFIG)
    await new Promise(resolve => setImmediate(resolve))
    expect(planMode.get(agent)).toEqual({ active: false })
    expect(() => planMode.set(agent, true)).toThrow('plan-mode requires the turnBoundary session projection')
  })

  it('reads the folded state', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    expect(ctx.planMode.get(agent)).toEqual({ active: false })
    agent.session.append('plan/mode', { active: true })
    expect(ctx.planMode.get(agent)).toEqual({ active: true })
  })

  it('selects inactive as the plan exit target during an open turn', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    agent.session.append('plan/mode', { active: true })
    openTurn(agent.session)
    expect(ctx.planMode.set(agent, false)).toBe('queued')
    expect(ctx.planMode.get(agent)).toEqual({ active: true, pending: false })
  })

  it('drops a no-op set (target equals pending, else the current fold)', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    openTurn(agent.session)
    expect(ctx.planMode.set(agent, false)).toBe('noop')
    expect(ctx.planMode.get(agent)).toEqual({ active: false })
    expect(ctx.planMode.set(agent, true)).toBe('queued')
    expect(ctx.planMode.set(agent, true)).toBe('noop')
    expect(ctx.planMode.get(agent)).toEqual({ active: false, pending: true })
  })

  it('a between-turns selection commits plan/mode immediately (no boundary would come)', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx, 'agent-idle')
    expect(ctx.planMode.set(agent, true)).toBe('committed')
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(true)
    expect(ctx.planMode.get(agent)).toEqual({ active: true })
    // Immediately reversible, still without a boundary.
    expect(ctx.planMode.set(agent, false)).toBe('committed')
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(false)
    // A later boundary finds nothing pending — no double append.
    await boundary(ctx, agent, 'step-start')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'plan/mode')).toHaveLength(2)
  })

  it('a between-turns reversal of a mid-turn pending intent cancels without logging', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    openTurn(agent.session)
    expect(ctx.planMode.set(agent, true)).toBe('queued')
    closeTurn(agent.session)
    // Back to the logged state: the pending intent clears, nothing lands.
    expect(ctx.planMode.set(agent, false)).toBe('cancelled')
    expect(agent.session.snapshotEvents().some(event => event.type === 'plan/mode')).toBe(false)
    expect(ctx.planMode.get(agent)).toEqual({ active: false })
  })

  it('a between-turns commit narrates when the last header told the model otherwise', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx, 'agent-idle-narrate')
    header(agent.session)
    ctx.planMode.set(agent, true)
    expect(noticeTexts(agent.session)).toEqual(['The user switched this session to plan mode.'])
  })
})

describe('the boundary flush', () => {
  it('is inert when no selection is pending', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    const service = ctx.planMode as unknown as { onBoundary(session: Session): void }

    expect(() => { service.onBoundary(agent.session) }).not.toThrow()
    expect(agent.session.snapshotEvents().some(event => event.type === 'plan/mode')).toBe(false)
  })

  it('flushes from pre-step before the following step/start', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    openTurn(agent.session)
    ctx.planMode.set(agent, true)
    await boundary(ctx, agent, 'pre-step')
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(true)
    expect(ctx.planMode.get(agent)).toEqual({ active: true })
  })

  it('removes the pre-step flush when the plugin fiber is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await mountProjectionSeam(ctx)
    const fiber = await ctx.plugin(PlanModeController, PLAN_CONFIG)
    const agent = await agentWithSession(ctx)
    openTurn(agent.session)
    ctx.planMode.set(agent, true)
    await fiber.dispose()
    await boundary(ctx, agent, 'pre-step')
    expect(agent.session.snapshotEvents().some(event => event.type === 'plan/mode')).toBe(false)
  })

  it('flushes at the between-step seam too', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    ctx.planMode.set(agent, true)
    await boundary(ctx, agent, 'step-start')
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(true)
  })


  it('nets out a flip sequence that returns to the folded mode (no append, no notice)', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    openTurn(agent.session)
    ctx.planMode.set(agent, true)
    ctx.planMode.set(agent, false)
    await boundary(ctx, agent, 'pre-step')
    expect(agent.session.snapshotEvents().some(event => event.type === 'plan/mode')).toBe(false)
    expect(noticeTexts(agent.session)).toEqual([])
  })

  it('narrates nothing before the first request header (the section is the state statement)', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    ctx.planMode.set(agent, true)
    await boundary(ctx, agent, 'pre-step')
    expect(noticeTexts(agent.session)).toEqual([])
  })

  it('narrates once when the flushed mode differs from what the last header told the model', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    header(agent.session)
    ctx.planMode.set(agent, true)
    await boundary(ctx, agent, 'step-start')
    expect(noticeTexts(agent.session)).toEqual(['The user switched this session to plan mode.'])
    await boundary(ctx, agent, 'step-start')
    expect(noticeTexts(agent.session)).toEqual(['The user switched this session to plan mode.'])
  })

  it('narrates a switch back to the default mode with the default wording', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    agent.session.append('plan/mode', { active: true })
    header(agent.session)
    ctx.planMode.set(agent, false)
    await boundary(ctx, agent, 'step-start')
    expect(noticeTexts(agent.session)).toEqual(['The user switched this session back to the default mode.'])
  })

  it('stays silent when the header already reflects the flushed mode', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    agent.session.append('plan/mode', { active: true })
    header(agent.session)
    agent.session.append('plan/mode', { active: false })
    ctx.planMode.set(agent, true)
    await boundary(ctx, agent, 'step-start')
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(true)
    expect(noticeTexts(agent.session)).toEqual([])
  })


  it('contains an append failure instead of blocking the prompt or the turn', async () => {
    const ctx = await setup()
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    const agent = await agentWithSession(ctx)
    openTurn(agent.session)
    ctx.planMode.set(agent, true)
    const original = agent.session.append.bind(agent.session)
    // Only the flush's own plan/mode append fails; the boundary event itself
    // lands (the loop appended it before the between-step hook fires).
    agent.session.append = (((type: string, ...rest: unknown[]) => {
      if (type === 'plan/mode') throw new Error('backend gone')
      return (original as (...args: unknown[]) => unknown)(type, ...rest)
    }) as unknown) as typeof agent.session.append
    await boundary(ctx, agent, 'step-start')
    expect(warn).toHaveBeenCalledOnce()
    // The failed flush re-parks the intent (cleared only after a landed
    // append), so the next healthy boundary converges the log with the
    // picker's optimistic state instead of dropping the switch forever.
    expect(ctx.planMode.get(agent)).toEqual({ active: false, pending: true })
    agent.session.append = original
    await boundary(ctx, agent, 'step-start')
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(true)
    expect(ctx.planMode.get(agent).pending).toBeUndefined()
  })

  it('contains a pre-step append failure and keeps the intent pending', async () => {
    const ctx = await setup()
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    const agent = await agentWithSession(ctx)
    openTurn(agent.session)
    ctx.planMode.set(agent, true)
    const original = agent.session.append.bind(agent.session)
    agent.session.append = (((type: string, ...rest: unknown[]) => {
      if (type === 'plan/mode') throw new Error('backend gone')
      return (original as (...args: unknown[]) => unknown)(type, ...rest)
    }) as unknown) as typeof agent.session.append
    await boundary(ctx, agent, 'pre-step')
    expect(warn).toHaveBeenCalledOnce()
    expect(ctx.planMode.get(agent)).toEqual({ active: false, pending: true })
  })
})

describe('the soft layer', () => {
  it('keeps the tool schemas identical across default and plan mode', async () => {
    const ctx = await setup()
    registerNamedTools(ctx, ['read', 'write'])
    const agent = await agentWithSession(ctx)
    const defaultAssembly = await assembleFor(ctx, agent)
    expect(defaultAssembly.tools.map(tool => tool.name)).toEqual([EXIT_PLAN_MODE, 'read', 'write'])
    expect(defaultAssembly.sections.find(section => section.name === 'plan:policy')?.text).toBe('')

    agent.session.append('plan/mode', { active: true })
    const planAssembly = await assembleFor(ctx, agent)
    expect(planAssembly.tools).toEqual(defaultAssembly.tools)
    expect(planAssembly.sections.find(section => section.name === 'plan:policy')?.text).toBe(TEST_PLAN_SECTION)
  })

  it('leaves an agent-less assembly untouched', async () => {
    const ctx = await setup()
    registerNamedTools(ctx, ['read'])
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.tools.map(tool => tool.name)).toEqual([EXIT_PLAN_MODE, 'read'])
    expect(assembly.sections.find(section => section.name === 'plan:policy')?.text).toBe('')
  })

  it('keeps the full toolset in plan mode and renders the configured mode section', async () => {
    const ctx = await setup()
    registerNamedTools(ctx, ['read', 'write', 'todo_write'])
    const agent = await agentWithSession(ctx, 'agent-1', { active: true })
    const assembly = await assembleFor(ctx, agent)
    expect(assembly.tools.map(tool => tool.name).sort()).toEqual([EXIT_PLAN_MODE, 'read', 'todo_write', 'write'])
    expect(assembly.sections.find(section => section.name === 'plan:policy')?.text).toBe(TEST_PLAN_SECTION)
  })

  it('leaves foreign assemble additions alone (no assemble-layer filtering)', async () => {
    // Plan guidance does not filter the registry or later assembly additions.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await mountProjectionSeam(ctx)
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const final = await next()
      final.tools = [...final.tools, { name: 'added-later', description: 'added after next()', parameters: {} }]
      return final
    })
    await ctx.plugin(PlanModeController, PLAN_CONFIG)
    registerNamedTools(ctx, ['read'])
    const planning = await agentWithSession(ctx, 'planning', { active: true })
    expect((await assembleFor(ctx, planning)).tools.map(tool => tool.name))
      .toEqual(['exit_plan_mode', 'read', 'added-later'])
    const defaulted = await agentWithSession(ctx, 'defaulted')
    expect((await assembleFor(ctx, defaulted)).tools.map(tool => tool.name))
      .toEqual(['exit_plan_mode', 'read', 'added-later'])
  })

  it('keeps run_code the only wire tool in plan mode under the registry PTC mode; the SDK gains the exit binding', async () => {
    // Minimal scriptable runtime: the SDK section resolves ctx.codeRuntime at
    // assembly time (the ptc.spec fake's shape).
    class FakeRuntime extends CodeRuntime {
      readonly language = 'typescript'
      readonly isolation = 'fake'
      run(_request: CodeRunRequest): Promise<CodeRunResult> { return Promise.resolve({ logs: [] }) }
    }
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { mode: 'ptc' })
    await ctx.plugin(FakeRuntime)
    await mountProjectionSeam(ctx)
    await ctx.plugin(PlanModeController, PLAN_CONFIG)
    registerNamedTools(ctx, ['read', 'write'])
    const agent = await agentWithSession(ctx, 'agent-1', { active: true })
    const assembly = await assembleFor(ctx, agent)
    expect(assembly.tools.map(tool => tool.name)).toEqual(['run_code'])
    // The SDK documents the full binding set plus the exit; plan mode never
    // prunes capabilities and restrains through guidance alone.
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
    expectPlanCodeSdkBindings(sdk)
  })

  it('keeps native wire schemas and the SDK in step under mode both', async () => {
    class FakeRuntime extends CodeRuntime {
      readonly language = 'typescript'
      readonly isolation = 'fake'
      run(_request: CodeRunRequest): Promise<CodeRunResult> { return Promise.resolve({ logs: [] }) }
    }
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { mode: 'both' })
    await ctx.plugin(FakeRuntime)
    await mountProjectionSeam(ctx)
    await ctx.plugin(PlanModeController, PLAN_CONFIG)
    registerNamedTools(ctx, ['read', 'write'])
    const agent = await agentWithSession(ctx, 'agent-1', { active: true })
    const assembly = await assembleFor(ctx, agent)
    // The stable registry contribution reaches both model interfaces: the exit tool
    // is present on the wire AND in the SDK alongside the untouched toolset.
    expect(assembly.tools.map(tool => tool.name).sort()).toEqual(['exit_plan_mode', 'read', 'run_code', 'write'])
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
    expectPlanCodeSdkBindings(sdk)
  })

  it('keeps the PTC mode SDK byte-identical across mode switches', async () => {
    class FakeRuntime extends CodeRuntime {
      readonly language = 'typescript'
      readonly isolation = 'fake'
      run(_request: CodeRunRequest): Promise<CodeRunResult> { return Promise.resolve({ logs: [] }) }
    }
    const withPlanMode = new Context()
    await withPlanMode.plugin(SystemPrompt)
    await withPlanMode.plugin(ToolRuntime, { mode: 'ptc' })
    await withPlanMode.plugin(FakeRuntime)
    await mountProjectionSeam(withPlanMode)
    await withPlanMode.plugin(PlanModeController, PLAN_CONFIG)
    registerNamedTools(withPlanMode, ['read', 'write'])
    const agent = await agentWithSession(withPlanMode)
    const defaultSdk = (await assembleFor(withPlanMode, agent)).sections.find(section => section.name === 'tools:sdk')?.text ?? ''
    expectPlanCodeSdkBindings(defaultSdk)
    agent.session.append('plan/mode', { active: true })
    const planSdk = (await assembleFor(withPlanMode, agent)).sections.find(section => section.name === 'tools:sdk')?.text ?? ''
    expect(planSdk).toBe(defaultSdk)

    // Loading the plan-mode plugin deliberately adds one stable binding compared
    // with a deployment that does not compose plan mode at all.
    const bare = new Context()
    await bare.plugin(SystemPrompt)
    await bare.plugin(ToolRuntime, { mode: 'ptc' })
    await bare.plugin(FakeRuntime)
    registerNamedTools(bare, ['read', 'write'])
    const bareSdk = (await bare.systemPrompt.assemble({ agent })).sections.find(section => section.name === 'tools:sdk')?.text ?? ''
    expect(bareSdk).not.toContain('exit_plan_mode:')
    expect(defaultSdk).not.toBe(bareSdk)
  })
})

describe('no execution gating beyond the exit tool', () => {
  it('passes agent-less and default-mode executions through', async () => {
    const ctx = await setup()
    registerNamedTools(ctx, ['write'])
    const agentless = await execute(ctx, 'write')
    expect(agentless.isError).toBe(false)
    const agent = await agentWithSession(ctx)
    const defaulted = await execute(ctx, 'write', agent)
    expect(defaulted.isError).toBe(false)
  })

  it('runs every call in plan mode untouched — guidance and enforcement are separate axes', async () => {
    const ctx = await setup()
    registerNamedTools(ctx, ['read', 'write', 'bash'])
    const agent = await agentWithSession(ctx, 'agent-1', { active: true })
    for (const name of ['read', 'write', 'bash']) {
      const result = await execute(ctx, name, agent)
      expect(result.isError).toBe(false)
    }
  })
})

describe('/plan', () => {
  it('registers only when a commands service is composed and optionally submits the next-step message', async () => {
    const bare = await setup()
    expect(bare.get('commands')).toBeUndefined()

    const ctx = await setup()
    await ctx.plugin(CommandRuntime)
    // The `ctx.inject` child mounts asynchronously once `commands` resolves.
    await new Promise(resolve => setImmediate(resolve))
    const plainAgent = await agentWithSession(ctx, 'plain-plan-command')
    openTurn(plainAgent.session)
    const plainSteer = vi.fn()
    ;(plainAgent as unknown as { steer: typeof plainSteer }).steer = plainSteer
    expect(ctx.commands.list(plainAgent)).toEqual([
      { name: 'plan', description: 'Enter or leave plan mode', input: { hint: '[off|message]', attachments: true } },
    ])

    const signal = new AbortController().signal
    expect(await ctx.commands.execute(plainAgent, '/mode', [], signal)).toBeUndefined()
    expect(await ctx.commands.execute(plainAgent, '/review', [], signal)).toBeUndefined()
    const plain = await ctx.commands.execute(plainAgent, '/plan', [], signal)
    expect(plain?.result).toEqual({
      kind: 'success',
      text: 'Entering plan mode (applies from the next step). Use /plan off to leave.',
    })
    expect(ctx.planMode.get(plainAgent)).toEqual({ active: false, pending: true })
    expect(plainSteer).not.toHaveBeenCalled()

    const messageAgent = await agentWithSession(ctx, 'message-plan-command')
    openTurn(messageAgent.session)
    const messageSteer = vi.fn()
    ;(messageAgent as unknown as { steer: typeof messageSteer }).steer = messageSteer
    const plan = await ctx.commands.execute(messageAgent, '/plan   draft the migration  ', [], signal)
    expect(plan?.result).toEqual({
      kind: 'success',
      text: 'Entering plan mode (applies from the next step). Use /plan off to leave.',
    })
    expect(ctx.planMode.get(messageAgent)).toEqual({ active: false, pending: true })
    expect(messageSteer).toHaveBeenCalledExactlyOnceWith({
      id: expect.any(String) as unknown,
      role: 'user',
      content: [{ type: 'text', text: 'draft the migration' }],
      source: { kind: 'user' },
    })
  })

  it('leaves active plan mode, cancels a pending entry, and treats inactive exit as idempotent', async () => {
    const ctx = await setup()
    await ctx.plugin(CommandRuntime)
    await new Promise(resolve => setImmediate(resolve))
    const signal = new AbortController().signal

    const inactive = await agentWithSession(ctx, 'inactive-plan-command')
    expect((await ctx.commands.execute(inactive, '/plan off', [], signal))?.result)
      .toEqual({ kind: 'success', text: 'Plan mode is already inactive.' })
    expect(ctx.planMode.get(inactive)).toEqual({ active: false })

    const entering = await agentWithSession(ctx, 'entering-plan-command')
    openTurn(entering.session)
    const enteringSteer = vi.fn()
    ;(entering as unknown as { steer: typeof enteringSteer }).steer = enteringSteer
    await ctx.commands.execute(entering, '/plan', [], signal)
    expect((await ctx.commands.execute(entering, '/plan off', [], signal))?.result)
      .toEqual({ kind: 'success', text: 'Plan mode entry cancelled.' })
    expect(ctx.planMode.get(entering)).toEqual({ active: false, pending: false })
    expect(enteringSteer).not.toHaveBeenCalled()
    await boundary(ctx, entering, 'step-start')
    expect(ctx.planMode.get(entering)).toEqual({ active: false })
    expect(entering.session.snapshotEvents().some(event => event.type === 'plan/mode')).toBe(false)

    const active = await agentWithSession(ctx, 'active-plan-command', { active: true })
    openTurn(active.session)
    const activeSteer = vi.fn()
    ;(active as unknown as { steer: typeof activeSteer }).steer = activeSteer
    expect((await ctx.commands.execute(active, '/plan off', [], signal))?.result)
      .toEqual({ kind: 'success', text: 'Leaving plan mode (applies from the next step).' })
    expect(ctx.planMode.get(active)).toEqual({ active: true, pending: false })
    expect((await ctx.commands.execute(active, '/plan off', [], signal))?.result)
      .toEqual({ kind: 'success', text: 'Leaving plan mode (applies from the next step).' })
    expect(activeSteer).not.toHaveBeenCalled()
    await boundary(ctx, active, 'step-start')
    expect(ctx.planMode.get(active)).toEqual({ active: false })
  })

  it('idle sessions get the immediate-commit copy on both /plan and /plan off', async () => {
    const ctx = await setup()
    await ctx.plugin(CommandRuntime)
    await new Promise(resolve => setImmediate(resolve))
    const signal = new AbortController().signal
    const agent = await agentWithSession(ctx, 'idle-plan-command')
    expect((await ctx.commands.execute(agent, '/plan', [], signal))?.result)
      .toEqual({ kind: 'success', text: 'Plan mode on. Use /plan off to leave.' })
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(true)
    expect((await ctx.commands.execute(agent, '/plan off', [], signal))?.result)
      .toEqual({ kind: 'success', text: 'Plan mode off.' })
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(false)
  })

  it('steers mixed attachments with or without text and refuses them on /plan off', async () => {
    const ctx = await setup()
    await ctx.plugin(CommandRuntime)
    await new Promise(resolve => setImmediate(resolve))
    let saved = 0
    const saveImage = (input: { mediaType: string }) => {
      saved += 1
      return Promise.resolve({
        attachmentId: `att-${saved}`, mediaType: input.mediaType, bytes: 3, width: 1, height: 1,
      })
    }
    ctx.provide('attachments', {
      imageLimits: {
        maxImageBytes: 1024, maxImagesPerMessage: 4, maxMessageImageBytes: 1024,
        maxImagePixels: 1_000_000, mediaTypes: ['image/png'],
      },
      validateImage: () => Promise.resolve(),
      saveImage,
      async saveImages(inputs: readonly { mediaType: string }[]) {
        const refs = []
        for (const input of inputs) refs.push(await saveImage(input))
        return refs
      },
      saveFile(input: { data: Uint8Array; name?: string }) {
        saved += 1
        return Promise.resolve({
          attachmentId: `att-${saved}`, bytes: input.data.byteLength, name: input.name ?? 'attachment',
        })
      },
    })
    ctx.commands.registerFileReceiptResolver((agent, receiptId) => receiptId === 'receipt-notes'
      ? { attachmentId: `file-${agent.id}` as never, bytes: 5, name: 'notes.txt' }
      : undefined)
    const signal = new AbortController().signal
    const attachments = [
      { type: 'image' as const, mediaType: 'image/png' as const, data: 'AAAA', name: 'diagram.png' },
      { type: 'file' as const, receiptId: 'receipt-notes' },
    ]

    const agent = await agentWithSession(ctx, 'imaged-plan-command')
    openTurn(agent.session)
    const steer = vi.fn()
    ;(agent as unknown as { steer: typeof steer }).steer = steer
    const withMessage = await ctx.commands.execute(agent, '/plan sketch the layout', attachments, signal)
    expect(withMessage?.result.kind).toBe('success')
    expect(steer).toHaveBeenCalledExactlyOnceWith({
      id: expect.any(String) as unknown,
      role: 'user',
      content: [
        { type: 'image', attachment: expect.objectContaining({ attachmentId: 'att-1' }) as unknown },
        { type: 'file', attachment: expect.objectContaining({ attachmentId: 'file-imaged-plan-command', name: 'notes.txt' }) as unknown },
        { type: 'text', text: 'sketch the layout' },
      ],
      source: { kind: 'user' },
    })

    const bareAgent = await agentWithSession(ctx, 'imaged-bare-plan-command')
    openTurn(bareAgent.session)
    const bareSteer = vi.fn()
    ;(bareAgent as unknown as { steer: typeof bareSteer }).steer = bareSteer
    expect((await ctx.commands.execute(bareAgent, '/plan', attachments, signal))?.result)
      .toEqual({ kind: 'success', text: 'Entering plan mode (applies from the next step). Use /plan off to leave.' })
    expect(bareSteer).toHaveBeenCalledExactlyOnceWith({
      id: expect.any(String) as unknown,
      role: 'user',
      content: [
        { type: 'image', attachment: expect.objectContaining({ attachmentId: 'att-2' }) as unknown },
        { type: 'file', attachment: expect.objectContaining({ attachmentId: 'file-imaged-bare-plan-command', name: 'notes.txt' }) as unknown },
      ],
      source: { kind: 'user' },
    })
    expect(ctx.planMode.get(bareAgent)).toEqual({ active: false, pending: true })

    const activeAgent = await agentWithSession(ctx, 'imaged-off-plan-command', { active: true })
    const offSteer = vi.fn()
    ;(activeAgent as unknown as { steer: typeof offSteer }).steer = offSteer
    expect((await ctx.commands.execute(activeAgent, '/plan off', attachments, signal))?.result)
      .toEqual({ kind: 'error', text: 'Attachments cannot accompany /plan off.' })
    expect(offSteer).not.toHaveBeenCalled()
    expect(ctx.planMode.get(activeAgent)).toEqual({ active: true })
  })

  it('removes the contributed command when the plan-mode plugin is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(CommandRuntime)
    await mountProjectionSeam(ctx)
    const fiber = await ctx.plugin(PlanModeController, PLAN_CONFIG)
    await new Promise(resolve => setImmediate(resolve))
    const agent = await agentWithSession(ctx)
    expect(ctx.commands.list(agent).map(command => command.name)).toEqual(['plan'])

    await fiber.dispose()

    expect(ctx.commands.list(agent)).toEqual([])
  })
})

describe('exit_plan_mode', () => {
  async function setupWithReview(answer?: { selected: string[]; custom?: string }) {
    const ctx = await setup()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const asked: AskUserQuestionRequest[] = []
    if (answer !== undefined) {
      registerQuestionAnswerer(ctx, {
        ask: (request) => {
          asked.push(request)
          return Promise.resolve({ answers: [{ id: 'plan-review', ...answer }] })
        },
      })
    }
    const agent = await agentWithSession(ctx, 'agent-1', { active: true })
    return { ctx, agent, asked }
  }

  function callExit(ctx: Context, agent: Agent | undefined, plan = '# The plan\n\ndo things') {
    return ctx.tools.execute({
      callId: ToolCallId(`call-exit-${++callCounter}`),
      name: EXIT_PLAN_MODE,
      arguments: { plan },
      signal: new AbortController().signal,
      ...agent ? { agent } : {},
    })
  }

  it('registers the tool with one required plan argument', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(entry => entry.name === EXIT_PLAN_MODE)
    const parameters = schema?.parameters as { required?: string[]; properties?: Record<string, unknown> }
    expect(schema?.description).toMatch(/^Use only in plan mode\./)
    expect(Object.keys(parameters.properties ?? {})).toEqual(['plan'])
    expect(parameters.required).toEqual(['plan'])
  })

  it('rejects an agent-less call', async () => {
    const ctx = await setup()
    const result = await callExit(ctx, undefined)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: exit_plan_mode requires a calling agent (no session to switch)' }])
  })

  it('rejects a call outside plan mode while remaining advertised', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx)
    expect(ctx.tools.schemas().map(tool => tool.name)).toContain(EXIT_PLAN_MODE)
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: exit_plan_mode is only available in plan mode' }])
  })

  it('rejects an empty or heading-less plan before asking the reviewer', async () => {
    const { ctx, agent, asked } = await setupWithReview({ selected: ['Approve'] })
    for (const plan of ['', 'do things']) {
      const result = await callExit(ctx, agent, plan)
      expect(result.isError).toBe(true)
      expect(result.content).toEqual([{ type: 'text', text: 'Error: exit_plan_mode requires a non-empty markdown plan starting with a # heading' }])
    }
    expect(asked).toHaveLength(0)
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(true)
  })

  it('degrades to the manual exit when no user-questions seam is composed', async () => {
    const ctx = await setup()
    const agent = await agentWithSession(ctx, 'agent-1', { active: true })
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: no user-questions channel is available to review the plan; ask the user to switch the session mode instead' }])
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(true)
  })

  it('degrades the same way when the seam has no provider (NO_PROVIDER)', async () => {
    const { ctx, agent } = await setupWithReview()
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: no user-questions answerer accepted the request' }])
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(true)
  })

  it('rejects review from a runtime-owned agent with consumer-neutral guidance', async () => {
    const ctx = await setup()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const ask = vi.fn(async () => ({ answers: [{ id: 'plan-review', selected: ['Approve'] }] }))
    registerQuestionAnswerer(ctx, { ask })
    const root = await agentWithSession(ctx, 'review-root')
    const child = await agentWithSession(ctx, 'review-child', { active: true, owner: root })

    const result = await callExit(ctx, child)

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{
      type: 'text',
      text: "Error: human interaction is unavailable while the calling agent is owned by another live agent; include the unresolved question or decision in the child agent's final result",
    }])
    expect(ask).not.toHaveBeenCalled()
    expect(foldPlanMode(child.session.snapshotEvents())).toBe(true)
  })

  it('approve: records the boundary-applied switch and confirms (the fold flips at the flush)', async () => {
    const { ctx, agent, asked } = await setupWithReview({ selected: ['Approve'] })
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected approved plan result')
    expect(result.value).toEqual({ approved: true })
    expect(result.content).toEqual([{ type: 'text', text: 'Plan approved — plan mode exited; carry out the plan starting with your next step.' }])
    // Boundary-applied, not a direct append: the fold stays plan until the
    // step's end, so the plan policy covers any remaining call of the SAME batch.
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(true)
    expect(ctx.planMode.get(agent)).toEqual({ active: true, pending: false })
    await boundary(ctx, agent, 'step-start')
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(false)
    expect(asked).toHaveLength(1)
    expect(asked[0]?.agent).toBe(agent)
    expect(asked[0]?.questions[0]?.detail).toBe('# The plan\n\ndo things')
    expect(asked[0]?.questions[0]?.options?.map(option => option.label)).toEqual(['Approve', 'Keep planning'])
  })

  it('carries the exact plan through a PTC mode review and logs the nested dispatch', async () => {
    const plan = '# PTC mode plan\n\nUse the existing seam.'
    class ExitRuntime extends CodeRuntime {
      readonly language = 'typescript'
      readonly isolation = 'fake'
      async run(request: CodeRunRequest): Promise<CodeRunResult> {
        const exit = request.bindings[0]?.functions[EXIT_PLAN_MODE]
        if (exit === undefined) throw new Error('missing exit_plan_mode binding')
        return { logs: [], value: await exit({ plan }) }
      }
    }
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { mode: 'ptc' })
    await ctx.plugin(ExitRuntime)
    await mountProjectionSeam(ctx)
    await ctx.plugin(PlanModeController, PLAN_CONFIG)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const asked: AskUserQuestionRequest[] = []
    registerQuestionAnswerer(ctx, {
      ask: (request) => {
        asked.push(request)
        return Promise.resolve({ answers: [{ id: 'plan-review', selected: ['Approve'] }] })
      },
    })
    const agent = await agentWithSession(ctx, 'ptc-exit', { active: true })

    const result = await ctx.tools.execute({
      callId: ToolCallId(`call-exit-${++callCounter}`),
      name: RUN_CODE_NAME,
      arguments: { code: `return await tools.${EXIT_PLAN_MODE}({ plan: ${JSON.stringify(plan)} })`, description: 'Submit the plan for review' },
      signal: new AbortController().signal,
      agent,
    })

    expect(result.isError).toBe(false)
    expect(asked).toHaveLength(1)
    expect(asked[0]?.questions[0]).toMatchObject({
      header: 'Plan review',
      question: 'Approve this plan and leave plan mode?',
      detail: plan,
    })
    expect(agent.session.snapshotEvents().find(event => event.type === 'tool/code-dispatch')?.data).toMatchObject({
      name: EXIT_PLAN_MODE,
      arguments: { plan },
      isError: false,
    })
    expect(ctx.planMode.get(agent)).toEqual({ active: true, pending: false })
  })

  it('an approved exit projects the next assembly before the boundary and never removes the tool', async () => {
    const { ctx, agent } = await setupWithReview({ selected: ['Approve'] })
    const approved = await callExit(ctx, agent)
    expect(approved.isError).toBe(false)
    // Calls of the SAME assistant response were requested under the existing
    // plan-shaped header. Pending state shapes only the proposed next
    // assembly; the accepted boundary then commits the matching durable fold.
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(true)
    const assembly = await ctx.systemPrompt.assemble({ agent })
    expect(assembly.tools.some(tool => tool.name === EXIT_PLAN_MODE)).toBe(true)
    expect(assembly.sections.find(section => section.name === 'plan:policy')?.text).toBe('')
    await boundary(ctx, agent, 'step-start')
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(false)
    const afterExit = await ctx.systemPrompt.assemble({ agent })
    expect(afterExit.tools).toEqual(assembly.tools)
    expect(afterExit.sections.find(section => section.name === 'plan:policy')?.text).toBe('')
  })

  it('the exit flush narrates nothing — the tool result is the narration', async () => {
    const { ctx, agent } = await setupWithReview({ selected: ['Approve'] })
    header(agent.session)
    await callExit(ctx, agent)
    await boundary(ctx, agent, 'step-start')
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(false)
    expect(noticeTexts(agent.session)).toEqual([])
  })

  it('keep planning returns the corrective error carrying the feedback verbatim', async () => {
    const { ctx, agent } = await setupWithReview({ selected: ['Keep planning'], custom: 'consider the resume path' })
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: The user chose to keep planning; their feedback: consider the resume path' }])
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(true)
  })

  it('keep planning without feedback returns the generic corrective error', async () => {
    const { ctx, agent } = await setupWithReview({ selected: ['Keep planning'] })
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: The user chose to keep planning; revise the plan and present it again.' }])
  })

  it('a custom-text-only answer is feedback, never consent', async () => {
    const { ctx, agent } = await setupWithReview({ selected: [], custom: 'add tests first' })
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: The user chose to keep planning; their feedback: add tests first' }])
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(true)
  })

  it('requires exactly the single Approve selection', async () => {
    const { ctx, agent } = await setupWithReview({ selected: ['Approve', 'Keep planning'] })
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: The user chose to keep planning; revise the plan and present it again.' }])
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(true)
  })

  it('treats custom text alongside Approve as feedback, not consent', async () => {
    const { ctx, agent } = await setupWithReview({ selected: ['Approve'], custom: 'change the tests' })
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: The user chose to keep planning; their feedback: change the tests' }])
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(true)
  })

  it('treats duplicate review answer items as non-consent', async () => {
    const { ctx, agent } = await setupWithReview()
    registerQuestionAnswerer(ctx, {
      ask: () => Promise.resolve({ answers: [
        { id: 'plan-review', selected: ['Approve'] },
        { id: 'plan-review', selected: ['Keep planning'] },
      ] }),
    })
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: The user chose to keep planning; revise the plan and present it again.' }])
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(true)
  })

  it('a missing answer item reads as keep-planning', async () => {
    const { ctx, agent } = await setupWithReview()
    registerQuestionAnswerer(ctx, { ask: () => Promise.resolve({ answers: [] }) })
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: The user chose to keep planning; revise the plan and present it again.' }])
  })

  it('declares the plan-review presentation intent naming its approve option', async () => {
    const { ctx, agent, asked } = await setupWithReview({ selected: ['Approve'] })
    await callExit(ctx, agent)
    const question = asked[0]?.questions[0]
    expect(question?.intent).toEqual({ kind: 'plan-review', approve: 'Approve' })
    // The named label is one this same question offers, so a UI honouring the
    // intent answers a choice this tool accepts.
    expect(question?.options?.map(option => option.label)).toContain(question?.intent?.approve)
  })

  it('reads a dismissed review as the user taking the turn back, not as a failure', async () => {
    const { ctx, agent } = await setupWithReview()
    registerQuestionAnswerer(ctx, {
      ask: () => Promise.reject(Object.assign(
        new Error('the user cancelled ask_user_question'),
        { name: 'UserQuestionError', code: 'ASK_CANCELLED' },
      )),
    })
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: The user dismissed the plan review to speak instead; stay in plan mode, stop here, and wait for their message.' }])
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(true)
  })

  it('leaves every other review failure its own message', async () => {
    const { ctx, agent } = await setupWithReview()
    registerQuestionAnswerer(ctx, {
      ask: () => Promise.reject(new UserQuestionError(
        'ask_user_question was aborted before the user answered', 'ASK_ABORTED')),
    })
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: ask_user_question was aborted before the user answered' }])
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(true)
  })

  it('forwards the execution abort signal to the review question', async () => {
    const { ctx, agent, asked } = await setupWithReview({ selected: ['Approve'] })
    const controller = new AbortController()
    const result = await ctx.tools.execute({
      callId: ToolCallId(`call-exit-${++callCounter}`),
      name: EXIT_PLAN_MODE,
      arguments: { plan: '# P' },
      agent,
      signal: controller.signal,
    })
    expect(result.isError).toBe(false)
    expect(asked[0]?.signal).toBe(controller.signal)
  })

  it('fails the call when the plugin is disposed while the review awaits (no phantom exit)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await mountProjectionSeam(ctx)
    const fiber = await ctx.plugin(PlanModeController, PLAN_CONFIG)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    let answer!: (value: { answers: { id: string; selected: string[] }[] }) => void
    registerQuestionAnswerer(ctx, {
      ask: () => new Promise((resolve) => { answer = resolve }),
    })
    const agent = await agentWithSession(ctx, 'agent-1', { active: true })
    const pending = callExit(ctx, agent)
    // Let execute reach the review await, then unload the plugin (HMR) and
    // only afterwards approve. The boundary listeners are gone, so a success
    // would claim an exit that can never flush — the call must fail instead.
    await new Promise(resolve => setImmediate(resolve))
    await fiber.dispose()
    answer({ answers: [{ id: 'plan-review', selected: ['Approve'] }] })
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: the plan-mode service was reloaded while the plan was under review; present the plan again' }])
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(true)
  })

  it('a throwing provider surfaces as the corrective isError and the mode stays plan', async () => {
    const { ctx, agent } = await setupWithReview()
    registerQuestionAnswerer(ctx, { ask: () => { throw new Error('review aborted') } })
    const result = await callExit(ctx, agent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: review aborted' }])
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(true)
  })

  it('presents the call as a generic card titled by the plan first heading', async () => {
    const ctx = await setup()
    const def = ctx.tools.get(EXIT_PLAN_MODE)!
    expect(def.presentCall?.({ plan: '## Fix the flake\n\nsteps' })).toEqual({
      card: 'generic',
      title: 'Fix the flake',
      kind: 'other',
      content: [{ type: 'text', text: '## Fix the flake\n\nsteps' }],
    })
    expect(def.presentCall?.({ plan: 'no heading here' })).toEqual({
      card: 'generic',
      title: 'Plan',
      kind: 'other',
      content: [{ type: 'text', text: 'no heading here' }],
    })
  })

  it('presents the result as a generic review card', async () => {
    const ctx = await setup()
    const def = ctx.tools.get(EXIT_PLAN_MODE)!
    const content = [{ type: 'text' as const, text: 'ok' }]
    expect(def.presentResult?.({ plan: '# P' }, { content, isError: false })).toEqual({
      card: 'generic',
      title: 'Plan review',
      content,
    })
  })
})

describe('HMR disposal', () => {
  it('unregisters the service, listeners, prompt section, and stable exit tool with the plugin fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await mountProjectionSeam(ctx)
    const fiber = await ctx.plugin(PlanModeController, PLAN_CONFIG)
    const agent = await agentWithSession(ctx, 'disposed-recovery')
    openTurn(agent.session)
    ctx.planMode.set(agent, true)
    expect(ctx.get('planMode')).toBeInstanceOf(PlanModeController)
    expect(ctx.tools.get(EXIT_PLAN_MODE)).toBeDefined()
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name)).toContain('plan:policy')

    await fiber.dispose()
    expect(ctx.get('planMode')).toBeUndefined()
    expect(ctx.tools.get(EXIT_PLAN_MODE)).toBeUndefined()
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name)).not.toContain('plan:policy')
    await boundary(ctx, agent, 'step-start')
    expect(agent.session.snapshotEvents().some(event => event.type === 'plan/mode')).toBe(false)
  })
})
