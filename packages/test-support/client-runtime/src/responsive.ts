/**
 * Fixed browser Hooks for hand-built component props and the Slot test renderer.
 * @module @deepseek-ai/dsh-client-test-runtime/src/responsive
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-responsive/client'

/** The responsive Hooks every Slot component receives. */
export type ResponsiveStandardProps = Pick<GlobalStandardProps,
  'useMediaQuery' | 'useMobile' | 'useDocumentPortal' | 'useDocumentViewport'>

type PortalComponent = ReturnType<ResponsiveStandardProps['useDocumentPortal']>
const InlinePortal: PortalComponent = ({ children }) => children

/** Fixed answers of {@link responsiveHooks}. */
export interface ResponsiveHookOptions {
  /** The `useMobile` answer; false when omitted. */
  readonly mobile?: boolean
  /** The `useMediaQuery` answer for each query; no query matches when omitted. */
  readonly matches?: (query: string) => boolean
  /** The `useDocumentViewport` snapshot in CSS pixels; defaults to 1024 × 768. */
  readonly viewport?: ReturnType<ResponsiveStandardProps['useDocumentViewport']>
  /** The component returned by `useDocumentPortal`; the default renders children inline without document listeners. */
  readonly portal?: PortalComponent
}

/**
 * Supply responsive Hooks without subscribing to browser events.
 * @param options - fixed answers and optional portal component; omitted fields use the fixture defaults.
 * @returns the responsive standard props, with a stable viewport snapshot and portal component.
 */
export function responsiveHooks(options: ResponsiveHookOptions = {}): ResponsiveStandardProps {
  const {
    mobile = false, matches = () => false,
    viewport = { width: 1024, height: 768 }, portal = InlinePortal,
  } = options
  return {
    useMediaQuery: query => matches(query),
    useMobile: () => mobile,
    useDocumentPortal: () => portal,
    useDocumentViewport: () => viewport,
  }
}

/**
 * Publishes the media-query and device props for the lifetime of the `uiResponsive` stand-in service.
 */
export class StaticUiResponsive extends Service {
  /** Root standard props are published through the Slot registry. */
  static inject = ['slots']

  /**
   * @param ctx - Context the service is provided on.
   * @param options - fixed answers passed to {@link responsiveHooks}.
   */
  constructor(ctx: Context, options: ResponsiveHookOptions = {}) {
    super(ctx, 'uiResponsive')
    const { useMediaQuery, useMobile } = responsiveHooks(options)
    ctx.slots.provideRoot({ props: { useMediaQuery, useMobile } })
  }
}
