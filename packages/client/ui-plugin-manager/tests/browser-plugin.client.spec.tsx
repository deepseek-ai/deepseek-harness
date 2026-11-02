// @vitest-environment jsdom
import { contextMenuHook } from '@deepseek-ai/dsh-client-test-runtime'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ILayout, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { allowAllAccess, StaticRemoteAccess, TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import * as settings from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject, NS, PANEL_ID } from '../src/client/index.ts'
import { PluginManagerPage } from '../src/client/PluginManagerPage.tsx'
import { PluginRefreshToast, type PluginRefreshToastFace } from '../src/client/PluginRefreshToast.tsx'
import { PluginsPanelIcon } from '../src/client/PluginsPanelIcon.tsx'
import type { PluginManagerFace } from '../src/client/manager-store.ts'
import type { createNavigationStore } from '../src/client/navigation-store.ts'

usePinnedBrowserLanguages('zh-CN')
beforeEach(() => { localStorage.clear() })
afterEach(cleanup)

type AccessEffect = (() => void) | Iterable<() => void>

/** One guarded callback, the Context that owns it, and the disposer of its current installation. */
interface Guard {
  readonly owner: Context
  readonly callback: () => AccessEffect
  dispose: (() => void) | undefined
}

/** A `remoteAccess` stand-in whose one answer a spec switches, installing or withdrawing every guarded effect. */
class SwitchableAccess extends Service {
  private allowed = true
  private readonly guards: Guard[] = []

  constructor(serviceCtx: Context) {
    super(serviceCtx, 'remoteAccess')
  }

  whenAccess(_action: string, callback: () => AccessEffect): () => void {
    const guard: Guard = { owner: this.ctx, callback, dispose: undefined }
    this.guards.push(guard)
    this.install(guard)
    return () => {}
  }

  /** @param allowed - the answer every guarded effect follows from now on. */
  set(allowed: boolean): void {
    this.allowed = allowed
    for (const guard of this.guards) {
      if (allowed) this.install(guard)
      else { guard.dispose?.(); guard.dispose = undefined }
    }
  }

  private install(guard: Guard): void {
    if (!this.allowed || guard.dispose !== undefined) return
    const dispose = guard.owner.effect(guard.callback)
    guard.dispose = () => { void dispose() }
  }
}

async function bench(allows: ((action: string) => boolean) | 'switchable' = () => true) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  const access = allows === 'switchable' ? new SwitchableAccess(ctx) : undefined
  if (allows !== 'switchable') new StaticRemoteAccess(ctx, allows)
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
      readBundleDetail: vi.fn(() => Promise.resolve({ ok: true as const, value: { status: 'none' as const } })),
    },
  })
  const panelInfo = createSnapshotStore<PanelInfo>({ activePanelId: null })
  const selectPanel = vi.fn<ILayout['selectPanel']>((activePanelId) => { panelInfo.set({ activePanelId }) })
  ctx.provide('layout', { panelInfo, selectPanel, beginNavigation: () => new AbortController().signal,
    toggleSidebar: vi.fn(), openRightbar: vi.fn(), closeRightbar: vi.fn() })
  await ctx.plugin(settings).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, list, remote, selectPanel, panelInfo, access }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'main': { kind: 'keyed', scope: 'root' },
      'shell.overlay': { kind: 'list', scope: 'root' },
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
    expect(navigation.getSnapshot()).toEqual({ tab: 'installed', view: { kind: 'list' } })
    b.ctx.pluginNavigation.openBundle('dsh-navigation-test')
    expect(b.panelInfo.getSnapshot().activePanelId).toBe(PANEL_ID)
    expect(navigation.getSnapshot()).toEqual({ tab: 'installed', view: { kind: 'package', name: 'dsh-navigation-test' } })
    b.selectPanel(null)
    expect(navigation.getSnapshot()).toEqual({ tab: 'installed', view: { kind: 'list' } })
    b.selectPanel(PANEL_ID)
    expect(navigation.getSnapshot()).toEqual({ tab: 'installed', view: { kind: 'list' } })
    assert(navigation.actions.setView)
    navigation.actions.setView({ kind: 'more' })
    b.selectPanel(null)
    expect(navigation.getSnapshot()).toEqual({ tab: 'installed', view: { kind: 'list' } })
    b.ctx.pluginNavigation.openBundle('dsh-navigation-test')
    removeRoot()
    b.selectPanel(null)
    expect(navigation.getSnapshot()).toEqual({ tab: 'installed', view: { kind: 'package', name: 'dsh-navigation-test' } })
  })

  it('opens the Plugins list from another panel and resets bundle details without opening installation', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('main')[0]!
    assert(entry.store && 'create' in entry.store)
    const navigation = entry.store.create() as ReturnType<ReturnType<typeof createNavigationStore>['create']>
    const injected: object = entry.inject!()
    const face = injected as PluginManagerFace
    expect(face.hooks.pluginManager.getSnapshot().install.open).toBe(false)

    b.ctx.pluginNavigation.openList()
    expect(b.panelInfo.getSnapshot().activePanelId).toBe(PANEL_ID)
    expect(navigation.getSnapshot()).toEqual({ tab: 'installed', view: { kind: 'list' } })
    expect(face.hooks.pluginManager.getSnapshot().install.open).toBe(false)

    b.ctx.pluginNavigation.openBundle('dsh-navigation-test')
    expect(navigation.getSnapshot()).toEqual({ tab: 'installed', view: { kind: 'package', name: 'dsh-navigation-test' } })
    navigation.actions.setTab('fixture-discover')
    b.ctx.pluginNavigation.openList()
    expect(b.panelInfo.getSnapshot().activePanelId).toBe(PANEL_ID)
    expect(navigation.getSnapshot()).toEqual({ tab: 'installed', view: { kind: 'list' } })
    expect(face.hooks.pluginManager.getSnapshot().install.open).toBe(false)
    expect(b.list).not.toHaveBeenCalled()
  })

  it('shares refresh failures with the overlay after navigation and releases both registrations across reloads', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('shell.overlay')).toHaveLength(0)
    const removeRoot = declare(b.slots)
    const mainInjected: object = b.slots.entries('main')[0]!.inject!()
    const face = mainInjected as PluginManagerFace
    expect(b.ctx.pluginChanges.bundle('unlisted').getSnapshot()).toBe(false)
    const overlayInjected: object = b.slots.entries('shell.overlay')[0]!.inject!()
    const overlay = overlayInjected as PluginRefreshToastFace
    expect(overlay.hooks.pluginManager).toBe(face.hooks.pluginManager)
    face.ensure()
    await vi.waitFor(() => { expect(face.hooks.pluginManager.getSnapshot().status).toBe('ready') })
    b.selectPanel(PANEL_ID)
    b.list.mockRejectedValueOnce(new Error('offline'))
    face.refresh()
    b.selectPanel(null)
    await vi.waitFor(() => { expect(overlay.hooks.pluginManager.getSnapshot().notice?.kind).toBe('refresh-failed') })
    overlay.dismissNotice()
    expect(face.hooks.pluginManager.getSnapshot().notice).toBeNull()
    removeRoot()
    expect(b.slots.entries('shell.overlay')).toHaveLength(0)
    expect(b.slots.entries('main')).toHaveLength(0)
    declare(b.slots)
    const remountedInjected: object = b.slots.entries('shell.overlay')[0]!.inject!()
    expect((remountedInjected as PluginRefreshToastFace).hooks.pluginManager).toBe(face.hooks.pluginManager)
    await fiber.dispose()
    expect(b.slots.entries('shell.overlay')).toHaveLength(0)
    expect(b.slots.entries('main')).toHaveLength(0)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const reloadedInjected: object = b.slots.entries('shell.overlay')[0]!.inject!()
    expect((reloadedInjected as PluginRefreshToastFace).hooks.pluginManager).not.toBe(face.hooks.pluginManager)
    expect((reloadedInjected as PluginRefreshToastFace).hooks.pluginManager.getSnapshot().notice).toBeNull()
  })

  it('declares only the services the page and its Remote methods use', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.pluginManager', 'remote.pluginInventory', 'remote.pluginRegistryProbe', 'configForms', 'layout', 'remoteAccess'])
  })

  it('reads the Host again on a later grant after showing the page, and not while access is withdrawn', async () => {
    const b = await bench('switchable')
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const injected: object = b.slots.entries('main')[0]!.inject!()
    const face = injected as PluginManagerFace
    face.ensure()
    await vi.waitFor(() => { expect(face.hooks.pluginManager.getSnapshot().status).toBe('ready') })
    expect(b.list).toHaveBeenCalledTimes(1)

    b.access!.set(false)
    expect(b.slots.entries('main')).toEqual([])
    b.remote.emit('plugin-manager/changed', [{ reason: 'install' }])
    await Promise.resolve()
    expect(b.list).toHaveBeenCalledTimes(1)

    b.access!.set(true)
    expect(b.slots.entries('main')).toHaveLength(1)
    await vi.waitFor(() => { expect(b.list).toHaveBeenCalledTimes(2) })
  })

  it('contributes the entry, page, and navigation only while the current Peer may list bundles, and observes changes either way', async () => {
    const allows = vi.fn(() => false)
    const b = await bench(allows)
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(allows).toHaveBeenCalledWith('pluginManager/listBundles')
    for (const name of ['main', 'shell.overlay', 'sidebar.panellist'] as const) expect(b.slots.entries(name)).toEqual([])
    expect(b.ctx.get('pluginNavigation')).toBeUndefined()
    expect(b.ctx.get('pluginChanges')?.bundle('dsh-any').getSnapshot()).toBe(false)
    await fiber.dispose()
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
    expect(entry.store.create().getSnapshot()).toEqual({ tab: 'installed', view: { kind: 'package', name: 'dsh-navigation-test' } })
    expect(entry.component).toBe(PluginManagerPage)
    expect(entry.options).toMatchObject({ key: PANEL_ID })
    expect(entry.locale).toBe(NS)
    // The sidebar entry addresses the page by the same id and speaks the dictionary.
    const icon = b.slots.entries('sidebar.panellist')[0]!
    expect(icon.component).toBe(PluginsPanelIcon)
    const unread = () => { throw new Error('The sidebar icon must not read application state') }
    const glyph = render(<PluginsPanelIcon size={18} active={false}
      usePanelInfo={unread} useSessions={unread} useSessionStatus={unread} useSessionRetainInfo={unread}
      useWorkspaces={unread} useContextMenu={contextMenuHook()} useResource={unread} {...allowAllAccess} />)
    expect(glyph.container.querySelector('svg')?.getAttribute('width')).toBe('18')
    expect(icon.options).toMatchObject({ id: PANEL_ID, order: 0 })
    expect(icon.locale).toBe(NS)
    expect(resolveSlotLabel(icon.options.label)).toBe('插件')
    // The page declares the slots a plugin's configuration arrives through, and binds their projection beside its state.
    expect(b.slots.spec('plugins.add.actions')).toMatchObject({ kind: 'list', scope: 'root' })
    expect(b.slots.spec('plugins.item')).toMatchObject({ kind: 'list', scope: 'root' })
    expect(b.slots.spec('plugins.bundle.config')).toMatchObject({ kind: 'keyed', scope: 'root' })
    expect(b.slots.spec('plugins.row.config')).toMatchObject({ kind: 'keyed', scope: 'root' })
    for (const name of ['plugins.detail.actions', 'plugins.detail.badge', 'plugins.detail.section'] as const) {
      expect(b.slots.spec(name)).toMatchObject({ kind: 'list', scope: 'root' })
    }
    const injected: object = entry.inject!()
    const face = injected as PluginManagerFace
    const overlay = b.slots.entries('shell.overlay')[0]!
    expect(overlay.component).toBe(PluginRefreshToast)
    expect(overlay.options).toMatchObject({ id: 'plugin-manager.refresh-toast' })
    expect(overlay.locale).toBe(NS)
    const overlayInjected: object = overlay.inject!()
    const overlayFace = overlayInjected as PluginRefreshToastFace
    expect(overlayFace.hooks.pluginManager).toBe(face.hooks.pluginManager)
    expect(overlayFace.dismissNotice).toBe(face.dismissNotice)
    expect(Object.keys(overlayFace).sort()).toEqual(['dismissNotice', 'hooks'])
    expect(Object.keys(overlayFace.hooks)).toEqual(['pluginManager'])
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
    // A profile change invalidates reads without withdrawing the displayed document.
    face.loadDetail('dsh-a', '1.0.0', 'en', false)
    await vi.waitFor(() => { expect(Object.values(face.hooks.bundleDetails.getSnapshot())[0]?.status).toBe('ready') })
    const loadedDetails = face.hooks.bundleDetails.getSnapshot()
    face.retryDetail('dsh-a', '1.0.0', 'en', false)
    expect(face.detailImage('dsh-a', 'README.md', 'a.png', false)).toContain('api/plugin-manager/detail-file?bundle=dsh-a')
    expect(face.hooks.locale.getSnapshot().active).toBe('zh')
    b.remote.emit('plugin-manager/changed', [{ reason: 'bundle' }])
    await vi.waitFor(() => { expect(b.list).toHaveBeenCalledTimes(2) })
    expect(face.hooks.bundleDetails.getSnapshot()).toEqual(loadedDetails)
    b.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(b.list).toHaveBeenCalledTimes(3) })

    // Install output folds into an open run only.
    face.openInstall()
    face.editInstallSpec('pkg')
    b.remote.emit('plugin-manager/install-log', [{ jobId: 'j', argv: ['pnpm', 'add', 'pkg'], cwd: '/p', stream: 'stdout', text: 'early' }])
    b.remote.emit('plugin-manager/install-state', [{ requestId: 'foreign', phase: 'installing' }])
    expect(face.hooks.pluginManager.getSnapshot().install.runs).toEqual([])
    // Update progress reaches only the update this page started.
    b.remote.emit('plugin-manager/update-state', [{ requestId: 'foreign', step: 'checking' }])
    expect(face.hooks.pluginManager.getSnapshot().update).toBeNull()

    await fiber.dispose()
    expect(b.ctx.get('pluginNavigation')).toBeUndefined()
    expect(b.ctx.get('pluginChanges')).toBeUndefined()
    expect(b.slots.entries('main')).toHaveLength(0)
    expect(b.slots.entries('shell.overlay')).toHaveLength(0)
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(0)
    b.remote.emit('plugin-manager/changed', [{ reason: 'install' }])
    await Promise.resolve()
    expect(b.list).toHaveBeenCalledTimes(3)
  })
})
