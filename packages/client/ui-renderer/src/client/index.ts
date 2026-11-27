/**
 * Browser UI renderer. It installs the slot renderer after its Cordis
 * dependencies activate and exposes the mount operation used by the web boot
 * kernel after the complete client roster settles.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { FC } from 'react'
import type { DocumentPortalProps } from './document-portal.tsx'
import type { DocumentViewport } from './document-viewport.ts'
import { createSlotRenderer } from './scoped-slots.tsx'
import { SlotRegistry } from './registry.ts'
import { UiRenderer } from './renderer.ts'

export { SlotRegistry } from './registry.ts'
export type { RootOwnerProps } from './registry.ts'

export type {
  ChainRenderOpts, HostObservable, RenderOpts, SnapshotSelectorHook, SlotRenderer,
  ScopedStandardSourceBinding, SlotRendererHost, SlotScopeAdapter,
  StandardSourceBinding, StoreInstanceLike,
} from '@deepseek-ai/dsh-client-ui-slots/client'

/** Mount operation exposed to the framework-free boot kernel. */
export interface UiRendererService {
  /**
   * Mount the assembled application into the supplied element.
   * @param container - Application mount point.
   * @returns Disposer that unmounts the React root.
   */
  mount: (container: HTMLElement) => () => void
}

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
  interface GlobalStandardProps {
    /** @returns A stable portal component for this application mount. Its native keydown handlers listen on the document. */
    useDocumentPortal: () => FC<DocumentPortalProps>
    /** @returns The mount document's layout viewport in CSS pixels; updates when its dimensions change. */
    useDocumentViewport: () => DocumentViewport
  }
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
export const inject: string[] = ['modules']

/**
 * Install the slot renderer and provide the application mount face.
 * @param ctx - Plugin context.
 */
export function apply(ctx: Context): void {
  const slots = new SlotRegistry(ctx)
  slots.install(createSlotRenderer())
  const renderer = new UiRenderer(ctx)
  ctx.effect(function* () {
    yield ctx.effect(() => () => { renderer.dispose() }, 'ui-renderer: application lifetime')
    yield ctx.reflect.provide('uiRenderer', renderer)
  }, 'ui-renderer: service lifetime')
}
