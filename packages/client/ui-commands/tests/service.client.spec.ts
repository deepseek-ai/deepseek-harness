/**
 * CommandUiRuntime tests on a real cordis Context with fake slash/connection
 * faces and real session scopes (createScope): session-keyed candidate
 * synthesis (host catalog by sessionId + contributions by availability,
 * collision fail-loud), the dispatch decision table cell by cell, matchSpace
 * hot-key policy, matchEnter strong-wait / reject, the sessionId execute
 * payload, the scoped consume-token dispatch, per-session popupFor
 * lifecycle, and the directory invalidation event subscriptions.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { CommandResult } from '@deepseek-ai/dsh-commands/types'
import { createScope, scopeOf } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { ClientSessionContext, ConsumeTokenRequest, InputTriggerPick, InputTriggerSource, SubmitAttachment } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { CommandContribution, CommandDecoration, CommandUiSpec, SelectOption } from '../src/client/contract.ts'
import type { CommandDescriptor } from '../src/client/directory.ts'
import { CommandUiRuntime } from '../src/client/service.ts'

const sid = (k: string): SessionId => k as SessionId

/** The agent-backed session projection (single state; identity only). */
const proj = (id: string): ClientSessionContext => ({ sessionId: sid(id) })

const S1_CMDS: CommandDescriptor[] = [
  { name: 'plan', description: 'bare kind' },
  { name: 'goal', description: 'leadingInput kind', input: { hint: 'goal text' } },
]

const S2_CMDS: CommandDescriptor[] = [
  ...S1_CMDS,
  { name: 'attach', description: 'scoped shadow', input: { hint: 'path' } },
]

type ExecuteValue = { matched: boolean; commandId?: string; result?: CommandResult }

interface BenchOptions {
  /** Scripted catalog per list payload; default serves the fixed catalogs by session. */
  commands?: (payload: { sessionId: SessionId }) => Promise<{ commands: CommandDescriptor[] }>
  execute?: (payload: { sessionId: SessionId; line: string }) => Promise<ExecuteValue>
  addressed?: SessionId
}

/**
 * Fold one programmed answer into the generated Remote face's outcome: a
 * resolved value is the ok branch, a rejection is the carrier failure the
 * Remote face reports in the error branch instead of throwing at the caller.
 * @param produce - the scripted answer for one Remote method.
 * @returns the carried result the service reads.
 */
async function carried<T>(produce: () => Promise<T>) {
  try {
    return { ok: true as const, value: await produce() }
  } catch (error) {
    return {
      ok: false as const,
      error: new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), {}),
    }
  }
}

async function bench(opts: BenchOptions = {}) {
  const ctx = new Context()
  const registered = new Map<string, InputTriggerSource>()
  const listCalls: Array<{ sessionId: SessionId }> = []
  const executeCalls: Array<{ sessionId: SessionId; line: string; images: readonly SubmitAttachment[] }> = []
  // The service reads the generated commands Remote, which delivers the
  // carrier's outcome, so a programmed failure answers the error branch.
  const commandsRemote = {
    list: async (sessionId: SessionId) => {
      listCalls.push({ sessionId })
      return await carried(async () => {
        const value = await (opts.commands ?? (p => Promise.resolve({
          commands: p.sessionId === sid('s2') ? S2_CMDS : S1_CMDS,
        })))({ sessionId })
        return value.commands
      })
    },
    execute: async (sessionId: SessionId, line: string, images: readonly SubmitAttachment[] = []) => {
      executeCalls.push({ sessionId, line, images })
      return await carried(async () => {
        const fallback = (): Promise<ExecuteValue> => Promise.resolve({ matched: true })
        const value = await (opts.execute ?? fallback)({ sessionId, line })
        return value.matched
          ? { commandId: value.commandId ?? 'fake-command', result: value.result ?? { kind: 'success' as const } }
          : undefined
      })
    },
  }
  ctx.provide('inputTriggers', {
    registerSource(src: InputTriggerSource) {
      const key = `${src.trigger} ${src.name}`
      registered.set(key, src)
      return () => { registered.delete(key) }
    },
  })
  // Deterministic key-echo translator: notice assertions read `key{json}`.
  ctx.provide('locale', {
    bind: (ns: string) => (key: string, params?: Record<string, unknown>) =>
      `${ns}:${key}${params === undefined ? '' : JSON.stringify(params)}`,
  })
  // Real scope tags behind a fake sessions face.
  const scopes = new Map<SessionId, { ctx: Context; fiber: { dispose(): Promise<void> } }>()
  ctx.provide('sessions', {
    scope: (id: SessionId) => scopes.get(id)?.ctx,
    scopeOf: (c: Context) => scopeOf(c),
    subagentAddress: (id: SessionId) => id === opts.addressed
      ? { parentSessionId: sid('parent'), childSessionId: id, mode: 'continuable' as const }
      : undefined,
  })
  const remote = Object.assign(new TestRemote(ctx), { commands: commandsRemote })
  ctx.provide('remote.commands', commandsRemote)
  const executions: Array<{ sessionId: SessionId; name: string; result: CommandResult }> = []
  ctx.on('command/executed', (sessionId, name, result) => {
    executions.push({ sessionId, name, result })
  })
  /** Notices the fake conversation face collected (runDetached routing). */
  const notices: Array<{ scope: SessionId | undefined; level: 'info' | 'error'; text: string }> = []
  ctx.provide('conversation', {
    input: {
      for: (actx: Context) => ({
        notify: (level: 'info' | 'error', text: string) => {
          notices.push({ scope: scopeOf(actx), level, text })
        },
      }),
    },
  })
  const fiber = ctx.plugin(CommandUiRuntime)
  await fiber.await()
  const command = ctx.get('commandUi') as CommandUiRuntime
  const source = registered.get('/ command')
  if (source === undefined) throw new Error('command source not registered')
  const mint = (key: string) => {
    const handle = createScope(ctx, sid(key))
    scopes.set(sid(key), handle)
    return handle
  }
  /** Warm one session's catalog through the source's own candidate pull. */
  const warm = async (session: ClientSessionContext) => {
    await source.candidates(session, { query: '', position: 'leading', drilled: false, signal: new AbortController().signal })
  }
  return { ctx, fiber, command, source, mint, warm, listCalls, executeCalls, executions, registered, notices, remote }
}

function menuPick(source: InputTriggerSource, name: string, session: ClientSessionContext, end?: number) {
  const pick: InputTriggerPick = {
    candidate: { name },
    session,
    position: 'leading',
    via: 'menu',
    action: 'pick',
    span: { start: 0, end: end ?? name.length + 1, draftRev: 3 },
  }
  return source.onPick(pick)
}

const themeUi = (over: Partial<CommandUiSpec> = {}): CommandUiSpec => ({
  kind: 'popupSelect',
  options: () => Promise.resolve([{ id: 'dark', label: 'Dark' }]),
  onSelect: () => undefined,
  ...over,
})

const themeContribution = (over: Partial<CommandContribution> = {}): CommandContribution => ({
  name: 'theme',
  description: 'client popup kind',
  available: () => true,
  ui: themeUi(),
  ...over,
})

const req = (query: string, position: 'leading' | 'inline' = 'leading') =>
  ({ query, position, drilled: false, signal: new AbortController().signal })

describe('registration', () => {
  it('registers the "/" source with matchSpace/matchEnter/warm hooks and removes it on fiber disposal', async () => {
    const { registered, source, fiber } = await bench()
    expect(typeof source.matchSpace).toBe('function')
    expect(typeof source.matchEnter).toBe('function')
    expect(typeof source.warm).toBe('function')
    expect([...registered.keys()]).toEqual(['/ command'])
    await fiber.dispose()
    expect(registered.size).toBe(0)
  })

  it('the warm hook prewarms the session key: one pull per session, no duplicate over pending', async () => {
    const { source, listCalls } = await bench()
    source.warm!(proj('s1'))
    expect(listCalls).toEqual([{ sessionId: sid('s1') }])
    source.warm!(proj('s2'))
    expect(listCalls).toEqual([{ sessionId: sid('s1') }, { sessionId: sid('s2') }])
    source.warm!(proj('s1')) // s1 already pending → no duplicate pull
    expect(listCalls).toHaveLength(2)
  })
})

describe('candidates', () => {
  it('does not fetch Agent-bound commands for an addressed child', async () => {
    const b = await bench({ addressed: sid('child') })
    await expect(b.warm(proj('child'))).resolves.toBeUndefined()
    expect(b.listCalls).toEqual([])
  })

  it('pulls the session catalog; fuzzy filter and hint mapping apply', async () => {
    const { source, listCalls } = await bench()
    const list = await source.candidates(proj('s1'), req('g'))
    expect(listCalls).toEqual([{ sessionId: sid('s1') }])
    expect(list).toEqual([{ name: 'goal', description: 'leadingInput kind', hint: 'goal text' }])
  })

  it('ranks rows through the shared name ranker: prefixes first, then alignment, then source order', async () => {
    const commands: CommandDescriptor[] = [
      { name: 'z_a_b', description: '' },
      { name: 'abc', description: '' },
    ]
    const { source } = await bench({ commands: () => Promise.resolve({ commands }) })
    const names = async (query: string) => (await source.candidates(proj('s1'), req(query))).map(c => c.name)
    await expect(names('AB')).resolves.toEqual(['abc', 'z_a_b'])
    await expect(names('zzz')).resolves.toEqual([])
  })

  it('catalogs are per session: another session pulls its own key', async () => {
    const { source, listCalls } = await bench()
    const names = (await source.candidates(proj('s2'), req(''))).map(c => c.name)
    expect(listCalls).toEqual([{ sessionId: sid('s2') }])
    expect(names).toEqual(['plan', 'goal', 'attach'])
  })

  it('hides leadingInput commands at inline position', async () => {
    const { source } = await bench()
    const names = (await source.candidates(proj('s1'), req('', 'inline'))).map(c => c.name)
    expect(names).toEqual(['plan'])
  })

  it('merges available contributions and filters unavailable ones with the per-call projection', async () => {
    const { command, source } = await bench()
    const available = vi.fn((session: ClientSessionContext) => session.sessionId === sid('s1'))
    command.register(themeContribution({ available }))
    const s1Names = (await source.candidates(proj('s1'), req(''))).map(c => c.name)
    expect(s1Names).toEqual(['plan', 'goal', 'theme'])
    expect(available).toHaveBeenLastCalledWith(proj('s1'))
    const s2Names = (await source.candidates(proj('s2'), req(''))).map(c => c.name)
    expect(s2Names).not.toContain('theme')
  })

  it('contribution rows ride the same fuzzy query filter', async () => {
    const { command, source } = await bench()
    command.register(themeContribution())
    const names = (await source.candidates(proj('s1'), req('tm'))).map(c => c.name)
    expect(names).toEqual(['theme'])
  })

  it('a contribution/host name collision fails loud', async () => {
    const { command, source } = await bench()
    command.register(themeContribution({ name: 'plan' }))
    await expect(source.candidates(proj('s1'), req(''))).rejects.toThrow('collides with a host command')
  })

})

describe('decorations (bare-invocation UI on host commands)', () => {
  const goalDecoration = (over: Partial<CommandDecoration> = {}): CommandDecoration => ({
    name: 'goal',
    available: () => true,
    ui: themeUi(),
    ...over,
  })

  it('adds no catalog row: the host row stands alone', async () => {
    const { command, source } = await bench()
    command.decorate(goalDecoration())
    const names = (await source.candidates(proj('s1'), req(''))).map(c => c.name)
    expect(names).toEqual(['plan', 'goal'])
  })

  it('bare enter opens the popup; an argued line never consults the decoration (host claim)', async () => {
    const { command, source, mint, warm } = await bench()
    command.decorate(goalDecoration())
    const scope = mint('s1')
    await warm(proj('s1'))
    expect(await source.matchEnter!(proj('s1'), '/goal', new AbortController().signal, { attachments: 0 })).toBe('handled')
    expect(command.popupFor(scope.ctx).state.getSnapshot()).toMatchObject({ open: true, command: 'goal' })
    const argued = await source.matchEnter!(proj('s1'), '/goal ship it', new AbortController().signal, { attachments: 0 })
    if (argued === undefined || argued === 'handled' || !('claim' in argued)) throw new Error('expected the host claim')
    expect(argued.claim.token).toBe('/goal ')
  })

  it('space never consults the decoration (host claim)', async () => {
    const { command, source, warm } = await bench()
    command.decorate(goalDecoration())
    await warm(proj('s1'))
    const outcome = source.matchSpace!(proj('s1'), '/goal')
    if (outcome === undefined || outcome === 'handled' || !('claim' in outcome)) throw new Error('expected the host claim')
    expect(outcome.claim.token).toBe('/goal ')
  })

  it('a decoration with no host row never fires (bare enter misses; menu pick misses)', async () => {
    const { command, source, mint, warm } = await bench()
    command.decorate(goalDecoration({ name: 'phantom' }))
    const scope = mint('s1')
    await warm(proj('s1'))
    expect(await source.matchEnter!(proj('s1'), '/phantom', new AbortController().signal, { attachments: 0 })).toBeUndefined()
    expect(menuPick(source, 'phantom', proj('s1'))).toBeUndefined()
    expect(command.popupFor(scope.ctx).state.getSnapshot().open).toBe(false)
  })

  it('an unavailable decoration falls through to the host bare path (detached execute)', async () => {
    const { command, source, warm, executeCalls } = await bench()
    command.decorate(goalDecoration({ name: 'plan', available: () => false }))
    await warm(proj('s1'))
    expect(await source.matchEnter!(proj('s1'), '/plan', new AbortController().signal, { attachments: 0 })).toBe('handled')
    expect(executeCalls).toEqual([{ sessionId: sid('s1'), line: '/plan', images: [] }])
  })

  it('duplicate decoration names fail loud', async () => {
    const { command } = await bench()
    command.decorate(goalDecoration())
    expect(() => { command.decorate(goalDecoration()) }).toThrow('duplicate decoration for /goal')
  })
})

describe('dispatch (menu column)', () => {
  it('contribution → opens the session popup with the open-time projection, no execute', async () => {
    const { command, source, mint, warm, executeCalls } = await bench()
    const options = vi.fn((_s: ClientSessionContext) => Promise.resolve([{ id: 'dark', label: 'Dark' }]))
    command.register(themeContribution({ ui: themeUi({ options }) }))
    const scope = mint('s1')
    await warm(proj('s1'))
    expect(menuPick(source, 'theme', proj('s1'))).toBe('handled')
    const popup = command.popupFor(scope.ctx)
    expect(popup.state.getSnapshot()).toMatchObject({ open: true, command: 'theme' })
    expect(options).toHaveBeenCalledExactlyOnceWith(proj('s1'), expect.any(AbortSignal))
    expect(executeCalls).toEqual([])
  })

  it('an unavailable contribution falls through to the host catalog', async () => {
    const { command, source, mint, warm } = await bench()
    command.register(themeContribution({ available: () => false }))
    const scope = mint('s1')
    await warm(proj('s1'))
    expect(menuPick(source, 'theme', proj('s1'))).toBeUndefined() // no host 'theme' either
    expect(command.popupFor(scope.ctx).state.getSnapshot().open).toBe(false)
  })

  it('host leadingInput → {claim} with token "/name " and hint; claiming never executes', async () => {
    const { source, warm, executeCalls } = await bench()
    await warm(proj('s1'))
    const outcome = menuPick(source, 'goal', proj('s1'))
    if (outcome === undefined || outcome === 'handled' || !('claim' in outcome)) throw new Error('expected claim')
    expect(outcome.claim.token).toBe('/goal ')
    expect(outcome.claim.hint).toBe('goal text')
    expect(executeCalls).toEqual([])
  })

  it('host bare → consume-token span guard on the session scope + detached execute', async () => {
    const { source, mint, warm, executeCalls, executions } = await bench()
    const scope = mint('s1')
    const consumes: ConsumeTokenRequest[] = []
    scope.ctx.on('slash/input-consume-token', (r) => {
      consumes.push(r)
      return true
    })
    await warm(proj('s1'))
    expect(menuPick(source, 'plan', proj('s1'), 5)).toBe('handled')
    expect(consumes).toEqual([{ guard: { kind: 'span', span: { start: 0, end: 5, draftRev: 3 } } }])
    await vi.waitFor(() => {
      expect(executeCalls).toEqual([{ sessionId: sid('s1'), line: '/plan', images: [] }])
      expect(executions).toEqual([{
        sessionId: sid('s1'),
        name: 'plan',
        result: { kind: 'success' },
      }])
    })
  })

  it('a name the directory no longer serves → undefined (snapshot swapped between menu and pick)', async () => {
    const { source, warm } = await bench()
    await warm(proj('s1'))
    expect(menuPick(source, 'gone', proj('s1'))).toBeUndefined()
  })
})

describe('matchSpace (space column)', () => {
  it('answers undefined from a not-ready key (no waiting, no RPC)', async () => {
    const { source, listCalls } = await bench()
    expect(source.matchSpace!(proj('s1'), '/goal')).toBeUndefined()
    expect(listCalls).toEqual([])
  })

  it('hot leadingInput exact token → {claim}; the key axis is the session', async () => {
    const { source, warm } = await bench()
    await warm(proj('s2'))
    const outcome = source.matchSpace!(proj('s2'), '/attach')
    if (outcome === undefined || outcome === 'handled' || !('claim' in outcome)) throw new Error('expected claim')
    expect(outcome.claim.token).toBe('/attach ')
    // s1's key is still cold: the same token answers undefined there.
    expect(source.matchSpace!(proj('s1'), '/attach')).toBeUndefined()
  })

  it('bare kind and contribution names stay plain text', async () => {
    const { command, source, warm } = await bench()
    command.register(themeContribution())
    await warm(proj('s1'))
    expect(source.matchSpace!(proj('s1'), '/plan')).toBeUndefined()
    expect(source.matchSpace!(proj('s1'), '/theme')).toBeUndefined()
  })

  it('unknown token / non-slash token → undefined', async () => {
    const { source, warm } = await bench()
    await warm(proj('s1'))
    expect(source.matchSpace!(proj('s1'), '/nope')).toBeUndefined()
    expect(source.matchSpace!(proj('s1'), 'plan')).toBeUndefined()
  })
})

describe('matchEnter (enter column)', () => {
  const signal = () => new AbortController().signal

  it('strong-waits a cold key before adjudicating', async () => {
    let release!: (value: { commands: CommandDescriptor[] }) => void
    const { source } = await bench({
      commands: () => new Promise((resolve) => { release = resolve }),
    })
    const wait = source.matchEnter!(proj('s1'), '/goal args', signal(), { attachments: 0 })
    release({ commands: S1_CMDS })
    const outcome = await wait
    if (outcome === undefined || outcome === 'handled' || !('claim' in outcome)) throw new Error('expected claim')
    expect(outcome.claim.token).toBe('/goal ')
  })

  it('rejects when warmup fails (never a silent downgrade)', async () => {
    const { source } = await bench({
      commands: () => Promise.reject(new Error('warmup boom')),
    })
    await expect(source.matchEnter!(proj('s1'), '/goal', signal(), { attachments: 0 })).rejects.toThrow('warmup boom')
  })

  it('leadingInput claims args-tolerant (bare and with trailing text)', async () => {
    const { source, warm } = await bench()
    await warm(proj('s1'))
    for (const line of ['/goal', '/goal refactor the loop']) {
      const outcome = await source.matchEnter!(proj('s1'), line, signal(), { attachments: 0 })
      if (outcome === undefined || outcome === 'handled' || !('claim' in outcome)) throw new Error('expected claim')
      expect(outcome.claim.token).toBe('/goal ')
    }
  })

  it('bare host command executes detached with the bare-token consume guard', async () => {
    const { source, mint, warm, executeCalls } = await bench()
    const scope = mint('s1')
    const consumes: ConsumeTokenRequest[] = []
    scope.ctx.on('slash/input-consume-token', (r) => {
      consumes.push(r)
      return true
    })
    await warm(proj('s1'))
    await expect(source.matchEnter!(proj('s1'), '/plan', signal(), { attachments: 0 })).resolves.toBe('handled')
    expect(consumes).toEqual([{ guard: { kind: 'bare-token', token: '/plan' } }])
    await Promise.resolve()
    expect(executeCalls).toEqual([{ sessionId: sid('s1'), line: '/plan', images: [] }])
  })

  it('bare kind with trailing text → undefined and no RPC (default sink owns the line)', async () => {
    const { source, warm, executeCalls } = await bench()
    await warm(proj('s1'))
    await expect(source.matchEnter!(proj('s1'), '/plan now', signal(), { attachments: 0 })).resolves.toBeUndefined()
    expect(executeCalls).toEqual([])
  })

  it('contribution: bare token opens the popup without touching the directory; args → undefined', async () => {
    const { command, source, mint, listCalls } = await bench()
    command.register(themeContribution())
    const scope = mint('s1')
    await expect(source.matchEnter!(proj('s1'), '/theme', signal(), { attachments: 0 })).resolves.toBe('handled')
    expect(command.popupFor(scope.ctx).state.getSnapshot().open).toBe(true)
    expect(listCalls).toEqual([]) // contribution short-circuits ahead of ensureReady
    await expect(source.matchEnter!(proj('s1'), '/theme dark', signal(), { attachments: 0 })).resolves.toBeUndefined()
  })

  it('unknown name, bare "/", and non-slash lines → undefined', async () => {
    const { source, warm } = await bench()
    await warm(proj('s1'))
    await expect(source.matchEnter!(proj('s1'), '/nope', signal(), { attachments: 0 })).resolves.toBeUndefined()
    await expect(source.matchEnter!(proj('s1'), '/', signal(), { attachments: 0 })).resolves.toBeUndefined()
    await expect(source.matchEnter!(proj('s1'), 'plain text', signal(), { attachments: 0 })).resolves.toBeUndefined()
  })
})

describe('matchEnter envelope policy (images)', () => {
  const signal = () => new AbortController().signal
  const IMG_CMDS: CommandDescriptor[] = [
    ...S1_CMDS,
    { name: 'vision', description: 'image-accepting leadingInput', input: { hint: 'describe', attachments: true } },
  ]
  const png: SubmitAttachment = { type: 'image', mediaType: 'image/png', data: 'AA==' }

  it('a leadingInput command not declaring acceptance refuses; a declaring one claims with images minted', async () => {
    const { source, warm } = await bench({ commands: () => Promise.resolve({ commands: IMG_CMDS }) })
    await warm(proj('s1'))
    await expect(source.matchEnter!(proj('s1'), '/goal ship', signal(), { attachments: 1 }))
      .rejects.toThrow('command:notice.attachmentsUnsupported{"command":"goal"}')
    const outcome = await source.matchEnter!(proj('s1'), '/vision what is this', signal(), { attachments: 1 })
    if (outcome === undefined || outcome === 'handled' || !('claim' in outcome)) throw new Error('expected claim')
    expect(outcome.claim.token).toBe('/vision ')
    expect(outcome.claim.attachments).toBe(true)
  })

  it('bare popup routes refuse images: contribution and decorated host both stay closed', async () => {
    const { command, source, mint, warm } = await bench()
    command.register(themeContribution())
    command.decorate({ name: 'plan', available: () => true, ui: themeUi() })
    const scope = mint('s1')
    await warm(proj('s1'))
    await expect(source.matchEnter!(proj('s1'), '/theme', signal(), { attachments: 1 }))
      .rejects.toThrow('command:notice.attachmentsUnsupported{"command":"theme"}')
    await expect(source.matchEnter!(proj('s1'), '/plan', signal(), { attachments: 2 }))
      .rejects.toThrow('command:notice.attachmentsUnsupported{"command":"plan"}')
    expect(command.popupFor(scope.ctx).state.getSnapshot().open).toBe(false)
  })

  it('bare host detached execute refuses images before any RPC', async () => {
    const { source, warm, executeCalls } = await bench()
    await warm(proj('s1'))
    await expect(source.matchEnter!(proj('s1'), '/plan', signal(), { attachments: 1 }))
      .rejects.toThrow('command:notice.attachmentsUnsupported{"command":"plan"}')
    expect(executeCalls).toEqual([])
  })

  it('claim.submit forwards the images to execute; consumption follows the handler outcome', async () => {
    let result: CommandResult = { kind: 'error', text: 'handler refused' }
    const { source, warm, executeCalls } = await bench({
      commands: () => Promise.resolve({ commands: IMG_CMDS }),
      execute: () => Promise.resolve({ matched: true, result }),
    })
    await warm(proj('s1'))
    const outcome = await source.matchEnter!(proj('s1'), '/vision x', signal(), { attachments: 1 })
    if (outcome === undefined || outcome === 'handled' || !('claim' in outcome)) throw new Error('expected claim')
    // Handler error: the error outcome keeps draft and images in the composer.
    await expect(outcome.claim.submit('x', new Context(), [png]))
      .resolves.toEqual({ kind: 'error', text: 'handler refused' })
    expect(executeCalls).toEqual([{ sessionId: sid('s1'), line: '/vision x', images: [png] }])
    result = { kind: 'success', text: 'described' }
    await expect(outcome.claim.submit('x', new Context(), [png])).resolves.toEqual({ kind: 'success' })
  })

  it('an imageless submission keeps the always-success admission mapping over a handler error', async () => {
    const { source, warm } = await bench({
      execute: () => Promise.resolve({ matched: true, result: { kind: 'error', text: 'late failure' } }),
    })
    await warm(proj('s1'))
    const outcome = source.matchSpace!(proj('s1'), '/goal')
    if (outcome === undefined || outcome === 'handled' || !('claim' in outcome)) throw new Error('expected claim')
    await expect(outcome.claim.submit('x', new Context(), [])).resolves.toEqual({ kind: 'success' })
  })
})

describe('execute payload', () => {
  it('claim.submit addresses the session; admitted outcomes stay off the composer (flow card owns them)', async () => {
    const { source, warm, executeCalls, executions } = await bench({
      execute: () => Promise.resolve({ matched: true }),
    })
    await warm(proj('s1'))
    const outcome = source.matchSpace!(proj('s1'), '/goal')
    if (outcome === undefined || outcome === 'handled' || !('claim' in outcome)) throw new Error('expected claim')
    const settled = await outcome.claim.submit('ship it', new Context(), [])
    expect(executeCalls).toEqual([{ sessionId: sid('s1'), line: '/goal ship it', images: [] }])
    // Pure admission: no outcome text ever rides the submit result — the
    // durable command lifecycle events render the outcome in the flow.
    expect(settled).toEqual({ kind: 'success' })
    expect(executions).toEqual([{
      sessionId: sid('s1'),
      name: 'goal',
      result: { kind: 'success' },
    }])
  })

  it('contains local acknowledgment listeners without changing an admitted result', async () => {
    const b = await bench({ execute: () => Promise.resolve({ matched: true }) })
    await b.warm(proj('s1'))
    const outcome = b.source.matchSpace!(proj('s1'), '/goal')
    if (outcome === undefined || outcome === 'handled' || !('claim' in outcome)) throw new Error('expected claim')
    const syncFailure = new Error('sync observer failed')
    const asyncFailure = new Error('async observer failed')
    const after = vi.fn()
    const warn = vi.spyOn(b.ctx.logger, 'warn').mockImplementation(() => undefined)
    b.ctx.on('command/executed', () => { throw syncFailure })
    const rejectingListener = (() => Promise.reject(asyncFailure)) as unknown as () => void
    b.ctx.on('command/executed', rejectingListener)
    b.ctx.on('command/executed', after)

    await expect(outcome.claim.submit('ship it', new Context(), [])).resolves.toEqual({ kind: 'success' })
    expect(after).toHaveBeenCalledOnce()
    await Promise.resolve()
    await Promise.resolve()
    expect(warn).toHaveBeenCalledWith('client command: a command/executed listener for "%s" failed', 'goal')
    expect(warn).toHaveBeenCalledWith(syncFailure)
    expect(warn).toHaveBeenCalledWith(asyncFailure)
  })

  it('maps matched:false to an error outcome and a matched bare result to success', async () => {
    const claimOf = async (opts: BenchOptions) => {
      const b = await bench(opts)
      await b.warm(proj('s1'))
      const outcome = b.source.matchSpace!(proj('s1'), '/goal')
      if (outcome === undefined || outcome === 'handled' || !('claim' in outcome)) throw new Error('expected claim')
      return outcome.claim
    }
    const first = await claimOf({ execute: () => Promise.resolve({ matched: false }) })
    const bad = await first.submit('x', new Context(), [])
    expect(bad.kind).toBe('error')
    const second = await claimOf({ execute: () => Promise.resolve({ matched: true }) })
    await expect(second.submit('', new Context(), [])).resolves.toEqual({ kind: 'success' })
  })
})

describe('detached admission notices', () => {
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))

  it('admitted outcomes stay silent; admission miss and transport rejection notice as errors', async () => {
    let mode: 'admitted' | 'miss' | 'reject' = 'admitted'
    const { source, mint, warm, notices } = await bench({
      execute: () => {
        if (mode === 'reject') return Promise.reject(new Error('network down'))
        return Promise.resolve({ matched: mode === 'admitted' })
      },
    })
    mint('s1')
    await warm(proj('s1'))
    // Admitted: the durable lifecycle events own the outcome — no notice.
    menuPick(source, 'plan', proj('s1'))
    await flush()
    expect(notices).toEqual([])

    // Admission miss (matched:false): immediate composer feedback stays.
    mode = 'miss'
    await source.matchEnter!(proj('s1'), '/plan', new AbortController().signal, { attachments: 0 })
    await flush()
    expect(notices).toEqual([{ scope: sid('s1'), level: 'error', text: 'unknown or malformed command: /plan' }])

    notices.length = 0
    mode = 'reject'
    menuPick(source, 'plan', proj('s1'))
    await flush()
    // A dead Remote call and a rejected one now read alike: both arrive as a
    // failed result, so the notice names the endpoint either way.
    expect(notices).toEqual([{
      scope: sid('s1'),
      level: 'error',
      text: 'command.execute failed: gateway/internal: network down',
    }])
  })

  it('a torn-down scope drops the failure notice', async () => {
    const { source, warm, notices } = await bench({
      execute: () => Promise.reject(new Error('orphan failure')),
    })
    await warm(proj('ghost')) // never minted: scopeFor misses
    menuPick(source, 'plan', proj('ghost'))
    await flush()
    expect(notices).toEqual([])
  })
})

describe('register (contribution face)', () => {
  it('duplicate registration throws; the disposer frees the name', async () => {
    const { command } = await bench()
    const dispose = command.register(themeContribution())
    expect(() => command.register(themeContribution())).toThrow('duplicate contribution')
    dispose()
    command.register(themeContribution())()
  })
})

describe('popupFor', () => {
  it('resolves lazily per session; a foreign session gets its own controller; unscoped ctx throws', async () => {
    const { ctx, command, mint } = await bench()
    const a = mint('s1')
    const first = command.popupFor(a.ctx)
    expect(command.popupFor(a.ctx)).toBe(first)
    expect(command.popupFor(mint('s2').ctx)).not.toBe(first)
    expect(() => command.popupFor(ctx)).toThrow('requires a session scope')
  })

  it('a successful select dispatches the scoped consume-token and fires the bound composer focus', async () => {
    const { command, source, mint } = await bench()
    const onSelect = vi.fn()
    command.register(themeContribution({ ui: themeUi({ onSelect }) }))
    const scope = mint('s1')
    const consumes: ConsumeTokenRequest[] = []
    scope.ctx.on('slash/input-consume-token', (r) => {
      consumes.push(r)
      return true
    })
    const focus = vi.fn()
    command.bindComposerFocus(sid('s1'), focus)

    expect(menuPick(source, 'theme', proj('s1'), 6)).toBe('handled')
    const popup = command.popupFor(scope.ctx)
    await Promise.resolve() // options land
    await popup.select(0)
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ id: 'dark', label: 'Dark' } satisfies SelectOption, proj('s1'))
    expect(consumes).toEqual([{ guard: { kind: 'span', span: { start: 0, end: 6, draftRev: 3 } } }])
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('the enter path opens with the bare-token guard', async () => {
    const { command, source, mint } = await bench()
    command.register(themeContribution())
    const scope = mint('s1')
    const consumes: ConsumeTokenRequest[] = []
    scope.ctx.on('slash/input-consume-token', (r) => {
      consumes.push(r)
      return true
    })
    await source.matchEnter!(proj('s1'), '/theme', new AbortController().signal, { attachments: 0 })
    const popup = command.popupFor(scope.ctx)
    await Promise.resolve()
    await popup.select(0)
    expect(consumes).toEqual([{ guard: { kind: 'bare-token', token: '/theme' } }])
  })

  it('the scope disposer disposes the controller and a re-mint resolves fresh', async () => {
    const { command, source, mint } = await bench()
    command.register(themeContribution())
    const scope = mint('s1')
    await source.matchEnter!(proj('s1'), '/theme', new AbortController().signal, { attachments: 0 })
    const popup = command.popupFor(scope.ctx)
    expect(popup.state.getSnapshot().open).toBe(true)

    await scope.fiber.dispose()
    expect(popup.state.getSnapshot().open).toBe(false)
    expect(command.popupFor(mint('s1').ctx)).not.toBe(popup)
  })
})

describe('directory invalidation events', () => {
  it('commands/change repulls in the background while the old snapshot serves', async () => {
    let round = 0
    const { source, warm, remote } = await bench({
      commands: () => {
        round += 1
        return Promise.resolve({
          commands: round === 1
            ? S1_CMDS
            : [{ name: 'fresh', description: '', input: { hint: 'h' } }],
        })
      },
    })
    await warm(proj('s1'))
    remote.emit('commands/change', [])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(source.matchSpace!(proj('s1'), '/fresh')).not.toBeUndefined()
    expect(source.matchSpace!(proj('s1'), '/goal')).toBeUndefined()
  })

  it('agent-preset/selected drops and repulls the recomposed session while leaving others served', async () => {
    const rounds = new Map<SessionId, number>()
    const { source, warm, remote } = await bench({
      commands: (payload) => {
        const round = (rounds.get(payload.sessionId) ?? 0) + 1
        rounds.set(payload.sessionId, round)
        return Promise.resolve({
          commands: round === 1
            ? S1_CMDS
            : [{ name: 'fresh', description: '', input: { hint: 'h' } }],
        })
      },
    })
    await warm(proj('s1'))
    await warm(proj('s2'))
    // A preset switch changes which commands one session's agent resolves;
    // every other session keeps the catalog its own composition serves.
    remote.emit('agent-preset/selected', [sid('s1'), 'minimal'])
    expect(source.matchSpace!(proj('s1'), '/goal')).toBeUndefined()
    expect(source.matchSpace!(proj('s2'), '/goal')).not.toBeUndefined()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(source.matchSpace!(proj('s1'), '/fresh')).not.toBeUndefined()
    expect(source.matchSpace!(proj('s1'), '/goal')).toBeUndefined()
    expect(source.matchSpace!(proj('s2'), '/goal')).not.toBeUndefined()
  })

  it('connection/reset hard-drops every session key until its rewarm lands', async () => {
    let block = false
    let release!: (value: { commands: CommandDescriptor[] }) => void
    const { ctx, source, warm } = await bench({
      commands: () => (block
        ? new Promise((resolve) => { release = resolve })
        : Promise.resolve({ commands: S2_CMDS })),
    })
    await warm(proj('s2'))
    expect(source.matchSpace!(proj('s2'), '/attach')).not.toBeUndefined()
    block = true
    ctx.emit('connection/reset')
    // Hard reset: silent until the rewarm lands.
    expect(source.matchSpace!(proj('s2'), '/attach')).toBeUndefined()
    release({ commands: S2_CMDS })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(source.matchSpace!(proj('s2'), '/attach')).not.toBeUndefined()
  })
})
