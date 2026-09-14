/**
 * Application mount through a dependency fiber, so replacing `uiRenderer`
 * remounts the application. Shared by `AppWebEntry` and the test carrier.
 * @module @deepseek-ai/dsh-client-web/src/mount
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

/**
 * Mount the UI renderer into `container` through a dependency fiber on
 * `uiRenderer`: the mount effect installs when the service is provided and
 * reinstalls when it is replaced.
 * @param ctx - booted root Context.
 * @param container - application mount point.
 * @returns resolves once the dependency fiber exists; with `uiRenderer`
 * already provided (as after `bootClient`) the mount effect is installed by
 * then, otherwise it installs when the service arrives.
 */
export async function mountClient(ctx: Context, container: HTMLElement): Promise<void> {
  const mounted = ctx.inject(['uiRenderer'], (scope) => {
    scope.effect(() => scope.uiRenderer.mount(container), 'web boot: application mount')
  })
  await mounted
}
