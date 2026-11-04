import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { MenuRegistry } from '@deepseek-ai/dsh-client-ui-context-menu/src/client/registry.ts'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { OpenInAppController } from '../src/client/controller.ts'
import { registerSessionReveal } from '../src/client/session-reveal.tsx'
import { en, zh, NS } from '../src/client/locales.ts'

it.each([
  [['finder'], '/workspace', 'Show in Finder', false],
  [['explorer'], '/workspace', 'Show in folder', false],
  [['filemanager'], '/workspace', 'Show in folder', false],
  [['vscode'], '/workspace', 'Show in folder', true],
  [null, '/workspace', 'Show in folder', true],
  [['finder'], undefined, 'Show in Finder', true],
] as const)('reveals the captured directory with catalog %j and path %s', async (apps, cwd, label, disabled) => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  locale.register(NS, { en, zh }); locale.setLocale('en')
  const registry = new MenuRegistry(vi.fn())
  onTestFinished(() => { registry.dispose() })
  ctx.provide('contextMenus', { register: registry.register.bind(registry) } as never)
  const sessionId = SessionId('captured')
  const list = createSnapshotStore<SessionListState>({ ids: [sessionId], byId: {
    [sessionId]: { id: sessionId, ...(cwd === undefined ? {} : { cwd }), displayTitle: 'Captured', running: false, blank: false, updatedAt: 1, retainedBy: {} },
  }, phase: 'ready', projectionsBySession: {} })
  ctx.provide('sessions', { list } as never)
  const controller = new OpenInAppController()
  controller.apps.set(apps)
  const launch = vi.spyOn(controller, 'launch').mockResolvedValue({ kind: 'opened' })
  const report = vi.fn()
  registerSessionReveal(ctx, controller, locale.bind(NS), report)
  const menu = registry.resolve({ kind: 'session', value: { sessionId, displayTitle: 'Captured' } })
  expect(menu.source.getSnapshot()[0]).toMatchObject({ label, disabled })
  menu.select('open-in-app.reveal/reveal')
  if (disabled) {
    expect(launch).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
  } else {
    expect(launch).toHaveBeenCalledWith(apps?.[0], cwd)
    await vi.waitFor(() => { expect(report).toHaveBeenCalledWith({ kind: 'opened' }) })
  }
})
