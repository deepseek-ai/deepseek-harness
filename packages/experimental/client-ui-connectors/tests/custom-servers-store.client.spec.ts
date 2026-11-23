/**
 * The custom servers controller reads the servers through the `connectors` Remote and sends each change to the Host as
 * one call, reading again after it and reporting a refused or conflicting change.
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

const DOCS = { transport: 'streamable-http', url: 'https://docs.example/mcp', headers: {} }
const SERVERS: CustomServerView[] = [{ name: 'docs', raw: DOCS, inherited: false }]
const DRAFT: ServerDraft = { ...emptyDraft(), name: 'docs', url: 'https://docs.example/mcp' }

function listed(revision = 3, servers: readonly CustomServerView[] = SERVERS, writable = true): Answer<CustomServersList> {
  return ok({ available: true, writable, revision, servers })
}

function bench() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const listServers = vi.fn(async (): Promise<Answer<CustomServersList>> => listed())
  const saveServer = vi.fn(async (_draft: ServerDraft, _revision: number): Promise<Answer> => ok(undefined))
  const removeServer = vi.fn(async (_name: string, _revision: number): Promise<Answer> => ok(undefined))
  const setServerEnabled = vi.fn(async (_name: string, _enabled: boolean, _revision: number): Promise<Answer> => ok(undefined))
  const probe = vi.fn()
  new TestRemote(ctx, { connectors: { listServers, saveServer, removeServer, setServerEnabled }, mcpManager: { probe } })
  const controller = new CustomServersController(ctx)
  const face = controller.face()
  const state = () => face.hooks.customServers.getSnapshot()
  return {
    controller, face, state, listServers, saveServer, removeServer, setServerEnabled, probe,
    async ready() {
      face.ensure()
      await vi.waitFor(() => { expect(state().status).toBe('ready') })
      for (const fn of [listServers, saveServer, removeServer, setServerEnabled, probe]) fn.mockClear()
    },
  }
}

it('reads the servers once a section asks, and shows what the Host lists', async () => {
  const b = bench()
  b.controller.changed()
  expect(b.listServers).not.toHaveBeenCalled()
  b.face.ensure()
  expect(b.state().status).toBe('loading')
  b.face.ensure()
  await vi.waitFor(() => { expect(b.state().status).toBe('ready') })
  expect(b.listServers).toHaveBeenCalledOnce()
  expect(b.state()).toMatchObject({ writable: true, revision: 3, servers: SERVERS })
})

it('reports a failed read with a retry, and a profile without custom servers as unavailable', async () => {
  const b = bench()
  b.listServers.mockResolvedValueOnce(refused('offline'))
  b.face.ensure()
  await vi.waitFor(() => { expect(b.state().status).toBe('error') })
  b.listServers.mockResolvedValueOnce(ok({ available: false }))
  b.face.retry()
  await vi.waitFor(() => { expect(b.state()).toMatchObject({ status: 'unavailable', servers: [] }) })
})

it('publishes only the latest of overlapping reads and reads again after a Settings change', async () => {
  const b = bench()
  await b.ready()
  const first = Promise.withResolvers<Answer<CustomServersList>>()
  b.listServers.mockReturnValueOnce(first.promise)
  b.listServers.mockResolvedValueOnce(listed(5, [...SERVERS, { name: 'wiki', raw: DOCS, inherited: false }]))
  b.controller.changed()
  b.controller.changed()
  expect(b.state().status).toBe('ready')
  await vi.waitFor(() => { expect(b.state().revision).toBe(5) })
  first.resolve(listed(4, []))
  await Promise.resolve()
  expect(b.state()).toMatchObject({ revision: 5, servers: [{ name: 'docs' }, { name: 'wiki' }] })
})

it('saves with the revision it read, reads again after the save, and reports a refused or conflicting one', async () => {
  const b = bench()
  await b.ready()
  const saving = b.face.save(DRAFT)
  expect(b.state().saving).toBe(true)
  expect(await saving).toBe(true)
  expect(b.saveServer).toHaveBeenCalledWith(DRAFT, 3)
  expect(b.state()).toMatchObject({ saving: false, failure: undefined })
  await vi.waitFor(() => { expect(b.listServers).toHaveBeenCalledOnce() })

  b.saveServer.mockResolvedValueOnce(refused('vault locked'))
  expect(await b.face.save(DRAFT)).toBe(false)
  expect(b.state().failure).toEqual({ kind: 'refused', message: 'vault locked' })
  expect(b.listServers).toHaveBeenCalledOnce()
  b.face.dismissFailure()
  expect(b.state().failure).toBeUndefined()

  b.saveServer.mockResolvedValueOnce(refused('stale', 'connectors/conflict'))
  expect(await b.face.save(DRAFT)).toBe(false)
  expect(b.state().failure).toEqual({ kind: 'conflict', message: 'stale' })
  await vi.waitFor(() => { expect(b.listServers).toHaveBeenCalledTimes(2) })
})

it('removes and switches servers with the revision it read, reporting a refusal', async () => {
  const b = bench()
  await b.ready()
  b.face.remove('docs')
  await vi.waitFor(() => { expect(b.removeServer).toHaveBeenCalledWith('docs', 3) })
  b.face.setEnabled('docs', false)
  await vi.waitFor(() => { expect(b.setServerEnabled).toHaveBeenCalledWith('docs', false, 3) })
  b.removeServer.mockResolvedValueOnce(refused('connection busy'))
  b.face.remove('docs')
  await vi.waitFor(() => { expect(b.state().failure).toEqual({ kind: 'refused', message: 'connection busy' }) })
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
  await Promise.resolve()
  expect(b.state().probes.docs).toEqual({ status: 'passed', tools: 2, truncated: false })

  b.probe.mockResolvedValueOnce(ok({ ok: false, message: 'handshake refused' }))
  b.face.probe('docs')
  await vi.waitFor(() => { expect(b.state().probes.docs).toEqual({ status: 'failed', message: 'handshake refused' }) })
  b.probe.mockResolvedValueOnce(refused('manager offline'))
  b.face.probe('docs')
  await vi.waitFor(() => { expect(b.state().probes.docs).toEqual({ status: 'failed', message: 'manager offline' }) })
})

it('cancels running probes and publishes no later answer once disposed', async () => {
  const b = bench()
  await b.ready()
  const probing = Promise.withResolvers<Answer<unknown>>()
  let signal: AbortSignal | undefined
  b.probe.mockImplementationOnce((_name: string, received: AbortSignal) => { signal = received; return probing.promise })
  b.face.probe('docs')
  const reading = Promise.withResolvers<Answer<CustomServersList>>()
  b.listServers.mockReturnValueOnce(reading.promise)
  b.face.retry()
  const writing = Promise.withResolvers<Answer>()
  b.saveServer.mockReturnValueOnce(writing.promise)
  const saved = b.face.save(DRAFT)
  const before = b.state()
  b.controller.dispose()
  expect(signal!.aborted).toBe(true)
  probing.resolve(ok({ ok: true, toolNames: [], truncated: false }))
  reading.resolve(listed(9))
  writing.resolve(ok(undefined))
  expect(await saved).toBe(false)
  expect(b.state()).toEqual({ ...before, saving: false })
})
