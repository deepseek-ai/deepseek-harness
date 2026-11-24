/**
 * Fixed responsive Hooks for client specs. Production pages receive `useMediaQuery` and `useMobile` from the
 * ui-responsive `uiResponsive` service. {@link SlotTestRuntime} mounts {@link StaticUiResponsive} with the
 * {@link responsiveHooks} defaults until a spec releases it to mount that service, and hand-built component props
 * spread `...responsiveHooks(options)`.
 * @module @deepseek-ai/dsh-client-test-runtime/src/responsive
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-responsive/client'

/** The responsive Hooks every Slot component receives. */
export type ResponsiveStandardProps = Pick<GlobalStandardProps, 'useMediaQuery' | 'useMobile'>

/** Fixed answers of {@link responsiveHooks}. */
export interface ResponsiveHookOptions {
  /** The `useMobile` answer; false when omitted. */
  readonly mobile?: boolean
  /** The `useMediaQuery` answer for each query; no query matches when omitted. */
  readonly matches?: (query: string) => boolean
}

/**
 * Responsive Hooks with fixed answers, for props built outside the Slot renderer. The answers never change, so a
 * component never rerenders for them.
 * @param options - the device class and each query's answer; omitted, a desktop device where no query matches.
 * @returns the `useMediaQuery` and `useMobile` props.
 */
export function responsiveHooks(options: ResponsiveHookOptions = {}): ResponsiveStandardProps {
  const { mobile = false, matches = () => false } = options
  return { useMediaQuery: query => matches(query), useMobile: () => mobile }
}

/**
 * Stand-in for the ui-responsive service: provided as `uiResponsive`, so plugins that inject it start, and publishing
 * {@link responsiveHooks} answers as the root `useMediaQuery` and `useMobile` props.
 */
export class StaticUiResponsive extends Service {
  /** Root standard props are published through the Slot registry. */
  static inject = ['slots']

  /**
   * @param ctx - Context the service is provided on.
   * @param options - fixed answers; a desktop device where no query matches when omitted.
   */
  constructor(ctx: Context, options: ResponsiveHookOptions = {}) {
    super(ctx, 'uiResponsive')
    ctx.slots.provideRoot({ props: responsiveHooks(options) })
  }
}
