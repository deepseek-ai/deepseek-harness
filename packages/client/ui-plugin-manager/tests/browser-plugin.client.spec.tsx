// @vitest-environment jsdom
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ILayout, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import * as settings from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject, NS, PANEL_ID } from '../src/client/index.ts'
import { PluginManagerPage } from '../src/client/PluginManagerPage.tsx'
import { PluginsPanelIcon } from '../src/client/PluginsPanelIcon.tsx'
import type { PluginManagerFace } from '../src/client/manager-store.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

async function bench() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
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
    settings: { describe: vi.fn(async () => ({ ok: true as const, value: { writable: true, hasDocument: true, namespaces: [] } })) },
    pluginInventory: { list },
    pluginRegistryProbe: { fastest: vi.fn(async () => ({ ok: true as const, value: null })) },
    pluginManager: {
      listBundles: vi.fn(() => Promise.resolve({ ok: true as const, value: [] })),
      listPlugins: vi.fn(() => Promise.resolve({ ok: true as const, value: [] })),
      registries: vi.fn(() => Promise.resolve({ ok: true as const, value: { registry: null, fallbackRegistries: [], resolved: null } })),
    },
  })
  const panelInfo = createSnapshotStore<PanelInfo>({ activePanelId: null })
  const selectPanel = vi.fn<ILayout['selectPanel']>((activePanelId) => { panelInfo.set({ activePanelId }) })
  ctx.provide('layout', { panelInfo, selectPanel, beginNavigation: () => new AbortController().signal,
    toggleSidebar: vi.fn(), openRightbar: vi.fn(), closeRightbar: vi.fn() })
  await ctx.plugin(settings).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, list, remote, selectPanel, panelInfo }
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
  it('resets bundle selection when leaving Plugins and releases its panel observer with the registration', async () => {
    const b = await bench()
    const removeRoot = declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('main')[0]!
    assert(entry.store && 'create' in entry.store)
    const navigation = entry.store.create()
    b.ctx.pluginNavigation.openBundle('dsh-navigation-test')
    expect(b.panelInfo.getSnapshot().activePanelId).toBe(PANEL_ID)
    expect(navigation.getSnapshot()).toEqual({ view: { kind: 'package', name: 'dsh-navigation-test' } })
    b.selectPanel(null)
    expect(navigation.getSnapshot()).toEqual({ view: { kind: 'list' } })
    b.selectPanel(PANEL_ID)
    expect(navigation.getSnapshot()).toEqual({ view: { kind: 'list' } })
    b.ctx.pluginNavigation.openBundle('dsh-navigation-test')
    removeRoot()
    b.selectPanel(null)
    expect(navigation.getSnapshot()).toEqual({ view: { kind: 'package', name: 'dsh-navigation-test' } })
  })

  it('declares only the services the page and its Remote methods use', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.pluginManager', 'remote.pluginInventory', 'remote.pluginRegistryProbe', 'configForms', 'layout'])
  })

  it('registers the sidebar entry and its page, which reads the Host only once rendered and follows Host changes', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    b.ctx.pluginNavigation.openBundle('dsh-navigation-test')
    expect(b.selectPanel).toHaveBeenCalledWith(PANEL_ID)
    const entry = b.slots.entries('main')[0]!
    assert(entry.store && 'create' in entry.store)
    expect(entry.store.create().getSnapshot()).toEqual({ view: { kind: 'package', name: 'dsh-navigation-test' } })
    expect(entry.component).toBe(PluginManagerPage)
    expect(entry.options).toMatchObject({ key: PANEL_ID })
    expect(entry.locale).toBe(NS)
    // The sidebar entry addresses the page by the same id and speaks the dictionary.
    const icon = b.slots.entries('sidebar.panellist')[0]!
    expect(icon.component).toBe(PluginsPanelIcon)
    const unread = () => { throw new Error('The sidebar icon must not read application state') }
    const glyph = render(<PluginsPanelIcon size={18} active={false}
      usePanelInfo={unread} useSessions={unread} useSessionStatus={unread} useSessionRetainInfo={unread}
      useWorkspaces={unread} useResource={unread} />)
    expect(glyph.container.querySelector('svg')?.getAttribute('width')).toBe('18')
    expect(icon.options).toMatchObject({ id: PANEL_ID, order: 0 })
    expect(icon.locale).toBe(NS)
    expect(resolveSlotLabel(icon.options.label)).toBe('插件')
    // The page declares the slots a plugin's configuration arrives through, and binds their projection beside its state.
    expect(b.slots.spec('plugins.item')).toMatchObject({ kind: 'list', scope: 'root' })
    expect(b.slots.spec('plugins.bundle.config')).toMatchObject({ kind: 'keyed', scope: 'root' })
    expect(b.slots.spec('plugins.row.config')).toMatchObject({ kind: 'keyed', scope: 'root' })
    for (const name of ['plugins.detail.actions', 'plugins.detail.badge', 'plugins.detail.section'] as const) {
      expect(b.slots.spec(name)).toMatchObject({ kind: 'list', scope: 'root' })
    }
    const face = (entry.inject as unknown as () => PluginManagerFace)()
    const text = { en: 'Local tools', zh: '本地工具' }
    expect(face.resolveText(text)).toBe('本地工具')
    b.locale.setLocale('en')
    expect(face.resolveText(text)).toBe('Local tools')
    b.locale.setLocale('zh')
    expect(face.hooks.configLedger.getSnapshot()).toEqual({ items: [], bundles: new Set(), rows: new Set() })
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
    expect(b.ctx.get('pluginNavigation')).toBeUndefined()
    expect(b.slots.entries('main')).toHaveLength(0)
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(0)
    b.remote.emit('plugin-manager/changed', [{ reason: 'install' }])
    await Promise.resolve()
    expect(b.list).toHaveBeenCalledTimes(3)
  })
})
