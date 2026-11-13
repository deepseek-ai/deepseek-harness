/** Optional browser provider; registering it does not allocate an iframe. */
import type { Context } from '@deepseek-ai/cordis'
import { createIFrameScriptRealmFactory } from './iframe.ts'

/** Provider plugin identity. */
export const name = 'script-realm-iframe'
/** Provider registry supplied by the kernel Client plugin. */
export const inject = ['scriptRealms']

/**
 * Register the iframe implementation using this provider's page document.
 * @param ctx - Registry-bearing provider context.
 */
export function apply(ctx: Context): void {
  ctx.scriptRealms.register('iframe', createIFrameScriptRealmFactory({ document }))
}
