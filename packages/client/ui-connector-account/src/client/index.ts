/**
 * Connector account surfaces, browser half: follows the accounts CLI app plugins and MCP connectors register on the Host,
 * and shows each bundle's section, title tag, and activation prompt on its Plugins page, with the notices of the
 * operations this browser started. The surfaces read the shared copy from this package's dictionary and each
 * registrant's text from the Host.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import {
  ConnectorAccountActivationEntry, ConnectorAccountBadgeEntry, ConnectorAccountSectionEntry, ConnectorAccountToastEntry,
} from './components.tsx'
import { de, en, es, fr, ja, NS, pt, ru, zh } from './locales.ts'
import { BrowserAccounts } from './state.ts'
import type { ConnectorAccountFace } from './types.ts'

export type { ConnectorAccountKey } from './locales.ts'
export type {
  ConnectorAccountFace, ConnectorAccountNotice, ConnectorAccountsState, ConnectorBundleAccountFace,
} from './types.ts'

/** The `connectorAccounts` Remote that `dsh-api-remotes` mounts, and the services the slot registrations need. */
export const inject = ['remote', 'remote.connectorAccounts', 'slots', 'locale']

function registerBundle(ctx: Context, face: ConnectorAccountFace, packageName: string, account: string): () => void {
  const bundle = { ...face, account }
  const dispose = ctx.effect(function* () {
    yield ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config', key: packageName, locale: NS, inject: () => bundle,
    }, ConnectorAccountSectionEntry))
    yield ctx.slots.inject('plugins.bundle.activation', () => ctx.slots.register({
      name: 'plugins.bundle.activation', key: packageName, locale: NS, inject: () => bundle,
    }, ConnectorAccountActivationEntry))
  }, `connector-account: ${packageName}`)
  return () => void dispose()
}

/**
 * Show the registered connector accounts for one plugin lifetime: one tag and one notice entry for the page, and a
 * section and activation prompt for each bundle that owns an account.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'connector-account: dictionaries')
  const remote = ctx.remote.connectorAccounts
  const browser = new BrowserAccounts(ctx, remote)
  ctx.effect(() => async () => { await browser.dispose() }, 'connector-account: stream')
  const face: ConnectorAccountFace = {
    hooks: { connectorAccounts: browser.state },
    start: (key, operation) => remote.start(key, operation),
    cancel: (key, id) => remote.cancel(key, id),
    resolveText: text => ctx.locale.resolveText(text),
    follow: (key, id) => { browser.follow(key, id) },
    failed: () => { browser.failed() },
    dismissNotice: () => { browser.dismissNotice() },
  }
  ctx.effect(function* () {
    yield ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register({
      name: 'plugins.detail.badge', id: 'connector-account.badge', locale: NS, inject: () => face,
    }, ConnectorAccountBadgeEntry))
    yield ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: 'connector-account.notice', locale: NS, inject: () => face,
    }, ConnectorAccountToastEntry))
  }, 'connector-account: page surfaces')
  ctx.effect(() => {
    const shown = new Map<string, { readonly account: string; readonly withdraw: () => void }>()
    const sync = (): void => {
      const owned = new Map<string, string>()
      for (const entry of browser.state.getSnapshot().accounts.values()) {
        if (entry.packageName !== undefined) owned.set(entry.packageName, entry.key)
      }
      for (const [packageName, surfaces] of shown) {
        if (owned.get(packageName) === surfaces.account) continue
        surfaces.withdraw()
        shown.delete(packageName)
      }
      for (const [packageName, account] of owned) {
        if (!shown.has(packageName)) shown.set(packageName, { account, withdraw: registerBundle(ctx, face, packageName, account) })
      }
    }
    sync()
    const stop = browser.state.subscribe(sync)
    return () => {
      stop()
      for (const surfaces of shown.values()) surfaces.withdraw()
    }
  }, 'connector-account: bundle surfaces')
}
