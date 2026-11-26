/** Native root registry: Agents call every tool their scope offers directly. @module */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { NativeToolRegistry } from '@deepseek-ai/dsh-tools/pipeline'

export { NativeToolRegistry }

/** Cordis plugin name. */
export const name = 'native-tool-registry'
/** Tool registration and scoped dispatch. */
export const inject = ['tools']

/**
 * Install a native root in the mounting scope; it offers every tool that scope's Agents see.
 * The root keeps the registrations it received after unloading, so accepted batches settle their calls.
 * @param ctx - context owning the root selection and its lifetime.
 */
export function apply(ctx: Context): void {
  ctx.tools.setRoot(new NativeToolRegistry())
}
