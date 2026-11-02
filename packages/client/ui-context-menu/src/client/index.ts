import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
/** Window-local menu capability and its Web overlay. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import z from '@deepseek-ai/schemastery'
import { MENU_TRANSITION_MS } from '@deepseek-ai/dsh-client-ui-primitives'
import { menuTargetKey } from './target-key.ts'
import { MenuRegistry } from './registry.ts'
import { createMenuStore } from './store.ts'
import { dictionaries } from './locales.ts'
import { MenuOverlay } from './View.tsx'
import type { ContextMenus, MenuResolution, ContextMenuTarget, ContextMenuIcon, MenuPoint, UseContextMenu } from './types.ts'
import { createContextMenuBindings } from './trigger.ts'

export type { ContextMenus, ContextMenuTarget, ContextMenuTargetMap, MenuPoint, MenuAction, MenuActionView, MenuContribution, MenuResolution } from './types.ts'
export type { ContextMenuBindings, ContextMenuTriggerProps, UseContextMenu } from './types.ts'
export type { ContextMenuIcon } from './types.ts'
export { createMenuStore } from './store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { /** Extensible context menus for explicit clicked objects. */ contextMenus: ContextMenus }
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface GlobalStandardProps {
    /** Menu bindings for explicit objects, available in every Slot scope. */
    useContextMenu: UseContextMenu
  }
  interface SlotMap {
    /** Business-owned glyph or image selected by the action's icon key. */
    'contextMenu.icon': { kind: 'keyed'; scope: 'root'; inline: true; owner: { icon: ContextMenuIcon } }
    /** Optional React rows for existing extension positions; data contributions need no renderer. */
    'contextMenu.content': { kind: 'keyed'; scope: 'root'; owner: { target: ContextMenuTarget; dismiss: () => void } }
  }
  interface LocaleNamespaceMap { /** Menu operation feedback. */ contextMenu: 'failed' }
}

/** Maximum time to prepare each contribution before omitting its pending actions. */
export interface Config { resolutionTimeoutMs?: number }
/** Validated Client menu preparation budget. */
export const Config: z<Config> = z.object({ resolutionTimeoutMs: z.natural().min(1).default(1000) })

/** Required overlay and localization services. */
export const inject = ['slots', 'locale', 'shortcuts']
/** @param ctx - plugin-owned Client context. @param config - validated preparation budget. */
export function apply(ctx: Context, config: Config = Config({})): void {
  ctx.effect(() => ctx.locale.register('contextMenu', dictionaries), 'context menu: locale')
  const t = ctx.locale.bind('contextMenu')
  const handle = createMenuStore()
  const instance = handle.create()
  const store: typeof handle = { ...handle, create: () => instance }
  const targetSource = createSnapshotStore<ContextMenuTarget | null>(null)
  let sequence = 0
  let active: { resolution: MenuResolution; unsubscribe: () => void; target: ContextMenuTarget; point: MenuPoint } | undefined
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  let openingTimer: ReturnType<typeof setTimeout> | undefined
  let finishOpening: (() => void) | undefined
  let returnFocus: HTMLElement | null = null
  let disposed = false
  const notify: ContextMenus['notify'] = (text, success = false, action) => {
    if (disposed) return
    const id = ++sequence
    instance.actions.notify({ id, text, success, ...action === undefined ? {} : { action: {
      label: action.label,
      onClick: () => {
        if (disposed || instance.getSnapshot().notice?.id !== id) return
        instance.actions.notify(null)
        try { void Promise.resolve(action.run()).catch(() => { notify(action.failureLabel) }) }
        catch (_error) { notify(action.failureLabel) }
      },
    } } })
  }
  const registry = new MenuRegistry((message) => { notify(message ?? t('failed')) }, config.resolutionTimeoutMs)
  const cancelOpening = (): void => {
    clearTimeout(openingTimer); finishOpening?.(); finishOpening = undefined
    active?.unsubscribe(); active?.resolution.dispose(); active = undefined
    targetSource.set(null)
  }
  const dismiss = (replacing: boolean): void => {
    cancelOpening()
    clearTimeout(closeTimer)
    if (instance.getSnapshot().target === null) return
    instance.actions.exit(replacing)
    closeTimer = setTimeout(() => { instance.actions.close() }, replacing ? MENU_TRANSITION_MS.replace : MENU_TRANSITION_MS.dismiss)
  }
  const close = (): void => { dismiss(false) }
  const contextMenus: ContextMenus = {
    active: targetSource,
    register: input => registry.register(input), resolve: target => registry.resolve(target), notify, close,
    open: (target, point) => {
      const previous = active
      if (previous !== undefined
        && Math.hypot(previous.point.x - point.x, previous.point.y - point.y) <= 4
        && menuTargetKey(previous.target) === menuTargetKey(target)) { close(); return }
      const focused = document.activeElement
      if (!(focused instanceof Element) || focused.closest('[data-context-menu]') === null) {
        returnFocus = focused instanceof HTMLElement ? focused : null
      }
      dismiss(true)
      const resolution = registry.resolve(target)
      targetSource.set(target)
      let displayed = false
      const publish = (): void => { if (displayed) instance.actions.items(resolution.source.getSnapshot()) }
      const occurrence = { resolution, unsubscribe: resolution.source.subscribe(publish), target, point }
      active = occurrence
      const delay = new Promise<void>((resolve) => {
        finishOpening = resolve; openingTimer = setTimeout(resolve, MENU_TRANSITION_MS.prepare)
      })
      void Promise.all([resolution.ready, delay]).then(() => {
        if (active !== occurrence) return
        clearTimeout(closeTimer)
        instance.actions.open(target, point)
        displayed = true
        publish()
      })
    },
  }
  ctx.provide('contextMenus', contextMenus)
  const bindings = createContextMenuBindings((target, point) => { contextMenus.open(target, point) }, () => !disposed)
  ctx.slots.provideRoot({ props: { useContextMenu: () => bindings } })
  ctx.effect(() => {
    const outside = (event: PointerEvent): void => {
      if (event.button === 2 || (event.target instanceof Element && event.target.closest('[role="menu"], [data-context-menu-trigger]'))) return
      close()
    }
    const context = (event: MouseEvent): void => { if (!event.defaultPrevented) close() }
    const escape = (event: KeyboardEvent): void => {
      if (active !== undefined && instance.getSnapshot().target === null && event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); close()
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('contextmenu', context)
    window.addEventListener('keydown', escape, true)
    return () => {
      disposed = true; cancelOpening(); clearTimeout(closeTimer); registry.dispose(); instance.actions.close()
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('contextmenu', context)
      window.removeEventListener('keydown', escape, true)
    }
  }, 'context menu: lifetime')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'context-menu', store,
    children: {
      'contextMenu.content': { kind: 'keyed', scope: 'root' },
      'contextMenu.icon': { kind: 'keyed', scope: 'root', inline: true },
    },
    inject: () => ({ hooks: { catalog: ctx.shortcuts.catalog }, close, returnFocus: () => returnFocus, select: (id: string) => {
      const selected = active?.resolution
      active?.unsubscribe(); active = undefined
      targetSource.set(null); dismiss(false)
      selected?.select(id); selected?.dispose() } }),
  }, MenuOverlay))
}
