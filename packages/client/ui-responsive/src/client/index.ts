/**
 * Page media-query answers and the device class, published to every Slot scope.
 * @module @deepseek-ai/dsh-client-ui-responsive/client
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { isMobileDevice } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { HostObservable, RootStandardSourceContribution } from '@deepseek-ai/dsh-client-ui-slots/client'
// Type-only: the SlotRegistry (`ctx.slots`) merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Owner of the `useMediaQuery` and `useMobile` standard props. A plugin whose components read them injects
     * `uiResponsive`, so it starts after both props are published and unloads when they are withdrawn. The service has no
     * public members.
     */
    uiResponsive: UiResponsiveService
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
  interface GlobalStandardProps {
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

/** Publishes `useMediaQuery` and `useMobile` to every Slot scope for the lifetime of the `uiResponsive` service. */
export default class UiResponsiveService extends Service {
  /** Root standard props are published through the Slot registry. */
  static inject = ['slots']

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
    ctx.slots.provideRoot({
      keyedHooks: { mediaQuery },
      props: { useMobile: () => mobile },
    } satisfies RootStandardSourceContribution)
  }
}
