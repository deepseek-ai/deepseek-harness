/**
 * Which plugins bring their own configuration to the Plugins page, read from
 * the three slots the page declares (the official plugins listed beside the
 * official bundles, the bundles with a form on their page, the rows with a
 * page of their own) and from the Factory-declared `settings.section` (the
 * plugins' settings pages). The projection follows the slot ledgers and the
 * active locale and keeps its snapshot until one of them moves.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { resolveSlotLabel, type HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './slot-contract.ts'
// Type-only: the `settings.section` declaration whose entries this page lists.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

/** One official plugin as the page lists it: its registration id and its title in the active locale. */
export interface OfficialItem {
  readonly id: string
  readonly label: string
}

/** One `settings.section` entry: its id, its title in the active locale, and the package that registered it, when known. */
export interface SettingsSectionItem {
  readonly id: string
  readonly label: string
  readonly module?: string
}

/**
 * The plugins carrying configuration: the official plugins in ledger order,
 * the package names of the bundles with a page-level form, the keys
 * ({@link rowConfigKey}) of the rows with a page, and the plugins' settings
 * pages in ledger order.
 */
export interface ConfigLedger {
  readonly items: readonly OfficialItem[]
  readonly bundles: ReadonlySet<string>
  readonly rows: ReadonlySet<string>
  readonly sections: readonly SettingsSectionItem[]
}

/**
 * The key a row's configuration registers under.
 * @param bundle - the bundle's package name.
 * @param rowId - the row id the bundle's patch declares.
 * @returns the `plugins.row.config` key.
 */
export function rowConfigKey(bundle: string, rowId: string): string {
  return `${bundle}#${rowId}`
}

const SLOTS = ['plugins.item', 'plugins.bundle.config', 'plugins.row.config', 'settings.section'] as const

/**
 * Project the configuration ledgers as one observable the page binds.
 * @param ctx - the page plugin's context, whose slot registry and locale the projection follows.
 * @returns the ledger source; its snapshot changes only when a ledger or the locale does.
 */
export function configLedgerSource(ctx: ClientContext): HostObservable<ConfigLedger> {
  let versions: readonly number[] = []
  let revision = -1
  let ledger: ConfigLedger = { items: [], bundles: new Set(), rows: new Set(), sections: [] }
  const keysOf = (name: 'plugins.bundle.config' | 'plugins.row.config'): ReadonlySet<string> =>
    new Set(ctx.slots.entries(name).flatMap(entry => entry.options.key === undefined ? [] : [entry.options.key]))
  return {
    getSnapshot: () => {
      const next = SLOTS.map(name => ctx.slots.getVersion(name))
      const current = ctx.locale.getSnapshot().revision
      if (current !== revision || next.some((version, index) => version !== versions[index])) {
        versions = next
        revision = current
        ledger = {
          items: ctx.slots.entries('plugins.item').map(entry => ({
            /* v8 ignore next -- list-slot registration requires id */
            id: entry.options.id ?? '',
            label: resolveSlotLabel(entry.options.label) ?? '',
          })),
          bundles: keysOf('plugins.bundle.config'),
          rows: keysOf('plugins.row.config'),
          sections: ctx.slots.entries('settings.section').map((entry) => {
            /* v8 ignore next -- list-slot registration requires id */
            const id = entry.options.id ?? ''
            return {
              id,
              label: resolveSlotLabel(entry.options.label) ?? id,
              ...entry.module === undefined ? {} : { module: entry.module },
            }
          }),
        }
      }
      return ledger
    },
    subscribe: (listener) => {
      const offs = [...SLOTS.map(name => ctx.slots.subscribe(name, listener)), ctx.locale.subscribe(listener)]
      return () => { for (const off of offs) off() }
    },
  }
}
