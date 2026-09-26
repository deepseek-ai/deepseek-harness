/**
 * Browser UI renderer. It installs the slot renderer after its Cordis
 * dependencies activate and exposes the mount operation used by the web boot
 * kernel after the complete client roster settles.
 */
import { createElement, useLayoutEffect, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import type { Context } from '@deepseek-ai/cordis'
import { createSlotRenderer } from './scoped-slots.tsx'
import { buildRenderApp } from './app.tsx'
import { SlotRegistry } from './registry.ts'

export { SlotRegistry } from './registry.ts'
export type { RootOwnerProps } from './registry.ts'

export type {
  ChainRenderOpts, HostObservable, RenderOpts, SnapshotSelectorHook, SlotRenderer,
  ScopedStandardSourceBinding, SlotRendererHost, SlotScopeAdapter,
  StandardSourceBinding, StoreInstanceLike,
} from '@deepseek-ai/dsh-client-ui-slots'

/** Mount operation exposed to the framework-free boot kernel. */
export interface UiRendererService {
  /**
   * Mount the assembled application into the supplied element.
   * @param container - Application mount point.
   * @returns Disposer that unmounts the React root.
   */
  mount: (container: HTMLElement) => () => void
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * An ordinary Slot declaration or entry registration set changed. Factory
     * definitions publish through `subscribeFactory()` instead.
     * @mode emit
     * @param key - mutated SlotMap key.
     */
    'slots/changed'(key: string): void
  }
  interface Context {
    /** Renderer-owned UI composition registry. */
    slots: SlotRegistry
    /** Mount face provided after the UI renderer activates. */
    uiRenderer: UiRendererService
  }
}

/** Services required before application assembly. */
export const inject: string[] = []

interface BootSnapshot {
  className: string
  html: string
}

/** Hydrate the kernel-owned loading DOM before replacing it with the application. */
function BootHandoff(props: { app: () => ReactNode; boot: BootSnapshot }): ReactNode {
  const [ready, setReady] = useState(false)
  useLayoutEffect(() => { setReady(true) }, [])
  if (ready) return props.app()
  return createElement('div', {
    className: props.boot.className,
    'data-dsh-boot': '',
    dangerouslySetInnerHTML: { __html: props.boot.html },
  })
}

/** Mount React while preserving the framework-free boot DOM through hydration. */
function mountApp(container: HTMLElement, app: () => ReactNode): Root {
  const boot = container.querySelector<HTMLElement>(':scope > [data-dsh-boot]')
  if (boot !== null) {
    return hydrateRoot(container, createElement(BootHandoff, {
      app,
      boot: { className: boot.className, html: boot.innerHTML },
    }))
  }
  const root = createRoot(container)
  flushSync(() => { root.render(app()) })
  return root
}

/**
 * Install the slot renderer and provide the application mount face.
 * @param ctx - Plugin context.
 */
export function apply(ctx: Context): void {
  const slots = new SlotRegistry(ctx)
  slots.install(createSlotRenderer())
  ctx.reflect.provide('uiRenderer', {
    mount: (container: HTMLElement): (() => void) => {
      const root = mountApp(container, buildRenderApp({ ctx }))
      return () => { root.unmount() }
    },
  })
}
