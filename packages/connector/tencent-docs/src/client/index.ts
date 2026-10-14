/**
 * Tencent Docs plugin, browser half: the Tencent Docs dictionary and the
 * account registration that shows the connection section, the tag beside the
 * bundle title, guidance after the bundle is switched on, and connection
 * notices on the Tencent Docs bundle's page.
 */
/* jscpd:ignore-start -- sibling connector plugins register their dictionary and account through the same calls. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-mcp-account/client'
import { en, NS, zh } from './locales.ts'

/** Services the dictionary and the account registration need. */
export const inject = ['locale', 'mcpAccounts']

/**
 * Register the Tencent Docs account surfaces for as long as the Tencent Docs row is on.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'tencent-docs: dictionaries')
  ctx.effect(() => ctx.mcpAccounts.register({
    server: 'tencent-docs', packageName: '@deepseek-ai/dsh-tencent-docs', locale: NS,
  }), 'tencent-docs: account')
}
/* jscpd:ignore-end */
