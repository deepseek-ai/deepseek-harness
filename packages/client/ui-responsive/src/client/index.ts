/**
 * Page-responsive data and document portals published to every Slot scope.
 * @module @deepseek-ai/dsh-client-ui-responsive/client
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { FC } from 'react'
import { isMobileDevice } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, RootStandardSourceContribution } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the SlotRegistry (`ctx.slots`) merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createDocumentPortal, type DocumentPortalProps } from './document-portal.tsx'
import { documentViewport, type DocumentViewport } from './document-viewport.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Publishes page-responsive and portal props. Consumers inject this service so they unload with these props.
     */
    uiResponsive: UiResponsiveService
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface GlobalStandardProps {
    /**
     * @returns A stable component that portals its children into the application document body. Its native keydown
     * handlers listen on that document in the requested phase, including events outside the children.
     */
    useDocumentPortal: () => FC<DocumentPortalProps>
    /** @returns The application document's layout viewport in CSS pixels; rerenders when its dimensions change. */
    useDocumentViewport: () => DocumentViewport
    /**
     * Whether a CSS media query currently matches in the page window; the component rerenders when the answer
     * changes. Use it only when the answer selects rendered structure or behavior; a style-only difference stays in a
     * CSS `@media` rule.
     * @param query - CSS media query, such as `(prefers-reduced-motion: reduce)`.
     * @returns whether the query matches now.
     */
    useMediaQuery: (query: string) => boolean
    /**
     * Whether `isMobileDevice()` identifies the device as a phone or tablet from its user agent, including an iPad in
     * desktop mode. The answer stays fixed for the page lifetime. Use it only for behavior such as automatic focus and
     * the soft keyboard; layout decisions use width media queries.
     * @returns whether the page runs on a phone or tablet.
     */
    useMobile: () => boolean
  }
}

/** Publishes page-responsive props to every Slot scope for the lifetime of the service. */
export default class UiResponsiveService extends Service {
  /** The Slot registry publishes the props; the renderer identifies the mounted document. */
  static inject = ['slots', 'uiRenderer']

  /** @param ctx - plugin-owned Client context. */
  constructor(ctx: Context) {
    super(ctx, 'uiResponsive')
    // One source per query string for the service lifetime, so components reading the same query share one list.
    const sources = new Map<string, HostObservable<boolean>>()
    const mediaQuery = (query: string): HostObservable<boolean> => {
      let source = sources.get(query)
      if (source === undefined) {
        const list = window.matchMedia(query)
        source = {
          getSnapshot: () => list.matches,
          subscribe: (listener) => {
            list.addEventListener('change', listener)
            return () => { list.removeEventListener('change', listener) }
          },
        }
        sources.set(query, source)
      }
      return source
    }
    const mobile = isMobileDevice()
    // Consumers render after the Web kernel mounts the application, not when the service activates.
    const page = (): Window => {
      const view = ctx.uiRenderer.mountDocument?.defaultView
      if (!view) throw new Error('ui-responsive: document hooks require a mounted application window')
      return view
    }
    const Portal = createDocumentPortal(() => page().document)
    ctx.slots.provideRoot({
      hooks: { documentViewport: documentViewport(page) },
      keyedHooks: { mediaQuery },
      props: { useMobile: () => mobile, useDocumentPortal: () => Portal },
    } satisfies RootStandardSourceContribution)
  }
}
