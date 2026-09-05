/**
 * Fixture commands/skills domains: session-addressed catalogs, execute
 * parse/dispatch and its logged lifecycle pair, and skills/list Session resolution.
 */
import { describe, expect, it } from 'vitest'
import type { SessionId } from '../src/client/api.ts'
import { createFixtureFaces } from '../src/client/fixture.ts'

/** Drive one commands Remote endpoint against the fixture state graph. */
async function callRemote<T>(
  rpc: ReturnType<typeof createFixtureFaces>['rpc'],
  endpoint: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await rpc.call('/api', endpoint, { args })
  if (!result.ok) throw new Error(`${endpoint} failed: ${result.error.code}`)
  return result.value as T
}

const sid = (id: string): SessionId => id as SessionId

describe('createFixtureApi commands/skills', () => {
  it('serves the addressed session catalog', async () => {
    const { rpc } = createFixtureFaces()
    const commands = await callRemote<{ name: string; input?: { hint: string; attachments?: boolean } }[]>(
      rpc, 'commands/list', { agentId: sid('fx-alpha') })
    expect(commands.map(c => c.name)).toEqual(['compact', 'echo', 'goal', 'permission', 'plan'])
    // input hint rides only the commands declaring it.
    const echo = commands.find(c => c.name === 'echo')
    expect(echo?.input?.hint).toBeTruthy()
    expect(commands.find(c => c.name === 'compact')?.input).toBeUndefined()
    // Image acceptance is declared per descriptor; only goal and plan carry it.
    expect(commands.filter(c => c.input?.attachments === true).map(c => c.name)).toEqual(['goal', 'plan'])
  })

  it('rejects a catalog request for an unknown session', async () => {
    const { rpc } = createFixtureFaces()
    const result = await rpc.call('/api', 'commands/list', { args: { agentId: sid('fx-nope') } })
    expect(result).toMatchObject({ ok: false, error: { code: 'session/not-found' } })
  })

  it('executes a known command line: pure admission plus a followed lifecycle pair', async () => {
    const { rpc } = createFixtureFaces()
    const frames: unknown[] = []
    const abort = new AbortController()
    const stream = rpc.open?.('/api', 'session/follow', {
      args: { request: { address: { kind: 'session', sessionId: sid('fx-alpha') } } },
    }, abort.signal)
    if (stream === undefined) throw new Error('fixture session follow stream is unavailable')
    const pump = (async () => {
      for await (const frame of stream) {
        frames.push(frame)
        if (frames.filter(f => (f as { type: string }).type === 'event').length >= 2) abort.abort()
      }
    })()
    const execution = await callRemote<{ commandId: string } | undefined>(
      rpc, 'commands/execute', { agentId: sid('fx-alpha'), line: '/echo hello world' })
    expect(execution?.commandId).toBeTruthy()
    await pump
    const events = frames
      .filter((f): f is { type: string; event: { type: string; data: Record<string, unknown> } } => (f as { type: string }).type === 'event')
      .map(f => f.event)
    expect(events).toMatchObject([
      { type: 'command/run', data: { name: 'echo', args: ' hello world', source: { kind: 'user' } } },
      { type: 'command/done', data: { kind: 'success', text: 'hello world' } },
    ])
    expect(events[0]?.data.commandId).toBe(events[1]?.data.commandId)
  })

  it('addresses execute to the session; an unknown session errs', async () => {
    const { rpc } = createFixtureFaces()
    const hit = await callRemote<{ commandId: string } | undefined>(
      rpc, 'commands/execute', { agentId: sid('fx-alpha'), line: '/goal ship' })
    expect(hit?.commandId).toBeTruthy()

    const missing = await rpc.call('/api', 'commands/execute', {
      args: { agentId: sid('fx-nope'), line: '/goal ship' },
    })
    expect(missing).toMatchObject({ ok: false, error: { code: 'session/not-found' } })
  })

  it('refuses an image-carrying execute for a non-declaring command with a logged error pair', async () => {
    const { rpc } = createFixtureFaces()
    const frames: unknown[] = []
    const abort = new AbortController()
    const stream = rpc.open?.('/api', 'session/follow', {
      args: { request: { address: { kind: 'session', sessionId: sid('fx-alpha') } } },
    }, abort.signal)
    if (stream === undefined) throw new Error('fixture session follow stream is unavailable')
    const pump = (async () => {
      for await (const frame of stream) {
        frames.push(frame)
        if (frames.filter(f => (f as { type: string }).type === 'event').length >= 2) abort.abort()
      }
    })()
    const png = { mediaType: 'image/png', data: 'AA==' }
    const refused = await callRemote<{ commandId: string; result: { kind: string; text?: string } } | undefined>(
      rpc, 'commands/execute', { agentId: sid('fx-alpha'), line: '/echo hi', images: [png] })
    expect(refused?.commandId).toBeTruthy()
    expect(refused?.result).toEqual({ kind: 'error', text: '/echo does not accept attachments' })
    await pump
    const events = frames
      .filter((f): f is { type: string; event: { type: string; data: Record<string, unknown> } } => (f as { type: string }).type === 'event')
      .map(f => f.event)
    expect(events).toMatchObject([
      { type: 'command/run', data: { name: 'echo', args: ' hi', source: { kind: 'user' } } },
      { type: 'command/done', data: { kind: 'error', text: '/echo does not accept attachments' } },
    ])
  })

  it('a declaring command accepts an image-carrying execute', async () => {
    const { rpc } = createFixtureFaces()
    const png = { mediaType: 'image/png', data: 'AA==' }
    const accepted = await callRemote<{ result: { kind: string } } | undefined>(
      rpc, 'commands/execute', { agentId: sid('fx-alpha'), line: '/goal ship it', images: [png] })
    expect(accepted?.result.kind).toBe('success')
    const planMessage = await callRemote<{ result: { kind: string } } | undefined>(
      rpc, 'commands/execute', { agentId: sid('fx-alpha'), line: '/plan sketch the layout', images: [png] })
    expect(planMessage?.result.kind).toBe('success')
    const imageOnlyPlan = await callRemote<{ result: { kind: string } } | undefined>(
      rpc, 'commands/execute', { agentId: sid('fx-alpha'), line: '/plan', images: [png] })
    expect(imageOnlyPlan?.result.kind).toBe('success')
  })

  it('mirrors the producer grammar rejections for control-only declaring lines', async () => {
    const { rpc } = createFixtureFaces()
    const png = { mediaType: 'image/png', data: 'AA==' }
    const bareGoal = await callRemote<{ result: { kind: string; text?: string } } | undefined>(
      rpc, 'commands/execute', { agentId: sid('fx-alpha'), line: '/goal', images: [png] })
    expect(bareGoal?.result).toEqual({
      kind: 'error',
      text: 'Attachments only accompany a goal objective: /goal <objective> or /goal edit <objective>.',
    })
    const refused = await callRemote<{ result: { kind: string; text?: string } } | undefined>(
      rpc, 'commands/execute', { agentId: sid('fx-alpha'), line: '/plan off', images: [png] })
    expect(refused?.result).toEqual({
      kind: 'error',
      text: 'Attachments cannot accompany /plan off.',
    })
  })

  it('answers no execution for an unknown name even when images accompany it', async () => {
    const { rpc } = createFixtureFaces()
    const png = { mediaType: 'image/png', data: 'AA==' }
    expect(await callRemote(rpc, 'commands/execute', { agentId: sid('fx-alpha'), line: '/nope', images: [png] }))
      .toBeUndefined()
  })

  it('answers no execution for unknown names and non-command lines', async () => {
    const { rpc } = createFixtureFaces()
    for (const line of ['/nope', 'plain text', '/']) {
      // Absence is the whole answer: nothing matched, so no lifecycle id exists.
      expect(await callRemote(rpc, 'commands/execute', { agentId: sid('fx-alpha'), line }))
        .toBeUndefined()
    }
  })

  it('serves the skill catalog for the addressed session and rejects unknown sessions', async () => {
    const { rpc } = createFixtureFaces()
    const skills = await callRemote<{ skills: Array<{ name: string }> }>(
      rpc, 'skills/list', { request: { sessionId: sid('fx-alpha') } },
    )
    expect(skills.skills[0]?.name).toBe('fixture-demo')

    const missingSession = await rpc.call('/api', 'skills/list', {
      args: { request: { sessionId: sid('fx-nope') } },
    })
    expect(missingSession).toMatchObject({ ok: false, error: { code: 'session/not-found' } })
  })
})

describe('fixture Connection command/skill dispatch', () => {
  it('routes the Remote command and skill rows through one state graph', async () => {
    const { rpc } = createFixtureFaces()
    const commands = await callRemote<{ name: string }[]>(rpc, 'commands/list', { agentId: sid('fx-alpha') })
    expect(commands.length).toBeGreaterThan(0)
    const executed = await callRemote<{ commandId: string } | undefined>(
      rpc, 'commands/execute', { agentId: sid('fx-alpha'), line: '/compact' })
    expect(executed?.commandId).toBeTruthy()
    const skills = await callRemote<{ skills: unknown[] }>(
      rpc, 'skills/list', { request: { sessionId: sid('fx-alpha') } },
    )
    expect(skills.skills.length).toBeGreaterThan(0)
  })
})
