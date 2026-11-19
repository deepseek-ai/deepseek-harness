/** Per-prompt user time zones recorded on SDK prompt sources. */
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import PlanMode from '@deepseek-ai/dsh-plan-mode'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { HarnessSdkJsonRpcServer } from '../src/server.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * Answer the zone-less `Intl.DateTimeFormat()` process-zone samples in order; zone-qualified validation stays real.
 * Spying keeps the change local to this worker, while assigning `process.env.TZ` would change the zone process-wide.
 */
function sampleProcessZones(...zones: (string | undefined)[]): void {
  const RealDateTimeFormat = Intl.DateTimeFormat
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
    if (args.length > 0) return new RealDateTimeFormat(...args)
    const timeZone = zones.shift()
    return { resolvedOptions: () => ({ timeZone }) } as Intl.DateTimeFormat
  })
}

/** Initialized SDK server over a real AgentLoop whose model answers each turn with `READY`. */
async function zoneServer(turns: number, options: { planMode?: boolean } = {}) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(AgentLoop, { agents: [] })
  if (options.planMode === true) {
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(PlanMode, { section: 'You are in plan mode.' })
  }
  const responses = Array.from({ length: turns }, () => textResponse('READY'))
  ctx.effect(() => ctx.llm.registerAdapter(['zone'], new MockAdapter(responses)))
  const server = new HarnessSdkJsonRpcServer(ctx, { request: () => Promise.reject(new Error('unused')), notify: () => {} })
  onTestFinished(async () => { await server.shutdown() })
  await server.initialize({ cwd: process.cwd(), provider: 'zone', model: 'model' })
  /** Wait for the Session to settle, then read the committed sources of its human-input messages. */
  const sources = async (sessionId: string) => {
    await server.wait({ sessionId: brandString<SessionId>(sessionId) })
    const agent = ctx.agents.get(brandString<SessionId>(sessionId))
    if (agent === undefined) throw new Error(`no Agent for ${sessionId}`)
    return agent.session.snapshotEvents()
      .flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user' ? [event.data.source] : [])
  }
  return { ctx, server, sources }
}

const TEXT = [{ type: 'text' as const, text: 'when is noon?' }]

describe('SDK prompt time zone', () => {
  it.each([
    ['UTC', 'UTC'],
    ['Asia/Shanghai', 'Asia/Shanghai'],
    ['US/Eastern', 'America/New_York'],
  ])('records explicit %s as canonical %s', async (timeZone, canonical) => {
    const h = await zoneServer(1)
    await h.server.handleRequest('session/prompt', { sessionId: 'zone', contentBlocks: TEXT, timeZone })
    expect(await h.sources('zone')).toEqual([{ kind: 'user', clientTimeZone: canonical }])
  })

  it.each(['', ' UTC', 'CST', '+08:00', 'Not/A_Real_Zone'])('rejects explicit %j before creating a Session', async (timeZone) => {
    const h = await zoneServer(0)
    await expect(h.server.handleRequest('session/prompt', { sessionId: 'zone', contentBlocks: TEXT, timeZone }))
      .rejects.toThrow(new TypeError(`timeZone must be UTC or a valid IANA Area/Location name: ${JSON.stringify(timeZone)}`))
    expect(h.ctx.agents.get(brandString<SessionId>('zone'))).toBeUndefined()
  })

  it.each(['session/prompt', 'session/query'])('rejects a non-string %s timeZone', async (method) => {
    const h = await zoneServer(0)
    await expect(h.server.handleRequest(method, { sessionId: 'zone', contentBlocks: TEXT, timeZone: 8 }))
      .rejects.toThrow(new TypeError(`${method} timeZone must be a string`))
    expect(h.ctx.agents.get(brandString<SessionId>('zone'))).toBeUndefined()
  })

  it('samples the process zone separately for each omitted prompt', async () => {
    const h = await zoneServer(2)
    sampleProcessZones('Asia/Shanghai', 'US/Eastern')
    await h.server.prompt({ sessionId: 'zone', contentBlocks: TEXT })
    await h.sources('zone')
    await h.server.prompt({ sessionId: 'zone', contentBlocks: TEXT })
    expect(await h.sources('zone')).toEqual([
      { kind: 'user', clientTimeZone: 'Asia/Shanghai' },
      { kind: 'user', clientTimeZone: 'America/New_York' },
    ])
  })

  // ICU reports TZ=GMT as "+00:00", an empty TZ as "Etc/Unknown", and an unknown TZ name as no zone.
  it.each(['+00:00', 'Etc/Unknown', undefined])('records no zone when the sampled process zone is %j', async (sampled) => {
    const h = await zoneServer(1)
    sampleProcessZones(sampled)
    await expect(h.server.prompt({ sessionId: 'zone', contentBlocks: TEXT })).resolves.toHaveProperty('messageId')
    expect(await h.sources('zone')).toEqual([{ kind: 'user' }])
  })

  it('forwards the session/query prompt zone and rejects an invalid one before routing', async () => {
    const h = await zoneServer(2)
    await expect(h.server.handleRequest('session/query', { sessionId: 'zone', contentBlocks: TEXT, timeZone: 'US/Eastern' }))
      .resolves.toMatchObject({ kind: 'prompt' })
    await h.sources('zone')
    sampleProcessZones('Europe/London')
    await h.server.handleRequest('session/query', { sessionId: 'zone', contentBlocks: TEXT })
    await expect(h.server.handleRequest('session/query', { sessionId: 'zone', contentBlocks: TEXT, timeZone: 'CST' }))
      .rejects.toThrow('timeZone must be UTC or a valid IANA Area/Location name: "CST"')
    expect(await h.sources('zone')).toEqual([
      { kind: 'user', clientTimeZone: 'America/New_York' },
      { kind: 'user', clientTimeZone: 'Europe/London' },
    ])
  })
})

/** Run one `/plan <text>` line through the SDK query entry or the native command entry that Web uses. */
async function planMessageSources(path: 'sdk' | 'native') {
  const h = await zoneServer(2, { planMode: true })
  const sessionId = `plan-${path}`
  await h.server.prompt({ sessionId, contentBlocks: [{ type: 'text', text: 'Begin.' }], timeZone: 'Asia/Shanghai' })
  await h.sources(sessionId)
  const agent = h.ctx.agents.get(brandString<SessionId>(sessionId))
  if (agent === undefined) throw new Error('The initial prompt did not create its Agent')
  const line = '/plan Design the change.'
  if (path === 'sdk') {
    expect(await h.server.query({ sessionId: brandString<SessionId>(sessionId), contentBlocks: [{ type: 'text', text: line }], timeZone: 'Asia/Shanghai' }))
      .toMatchObject({ kind: 'command' })
  } else {
    expect(await h.ctx.commands.execute(agent, line, [], new AbortController().signal)).toBeDefined()
  }
  return h.sources(sessionId)
}

describe('SDK native command time zone', () => {
  // Web executes commands without a client zone, so `/plan <text>` steers a zone-less user message on both entries.
  it('records no zone on the /plan message, matching the Web command entry', async () => {
    const sdk = await planMessageSources('sdk')
    expect(sdk).toEqual(await planMessageSources('native'))
    expect(sdk).toEqual([
      { kind: 'user', clientTimeZone: 'Asia/Shanghai' },
      { kind: 'user' },
    ])
  })
})
