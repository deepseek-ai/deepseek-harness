/**
 * Browser half: fill the frame's right column with the panel, put the expand
 * button in the conversation header, and own the seats a tab type registers
 * into.
 *
 * Two seats share one session-scoped store, which the slot runtime allows
 * because both are session-scoped (a handle may not span scopes). The panel seat
 * in the frame draws the surface normally or fullscreen, retaining the track
 * on wide viewports; the header's corner seat draws the way back in
 * while the panel is hidden. The store is the layout's only source of truth; the docking
 * kit's pure planners compute every change and the store records them, one
 * history entry per intent.
 *
 * The frame is a base package and never injects this one. What it needs —
 * whether the panel is shown and whether it wants a track — arrives through its
 * own `ctx.layout` action face, reported by the seat that knows both facts.
 *
 * Tab types register in two stages: the type itself into `ctx.sidebarRightTabs`,
 * its body into the keyed `sidebar.right.pane.tab` seat under the same kind. The
 * guide registers through those stages unmodified, exactly as a type shipped
 * from another package does — `ui-sidebar-documentpreview` is the live proof.
 */
import type {} from '@deepseek-ai/dsh-client-shortcuts/client'
import { observeSidebarFocus } from './focus.ts'
import { registerSidebarShortcuts } from './shortcuts.ts'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from './contract/slots.ts'
import { GuideBody, type GuideInjected } from './tabs/guide/GuideBody.tsx'
import { GuideTitle } from './tabs/guide/GuideTitle.tsx'
import { ExpandButton } from './shell/ExpandButton.tsx'
import { RightbarSeat, type SidebarRightInjected } from './shell/SidebarRight.tsx'
import { RightbarRoot, type RightbarRootInjected } from './shell/RightbarRoot.tsx'
import { SidebarSessionViews } from './session-views.ts'
import { createSidebarRightController, type SidebarRightController } from './service.ts'
import { SidebarRightTabRegistry } from './tab-registry.ts'
import { createSidebarRightStore } from './stores.ts'
import { en, zh } from './locales.ts'
import { GUIDE_ID, guideDefinition } from './tabs/guide/definition.ts'
import { guideTabInfoFactory, tabInfoFactory } from './tab-info.ts'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { defaultSeed } from './contract/seed.ts'

export type { SidebarRightTarget } from './focus.ts'
export type { RightbarSeatProps, SidebarRightInjected, SidebarRightPresentation } from './shell/SidebarRight.tsx'
export type { GuideBodyProps, GuideInjected } from './tabs/guide/GuideBody.tsx'
export type { ExpandButtonProps } from './shell/ExpandButton.tsx'
export type { SidebarRightState, SurfaceState } from './stores.ts'
export type {
  ISidebarRight, SidebarRightBinding, SidebarRightOpenResourceOptions, SidebarRightOpenTabOptions,
  SidebarRightPlacement, SidebarRightCloseHandler, SurfaceActions,
} from './service.ts'
export type {
  SidebarRightGuideBox, SidebarRightGuideEntry, SidebarRightTabClaim, SidebarRightTabDefinition,
  SidebarRightTabPriority,
} from './tab-registry.ts'
export type {
  SidebarRightTabInfo, SidebarRightTabInjected, UseSidebarRightTabInfo, SidebarRightTabActions,
  SidebarRightTabMenuOwnerProps, SidebarRightTabNavigation, SidebarRightTabPlacement, SidebarRightGuideEntryOwnerProps,
} from './contract/slots.ts'
export type {
  SidebarRightNavigationParams, SidebarRightResourceParams, SidebarRightResourceParamsMap,
  SidebarRightTabParams, SidebarRightTabParamsFor, SidebarRightTabParamsMap,
} from './contract/params.ts'
// The layout ids and rectangle the navigation face takes, so a caller needs no import from the kit.
export type { FloatRect, PaneId, TabId, TabRecord } from '@deepseek-ai/dsh-client-ui-dockkit'
export type { PinResource, SidebarRightNavigator, TabOccurrence, SidebarRightOccurrenceId } from './tab-domain.ts'
export type { SidebarRightKey } from './locales.ts'
export type { OpenContentIntent } from './stores.ts'
export type { SidebarRightOpenTab } from './tab-inventory.ts'

/** This package's copy namespace. */
const NS = 'sidebarRight'

/** Required browser services: the slot registry, the frame's panel actions, copy, and the resource model. */
export const inject = ['slots', 'layout', 'locale', 'resources', 'sessions', 'uiSession', 'shortcuts']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Right-Sidebar navigation and presentation face. */
    sidebarRight: SidebarRightController
    /** Right-Sidebar tab-type registry (stage one of a tab type's registration). */
    sidebarRightTabs: SidebarRightTabRegistry
  }
}

/**
 * Client plugin body: provide the registry and the navigation face, register the
 * panel seat and the rail seat over one store with their extension children, and
 * register the guide type through the same public two-stage path any other type
 * uses.
 * @param ctx - client root context carrying the slot registry, the frame's face, and copy.
 */
export function apply(ctx: ClientContext): void {
  // The registry and the face it backs are built here, at apply's top level,
  // and never inside an effect. A registry other packages register into cannot
  // have an effect-internal scope as its host: `register()` adds an effect to
  // this fiber, and doing that from another plugin's apply while the effect is
  // still the active scope stalls browser boot with no error at all. The
  // template this follows (ui-conversation's definition registry) is built at
  // its own apply top level for the same reason.
  const t = ctx.locale.bind(NS)
  const tabs = new SidebarRightTabRegistry(ctx)
  const views = new SidebarSessionViews(ctx.sessions)
  ctx.effect(() => {
    const current = ctx.uiSession.adapter.current
    const sync = (): void => { views.select(current.getSnapshot().key as SessionId | undefined) }
    const unsubscribe = current.subscribe(sync)
    sync()
    return () => { unsubscribe(); views.dispose() }
  }, 'ui-sidebar-right: retained Session views')
  const { controller, adopt, forget } = createSidebarRightController(
    tabs,
    (address, signal) => { ctx.resources.pin(address, signal) },
  )
  const disposeRegistry = ctx.reflect.provide('sidebarRightTabs', tabs)
  const disposeService = ctx.reflect.provide('sidebarRight', controller)
  // Registered first, so it tears down last: the faces outlive every seat and
  // type that reaches for them. provide()'s disposer settles asynchronously;
  // teardown is synchronous fire-and-forget, matching ui-layout's root entry.
  // Unloading aborts every tab occurrence, which releases every pin.
  ctx.effect(() => () => {
    controller.tabDomain.dispose()
    void disposeService()
    void disposeRegistry()
  }, 'ui-sidebar-right: service faces')

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sidebar-right: dictionaries')
  ctx.effect(() => registerSidebarShortcuts(ctx.shortcuts, controller, t, () => {
    void ctx.shortcuts.closeWindow().catch((error: unknown) => { console.error('Window close failed', error) })
  }), 'ui-sidebar-right: shortcuts')
  if (typeof document !== 'undefined') ctx.effect(() => observeSidebarFocus(document), 'ui-sidebar-right: focus')

  ctx.effect(() => {
    const handle = createSidebarRightStore(() => defaultSeed(tabs))
    // Each Session Context generation owns one Store. Background tab actions
    // use the latest adoption for that Session.
    const adoptions = new Map<SessionId, () => void>()
    const store: typeof handle = {
      ...handle,
      create: (scopeKey) => {
        const instance = handle.create(scopeKey)
        if (scopeKey !== undefined) {
          const sessionId = scopeKey as SessionId
          adoptions.get(sessionId)?.()
          adoptions.set(sessionId, adopt(sessionId, instance))
        }
        return { ...instance, clearPersisted() {
          instance.clearPersisted()
          if (scopeKey !== undefined) forget(scopeKey as SessionId)
        } }
      },
    }
    const layout: ILayout = ctx.layout
    const injected: Omit<SidebarRightInjected, 'keyedHooks' | 'occurrence' | 'closeTab'> = {
      syncPresentation({ shown, track, fullscreen }) {
        if (shown) layout.openRightbar(track, fullscreen)
        else layout.closeRightbar()
      },
      bindService: binding => controller.bind(binding),
      splitPane: (paneId) => { controller.split(paneId) },
      toggleFullscreen: () => { const target = controller.commandTarget(); if (target !== undefined) controller.toggleFullscreen(target) },
      openTab: (kind, options) => { controller.openTab(kind, options) },
      hooks: {
        shortcuts: ctx.shortcuts.catalog,
        tabTypes: { subscribe: listener => tabs.subscribe(listener), getSnapshot: () => tabs.entries() },
      },
    }

    const disposeTypes = [tabs.register(guideDefinition(t))]
    const disposeSeat = ctx.slots.inject('rightbar', function* () {
      yield ctx.slots.register({
        name: 'rightbar',
        children: { 'rightbar.session': { kind: 'single', scope: 'session' } },
        inject: (): RightbarRootInjected => ({
          hooks: { views: views.source },
          mountView: reference => views.mount(reference),
        }),
      }, RightbarRoot)
      yield ctx.slots.register({
        name: 'rightbar.session',
        locale: NS,
        children: {
          'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: tabInfoFactory } } },
          'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: tabInfoFactory } } },
          'sidebar.right.tab.menu.item': { kind: 'list', scope: 'session' },
        },
        store,
        inject: (sessionId): SidebarRightInjected => ({
          ...injected,
          closeTab: (tabId) => {
            try { controller.closeIn(sessionId, tabId) }
            catch (error) { console.error('Sidebar tab close failed:', error) }
          },
          keyedHooks: { tabNavigation: key => controller.tabDomain.occurrence(sessionId, { id: key as TabId }).navigation },
          occurrence: tab => controller.tabDomain.occurrence(sessionId, tab),
        }),
      }, RightbarSeat)
    })
    // The expand button shares the panel's store: it only needs to know whether
    // the panel is expanded, and to ask for it to be. The header's corner seat
    // is its own place, past the utilities, so showing and hiding it moves
    // nothing else in the row.
    const disposeExpand = ctx.slots.inject('conversation.session.header.corner', () => ctx.slots.register({
      name: 'conversation.session.header.corner',
      locale: NS,
      store,
      inject: () => ({ hooks: { shortcuts: ctx.shortcuts.catalog } }),
    }, ExpandButton))
    // Stage two for the guide: it declares the chain child it hosts and reads
    // the registry's entry boxes, which an ordinary type has no reason to do.
    const guideInjected: GuideInjected = {
      hooks: {
        shortcuts: ctx.shortcuts.catalog,
        guideEntries: { subscribe: listener => tabs.subscribe(listener), getSnapshot: () => tabs.guide() },
      },
    }
    const disposeGuide = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: GUIDE_ID,
      children: {
        'sidebar.right.tab.guide.entry': {
          kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: guideTabInfoFactory } },
        },
        'sidebar.right.tab.guide': {
          kind: 'chain', scope: 'session', inject: { hooks: { tabInfo: guideTabInfoFactory } },
        },
      },
      inject: () => guideInjected,
    }, GuideBody))
    const disposeGuideTitle = ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
      { name: 'sidebar.right.pane.tab.title', key: GUIDE_ID },
      GuideTitle,
    ))
    return () => {
      disposeGuideTitle()
      disposeGuide()
      disposeExpand()
      disposeSeat()
      for (const dispose of disposeTypes.reverse()) dispose()
      for (const release of adoptions.values()) release()
      adoptions.clear()
    }
  }, 'ui-sidebar-right: seats and shipped tab type')
}
