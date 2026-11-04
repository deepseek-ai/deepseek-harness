// @vitest-environment jsdom
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { MenuRegistry } from '@deepseek-ai/dsh-client-ui-context-menu/src/client/registry.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ContextMenuTarget } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

// The test frame changes a real Session binding without depending on a feature Header.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'test.sessionLogExport.session': { kind: 'single'; scope: 'session' }
  }
}

function SessionView({ sessionId }: PropsRuntime<'test.sessionLogExport.session'>) {
  return <article>{sessionId}</article>
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('keeps the export overlay across real Session rebinding and removes it when its plugin unloads', async () => {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const { ctx } = runtime
  ctx.provide('locale', new LocaleRuntime(ctx))
  runtime.slots.installLocale(ctx.locale)
  ctx.locale.setLocale('en')
  const registry = new MenuRegistry(vi.fn())
  onTestFinished(() => { registry.dispose() })
  ctx.provide('contextMenus', {
    active: createSnapshotStore<ContextMenuTarget | null>(null),
    open: vi.fn(), close: vi.fn(), register: registry.register.bind(registry),
  } as never)
  await runtime.declare({
    'shell.overlay': { kind: 'list', scope: 'root' },
    'test.sessionLogExport.session': { kind: 'single', scope: 'session' },
  })
  await runtime.mount({
    inject: ['slots'],
    apply(scope) { scope.slots.register({ name: 'test.sessionLogExport.session' }, SessionView) },
  })
  const plugin = await runtime.mount({ apply, inject: [...inject] })
  const firstId = await runtime.sessions.add({ id: 'first-export-session' })
  const secondId = await runtime.sessions.add({ id: 'second-export-session' })
  const first = runtime.sessions.retainFor(ctx, firstId)
  const second = runtime.sessions.retainFor(ctx, secondId)
  await Promise.all([first.ready, second.ready])
  const session = runtime.renderSlot('test.sessionLogExport.session', {}, { session: first })
  runtime.renderSlot('shell.overlay', {})
  const gates = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()]
  const signals: AbortSignal[] = []
  vi.stubGlobal('fetch', vi.fn((_input: string | URL, init?: RequestInit) => {
    const gate = gates[signals.length]
    if (gate === undefined || init?.signal == null) throw new Error('Unexpected preflight')
    const signal = init.signal
    signals.push(signal)
    const abort = () => { gate.reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    return gate.promise.finally(() => { signal.removeEventListener('abort', abort) })
  }))
  const save = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const menu = registry.resolve({ kind: 'sessionHeader', value: { sessionId: firstId } })
  act(() => { menu.select('session-log-download.export/download') })
  const modal = screen.getByRole('dialog', { name: 'Exporting Session' })
  expect(modal.textContent).toContain(firstId)
  session.update({}, { session: second })
  expect(screen.getByRole('article').textContent).toBe(secondId)
  expect(screen.getByRole('dialog')).toBe(modal)
  expect(modal.textContent).not.toContain(secondId)
  act(() => { ctx.emit('command/executed', secondId, 'export', { kind: 'success' }) })
  expect(signals).toHaveLength(2)
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!)
  expect(signals[0]?.aborted).toBe(false)
  expect(screen.getByRole('dialog').textContent).toContain(secondId)
  const pendingFirst = ctx.sessionLogDownload.download(firstId)
  await act(async () => { gates[0]!.resolve(new Response('zip')); await pendingFirst })
  expect(save).toHaveBeenCalledOnce()
  expect(screen.getByRole('dialog').textContent).toContain(secondId)
  await plugin.dispose()
  expect(signals[1]?.aborted).toBe(true)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(menu.source.getSnapshot()).toEqual([])
  expect(runtime.slots.entries('shell.overlay')).toEqual([])
  expect(save).toHaveBeenCalledOnce()
})
