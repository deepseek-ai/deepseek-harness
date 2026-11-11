import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { MenuRegistry } from '@deepseek-ai/dsh-client-ui-context-menu/src/client/registry.ts'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { OpenInAppController } from '../src/client/controller.ts'
import { registerSessionOpenWith } from '../src/client/session-open-with.ts'
import { en, zh, NS } from '../src/client/locales.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

function bench(apps: readonly string[] | null = ['finder', 'cursor'], cwd: string | undefined = '/captured') {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  locale.register(NS, { en, zh }); locale.setLocale('en')
  const failed = vi.fn(), report = vi.fn()
  const registry = new MenuRegistry(failed)
  onTestFinished(() => { registry.dispose() })
  ctx.provide('contextMenus', { register: registry.register.bind(registry) } as never)
  const sessionId = brandString<SessionId>('captured'), mainId = brandString<SessionId>('main')
  const row = { id: sessionId, ...(cwd === undefined ? {} : { cwd }), displayTitle: 'Captured', running: false, blank: false, updatedAt: 1, retainedBy: {} }
  const list = createSnapshotStore<SessionListState>({ ids: [sessionId, mainId], byId: {
    [sessionId]: row, [mainId]: { ...row, id: mainId, cwd: '/main', retainedBy: { mainView: 1 } },
  }, phase: 'ready', projectionsBySession: {} })
  ctx.provide('sessions', { list } as never)
  const gate = Promise.withResolvers<Response>()
  const fetcher = vi.fn(() => gate.promise)
  const controller = new OpenInAppController(fetcher)
  controller.choice.set(''); controller.apps.set(apps)
  const choose = vi.spyOn(controller, 'choose')
  const fiber = ctx.plugin((scope) => { registerSessionOpenWith(scope, controller, locale.bind(NS), report) })
  const resolve = (kind: 'session' | 'sessionHeader' = 'session') => registry.resolve(kind === 'session'
    ? { kind, value: { sessionId, displayTitle: 'Captured' } }
    : { kind, value: { sessionId } })
  return { ctx, registry, locale, controller, list, row, sessionId, fetcher, gate, choose, report, failed, fiber, resolve }
}

it.each([null, [], ['unlabelled']])('omits unavailable catalog %j from both menu targets', async (apps) => {
  const b = bench(apps)
  await b.fiber.await()
  for (const kind of ['session', 'sessionHeader'] as const) expect(b.resolve(kind).source.getSnapshot()).toEqual([])
})

it('omits unknown directories and follows metadata, locale and applications without labeling preferences', async () => {
  const b = bench()
  await b.fiber.await()
  b.list.set({ ...b.list.getSnapshot(), byId: {} })
  const menu = b.resolve(), header = b.resolve('sessionHeader')
  expect(menu.source.getSnapshot()).toEqual([])
  b.list.set({ ...b.list.getSnapshot(), byId: { [b.sessionId]: b.row } })
  expect(menu.source.getSnapshot()[0]).toMatchObject({ label: 'Open in', disabled: false })
  expect(menu.source.getSnapshot()[0]?.separatorBefore).toBeUndefined()
  expect(header.source.getSnapshot()[0]?.separatorBefore).toBe(true)
  expect(menu.source.getSnapshot()[0]?.children?.map(row => row.label)).toEqual(['Finder', 'Cursor'])
  b.controller.choose('cursor')
  expect(menu.source.getSnapshot()[0]?.children?.map(row => row.label)).toEqual(['Finder', 'Cursor'])
  b.locale.setLocale('zh')
  expect(menu.source.getSnapshot()[0]?.label).toBe('在应用中打开')
  expect(header.source.getSnapshot()[0]?.children?.[1]?.label).toBe('Cursor')
  b.controller.apps.set(['cursor', 'unknown', 'finder'])
  expect(menu.source.getSnapshot()[0]?.children?.map(row => row.label)).toEqual(['Cursor', '访达'])
  b.controller.apps.set(['finder'])
  expect(menu.source.getSnapshot()[0]?.children).toHaveLength(1)
  expect(menu.source.getSnapshot()[0]?.children?.[0]).toMatchObject({
    label: '访达', icon: { key: 'open-in-app.application', src: 'open-in-app/icon/finder' },
  })
  b.controller.apps.set([])
  expect(menu.source.getSnapshot()).toEqual([])
  expect(header.source.getSnapshot()).toEqual([])
})

it.each(['session', 'sessionHeader'] as const)('launches the captured %s directory, disables all openers, and remembers only after success', async (kind) => {
  const b = bench()
  await b.fiber.await()
  const menu = b.resolve(kind), observing = b.resolve(kind === 'session' ? 'sessionHeader' : 'session')
  const action = menu.source.getSnapshot()[0]!.children![1]!
  menu.select(action.id)
  expect(b.fetcher).toHaveBeenCalledExactlyOnceWith('open-in-app/open', expect.objectContaining({ body: JSON.stringify({ app: 'cursor', path: '/captured' }) }))
  expect(b.choose).not.toHaveBeenCalled()
  expect(observing.source.getSnapshot()[0]).toMatchObject({ disabled: true })
  expect(observing.source.getSnapshot()[0]?.children?.every(row => row.disabled)).toBe(true)
  observing.select(observing.source.getSnapshot()[0]!.children![0]!.id)
  expect(b.fetcher).toHaveBeenCalledOnce()
  b.list.set({ ...b.list.getSnapshot(), byId: { [b.sessionId]: { ...b.row, cwd: '/changed' } } })
  menu.dispose()
  b.gate.resolve(new Response())
  await vi.waitFor(() => { expect(b.report).toHaveBeenCalledExactlyOnceWith({ kind: 'opened' }) })
  expect(b.choose).toHaveBeenCalledExactlyOnceWith('cursor')
  expect(b.controller.choice.getSnapshot()).toBe('cursor')
  expect(observing.source.getSnapshot()[0]?.disabled).toBe(false)
  expect(b.failed).not.toHaveBeenCalled()
})

it.each([{ kind: 'failed', failure: 'openError' }, { kind: 'skipped' }] as const)('does not remember a %j launch or duplicate its feedback', async (outcome) => {
  const b = bench()
  await b.fiber.await()
  vi.spyOn(b.controller, 'launch').mockResolvedValue(outcome)
  const menu = b.resolve()
  menu.select(menu.source.getSnapshot()[0]!.children![1]!.id)
  await vi.waitFor(() => { expect(b.report).toHaveBeenCalledExactlyOnceWith(outcome) })
  expect(b.choose).not.toHaveBeenCalled()
  expect(b.controller.choice.getSnapshot()).toBe('')
  expect(b.failed).not.toHaveBeenCalled()
})

it('withdraws both registrations and their observers on unload and reinstalls without duplicates', async () => {
  const b = bench()
  await b.fiber.await()
  const menu = b.resolve(), header = b.resolve('sessionHeader')
  const id = menu.source.getSnapshot()[0]!.children![0]!.id
  await b.fiber.dispose()
  expect(menu.source.getSnapshot()).toEqual([])
  expect(header.source.getSnapshot()).toEqual([])
  menu.select(id)
  expect(b.fetcher).not.toHaveBeenCalled()
  b.controller.apps.set(['cursor'])
  expect(b.resolve().source.getSnapshot()).toEqual([])
  const replacement = b.ctx.plugin((scope) => { registerSessionOpenWith(scope, b.controller, b.locale.bind(NS), b.report) })
  await replacement.await()
  expect(b.resolve().source.getSnapshot()).toHaveLength(1)
  expect(b.resolve('sessionHeader').source.getSnapshot()).toHaveLength(1)
})
