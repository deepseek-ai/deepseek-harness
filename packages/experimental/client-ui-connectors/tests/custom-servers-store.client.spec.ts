/**
 * The custom servers controller follows the server rows through the `connectors` Remote's stream and sends each change
 * to the Host as one call, reporting a refused change and opening the stream again after a conflicting one.
 */
import { Context } from '@deepseek-ai/cordis'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { expect, it, onTestFinished, vi } from 'vitest'
import { CustomServersController } from '../src/client/custom-servers-store.ts'
import { emptyDraft } from '../src/server-form.ts'
import type { CustomServersList, CustomServerView, ServerDraft } from '../src/types.ts'

type Answer<T = void> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

const ok = <T>(value: T): Answer<T> => ({ ok: true, value })
const refused = (message: string, code = 'connectors/refused'): Answer<never> => ({ ok: false, error: { code, message } })

const DOCS = { serverName: 'docs', transport: 'streamable-http', url: 'https://docs.example/mcp', headers: {} }
const DOCS_ROW: CustomServerView = { id: 'mcp-server-docs', name: 'docs', state: 'on', raw: DOCS, inherited: false }
const WIKI_ROW: CustomServerView = { id: 'mcp-server-wiki', name: 'wiki', state: 'off', raw: { ...DOCS, serverName: 'wiki' }, inherited: false }
const DRAFT: ServerDraft = { ...emptyDraft(), name: 'docs', url: 'https://docs.example/mcp' }

function listed(revision = 'r1', servers: readonly CustomServerView[] = [DOCS_ROW]): CustomServersList {
  return { available: true, revision, servers }
}

function warnings(ctx: Context): unknown[] {
  return ctx.logger.buffer.filter(message => message.type === 'warn').map((message): unknown => message.args)
}

/** Let every continuation that is already due run. */
function settled(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve) })
}

function bench(first: CustomServersList = listed()) {
  const ctx = new Context()
  /** The Host's rows as a new subscription reads them, and how many times they changed. */
  let list = first
  let version = 0
  let outcome: 'open' | 'ended' | Error = 'open'
  let wake = Promise.withResolvers<undefined>()
  const poke = (): void => {
    wake.resolve(undefined)
    wake = Promise.withResolvers<undefined>()
  }
  /** The signal of each subscription the controller opened, oldest first. */
  const opened: AbortSignal[] = []
  async function* watchServers(signal: AbortSignal): AsyncGenerator<CustomServersList> {
    opened.push(signal)
    signal.addEventListener('abort', poke, { once: true })
    let seen = -1
    while (!signal.aborted) {
      if (outcome instanceof Error) throw outcome
      if (outcome === 'ended') return
      if (seen === version) await wake.promise
      else {
        seen = version
        yield list
      }
    }
  }
  const saveServer = vi.fn(async (_draft: ServerDraft, _revision: string, _id?: string): Promise<Answer> => ok(undefined))
  const removeServer = vi.fn(async (_id: string, _revision: string): Promise<Answer> => ok(undefined))
  const setServerEnabled = vi.fn(async (_id: string, _enabled: boolean, _revision: string): Promise<Answer> => ok(undefined))
  const probe = vi.fn()
  new TestRemote(ctx, { connectors: { watchServers, saveServer, removeServer, setServerEnabled }, mcpManager: { probe } })
  const controller = new CustomServersController(ctx)
  onTestFinished(async () => {
    await controller.dispose()
    await ctx.fiber.dispose()
  })
  const face = controller.face()
  const state = () => face.hooks.customServers.getSnapshot()
  return {
    ctx, controller, face, state, opened, saveServer, removeServer, setServerEnabled, probe,
    /** Change the Host's rows and send the list to the open subscription. */
    publish(next: CustomServersList): void {
      list = next
      version++
      poke()
    },
    /** Change the Host's rows without a list reaching the open subscription. */
    miss(next: CustomServersList): void {
      list = next
      version++
    },
    /** Decide how every subscription goes from now on: it stays open, ends, or fails. */
    script(next: 'open' | 'ended' | Error): void {
      outcome = next
      poke()
    },
    async ready(): Promise<void> {
      face.ensure()
      await vi.waitFor(() => { expect(state().status).toBe('ready') })
    },
  }
}

it('follows the server rows once a section asks, and shows each list the Host sends', async () => {
  const b = bench()
  expect(b.state()).toMatchObject({ status: 'idle', revision: '', servers: [] })
  b.face.retry()
  expect(b.opened).toHaveLength(0)
  b.face.ensure()
  expect(b.state().status).toBe('loading')
  b.face.ensure()
  b.face.retry()
  await vi.waitFor(() => { expect(b.state().status).toBe('ready') })
  expect(b.state()).toMatchObject({ revision: 'r1', servers: [DOCS_ROW] })

  b.publish(listed('r2', [DOCS_ROW, WIKI_ROW]))
  await vi.waitFor(() => { expect(b.state().revision).toBe('r2') })
  expect(b.state().servers).toEqual([DOCS_ROW, WIKI_ROW])
  expect(b.opened).toHaveLength(1)
  expect(warnings(b.ctx)).toEqual([])
})

it('shows a profile that cannot hold custom servers as unavailable until the Host lists them', async () => {
  const b = bench({ available: false })
  b.face.ensure()
  await vi.waitFor(() => { expect(b.state().status).toBe('unavailable') })
  expect(b.state()).toMatchObject({ revision: '', servers: [] })

  b.publish(listed('r4'))
  await vi.waitFor(() => { expect(b.state()).toMatchObject({ status: 'ready', revision: 'r4', servers: [DOCS_ROW] }) })
  b.publish({ available: false })
  await vi.waitFor(() => { expect(b.state()).toMatchObject({ status: 'unavailable', revision: '', servers: [] }) })
})

it('reports a stream that fails or ends, and follows the rows again only on retry', async () => {
  const b = bench()
  b.script(new Error('offline'))
  b.face.ensure()
  await vi.waitFor(() => { expect(b.state().status).toBe('error') })
  expect(warnings(b.ctx)).toEqual([['custom MCP servers stream failed: %s', expect.objectContaining({ message: 'offline' }) as Error]])
  b.face.ensure()
  expect(b.opened).toHaveLength(1)

  b.script('open')
  b.face.retry()
  expect(b.state().status).toBe('loading')
  await vi.waitFor(() => { expect(b.state()).toMatchObject({ status: 'ready', revision: 'r1' }) })
  expect(b.opened).toHaveLength(2)

  b.script('ended')
  await vi.waitFor(() => { expect(b.state().status).toBe('error') })
  expect(b.state()).toMatchObject({ revision: 'r1', servers: [DOCS_ROW] })
  expect(warnings(b.ctx)).toHaveLength(2)
  expect(warnings(b.ctx)[1]).toEqual([
    'custom MCP servers stream failed: %s', expect.objectContaining({ message: 'Custom MCP servers stream ended' }) as Error,
  ])
})

it('saves a new or an existing server with the revision of the list it shows, and reports a refused save', async () => {
  const b = bench()
  await b.ready()
  const answer = Promise.withResolvers<Answer>()
  b.saveServer.mockReturnValueOnce(answer.promise)
  const saving = b.face.save(DRAFT)
  expect(b.state().saving).toBe(true)
  answer.resolve(ok(undefined))
  expect(await saving).toBe(true)
  expect(b.saveServer).toHaveBeenLastCalledWith(DRAFT, 'r1', undefined)
  expect(b.state()).toMatchObject({ saving: false, failure: undefined })

  b.publish(listed('r2'))
  await vi.waitFor(() => { expect(b.state().revision).toBe('r2') })
  expect(await b.face.save(DRAFT, 'mcp-server-docs')).toBe(true)
  expect(b.saveServer).toHaveBeenLastCalledWith(DRAFT, 'r2', 'mcp-server-docs')

  b.saveServer.mockResolvedValueOnce(refused('vault locked'))
  expect(await b.face.save(DRAFT)).toBe(false)
  expect(b.state()).toMatchObject({ saving: false, failure: { kind: 'refused', message: 'vault locked' } })
  b.face.dismissFailure()
  expect(b.state().failure).toBeUndefined()

  b.saveServer.mockResolvedValueOnce(refused('vault locked'))
  await b.face.save(DRAFT)
  const retried = b.face.save(DRAFT)
  expect(b.state()).toMatchObject({ saving: true, failure: undefined })
  await retried
  expect(b.opened).toHaveLength(1)
})

it('opens the stream again after a conflicting change, which shows the rows its list missed', async () => {
  const b = bench()
  await b.ready()
  b.miss(listed('r2', [DOCS_ROW, WIKI_ROW]))
  b.saveServer.mockResolvedValueOnce(refused('the server rows changed; read the servers again', 'connectors/conflict'))
  expect(await b.face.save(DRAFT)).toBe(false)
  expect(b.saveServer).toHaveBeenLastCalledWith(DRAFT, 'r1', undefined)
  expect(b.state().failure).toEqual({ kind: 'conflict', message: 'the server rows changed; read the servers again' })
  await vi.waitFor(() => { expect(b.state()).toMatchObject({ status: 'ready', revision: 'r2', servers: [DOCS_ROW, WIKI_ROW] }) })
  expect(b.opened).toHaveLength(2)
  expect(b.opened[0]!.aborted).toBe(true)
  expect(b.opened[1]!.aborted).toBe(false)
  expect(warnings(b.ctx)).toEqual([])
})

it('removes and switches servers with the revision of the list it shows, reporting a refusal', async () => {
  const b = bench()
  await b.ready()
  b.face.remove('mcp-server-docs')
  expect(b.removeServer).toHaveBeenLastCalledWith('mcp-server-docs', 'r1')
  b.face.setEnabled('mcp-server-docs', false)
  expect(b.setServerEnabled).toHaveBeenLastCalledWith('mcp-server-docs', false, 'r1')
  await settled()
  expect(b.state().failure).toBeUndefined()

  const reason = 'the profile patch does not add this server row; switch it off instead of removing it'
  b.removeServer.mockResolvedValueOnce(refused(reason))
  b.face.remove('mcp-server-docs')
  await vi.waitFor(() => { expect(b.state().failure).toEqual({ kind: 'refused', message: reason }) })
  b.setServerEnabled.mockResolvedValueOnce(refused('stale', 'connectors/conflict'))
  b.face.setEnabled('mcp-server-docs', true)
  await vi.waitFor(() => { expect(b.state().failure).toEqual({ kind: 'conflict', message: 'stale' }) })
  await vi.waitFor(() => { expect(b.opened).toHaveLength(2) })
})

it('reports each probe outcome, and a new probe of the same server replaces the running one', async () => {
  const b = bench()
  await b.ready()
  const first = Promise.withResolvers<Answer<unknown>>()
  const signals: AbortSignal[] = []
  b.probe.mockImplementationOnce((_name: string, signal: AbortSignal) => { signals.push(signal); return first.promise })
  b.face.probe('docs')
  expect(b.state().probes.docs).toEqual({ status: 'running' })
  b.probe.mockImplementationOnce(async (_name: string, signal: AbortSignal) => { signals.push(signal); return ok({ ok: true, toolNames: ['a', 'b'], truncated: false }) })
  b.face.probe('docs')
  await vi.waitFor(() => { expect(b.state().probes.docs).toEqual({ status: 'passed', tools: 2, truncated: false }) })
  expect(signals[0]!.aborted).toBe(true)
  first.resolve(ok({ ok: false, message: 'late' }))
  await settled()
  expect(b.state().probes.docs).toEqual({ status: 'passed', tools: 2, truncated: false })

  b.probe.mockResolvedValueOnce(ok({ ok: false, message: 'handshake refused' }))
  b.face.probe('docs')
  await vi.waitFor(() => { expect(b.state().probes.docs).toEqual({ status: 'failed', message: 'handshake refused' }) })
  b.probe.mockResolvedValueOnce(refused('manager offline'))
  b.face.probe('docs')
  await vi.waitFor(() => { expect(b.state().probes.docs).toEqual({ status: 'failed', message: 'manager offline' }) })
})

it('closes the stream, cancels running probes, and reports no later answer once disposed', async () => {
  const b = bench()
  await b.ready()
  const probing = Promise.withResolvers<Answer<unknown>>()
  let signal: AbortSignal | undefined
  b.probe.mockImplementationOnce((_name: string, received: AbortSignal) => { signal = received; return probing.promise })
  b.face.probe('docs')
  const writing = Promise.withResolvers<Answer>()
  b.saveServer.mockReturnValueOnce(writing.promise)
  const saved = b.face.save(DRAFT)
  const before = b.state()

  await b.controller.dispose()
  expect(signal!.aborted).toBe(true)
  expect(b.opened[0]!.aborted).toBe(true)
  probing.resolve(ok({ ok: true, toolNames: [], truncated: false }))
  writing.resolve(refused('stale', 'connectors/conflict'))
  b.publish(listed('r9', []))
  expect(await saved).toBe(false)
  await settled()
  expect(b.state()).toEqual({ ...before, saving: false })
  expect(b.opened).toHaveLength(1)
  expect(warnings(b.ctx)).toEqual([])
})

it('disposes a controller no section asked', async () => {
  const b = bench()
  await b.controller.dispose()
  expect(b.state().status).toBe('idle')
  expect(b.opened).toHaveLength(0)
})
