/**
 * Linear plugin, browser half: the Linear dictionary and the account
 * registration that shows the connection section, the tag beside the bundle
 * title, guidance after the bundle is switched on, and connection notices on
 * the Linear bundle's page.
 */
/* jscpd:ignore-start -- sibling connector plugins register their dictionary and account through the same calls. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-mcp-account/client'
import { de, en, es, fr, ja, NS, pt, ru, zh } from './locales.ts'

/** Services the dictionary and the account registration need. */
export const inject = ['locale', 'mcpAccounts']

/**
 * Register the Linear account surfaces for as long as the Linear row is on.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'linear: dictionaries')
  ctx.effect(() => ctx.mcpAccounts.register({
    server: 'linear', packageName: '@deepseek-ai/dsh-linear', locale: NS,
  }), 'linear: account')
}
/* jscpd:ignore-end */
