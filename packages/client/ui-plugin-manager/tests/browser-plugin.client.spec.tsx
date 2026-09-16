// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject, NS, PANEL_ID } from '../src/client/index.ts'
import { PluginManagerPage } from '../src/client/PluginManagerPage.tsx'
import { PluginsPanelIcon } from '../src/client/PluginsPanelIcon.tsx'
import type { PluginManagerFace } from '../src/client/manager-store.ts'
import { apply as hostApply } from '../src/index.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  class LocaleHolder extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'localeHolder')
    }
  }
  new LocaleHolder(ctx)
  const list = vi.fn(() => Promise.resolve({ ok: true as const, value: { entries: [], managementAvailable: true } }))
  const remote = new TestRemote(ctx, {
    pluginInventory: { list },
    pluginManager: {
      listBundles: vi.fn(() => Promise.resolve({ ok: true as const, value: [] })),
      listPlugins: vi.fn(() => Promise.resolve({ ok: true as const, value: [] })),
    },
  })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, list, remote }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'main': { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
}

describe('ui-plugin-manager browser plugin', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares only the services the page and its Remote methods use', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.pluginManager', 'remote.pluginInventory'])
  })

  it('registers the sidebar entry and its page, which reads the Host only once rendered and follows Host changes', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const entry = b.slots.entries('main')[0]!
    expect(entry.component).toBe(PluginManagerPage)
    expect(entry.options).toMatchObject({ key: PANEL_ID })
    expect(entry.locale).toBe(NS)
    // The sidebar entry addresses the page by the same id and speaks the dictionary.
    const icon = b.slots.entries('sidebar.panellist')[0]!
    expect(icon.component).toBe(PluginsPanelIcon)
    const unread = () => { throw new Error('The sidebar icon must not read application state') }
    const glyph = render(<PluginsPanelIcon size={18} active={false}
      usePanelInfo={unread} useSessions={unread} useSessionPendingInteraction={unread} useWorkspaces={unread} useResource={unread} />)
    expect(glyph.container.querySelector('svg')?.getAttribute('width')).toBe('18')
    expect(icon.options).toMatchObject({ id: PANEL_ID, order: 0 })
    expect(icon.locale).toBe(NS)
    expect(resolveSlotLabel(icon.options.label)).toBe('插件')
    const face = (entry.inject as unknown as () => PluginManagerFace)()
    // A Host change before the first render is not a reason to read.
    b.remote.emit('plugin-manager/changed', [{ reason: 'install' }])
    b.ctx.emit('connection/reset')
    await Promise.resolve()
    expect(b.list).not.toHaveBeenCalled()
    face.ensure()
    await vi.waitFor(() => { expect(face.hooks.pluginManager.getSnapshot().status).toBe('ready') })
    expect(b.list).toHaveBeenCalledTimes(1)
    b.remote.emit('plugin-manager/changed', [{ reason: 'bundle' }])
    await vi.waitFor(() => { expect(b.list).toHaveBeenCalledTimes(2) })
    b.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(b.list).toHaveBeenCalledTimes(3) })

    // Install output folds into an open run only.
    face.openInstall()
    face.editInstallSpec('pkg')
    b.remote.emit('plugin-manager/install-log', [{ jobId: 'j', argv: ['pnpm', 'add', 'pkg'], cwd: '/p', stream: 'stdout', text: 'early' }])
    b.remote.emit('plugin-manager/install-state', [{ requestId: 'foreign', phase: 'installing' }])
    expect(face.hooks.pluginManager.getSnapshot().install.runs).toEqual([])

    await fiber.dispose()
    expect(b.slots.entries('main')).toHaveLength(0)
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(0)
    b.remote.emit('plugin-manager/changed', [{ reason: 'install' }])
    await Promise.resolve()
    expect(b.list).toHaveBeenCalledTimes(3)
  })
})
