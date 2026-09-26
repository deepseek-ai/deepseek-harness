/**
 * Settings shell and ownerless-copy plugin, browser half: renders the
 * `sidebar.settings` occupant — panel chrome, section navigation, and the
 * onboarding stage — and registers everything on the Settings pages that
 * belongs to no single feature: the trigger/header chrome content,
 * local-document action, General section, and `settings` dictionaries.
 * Feature-owned rows and sections stay with their features.
 * Export discipline: packages/client/AGENTS.md.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge and its fixed Host facts.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { closeTopModal } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: the settings slot declarations plus the ctx.configForms Context
// merge. Cross-plugin collaboration goes through the service, never a value
// import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls ctx.locale into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {
  SettingsOnboardingStep, SettingsRootInjected, SettingsSectionRow,
} from './shell-contract.ts'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import { createSettingsShellStore } from './shell-store.ts'
import { SettingsRoot } from './SettingsRoot.tsx'
import { DesktopUpdateBadge } from './DesktopUpdateIndicator.tsx'
import type { DesktopUpdateBridge } from '../types.ts'
import { DesktopUpdateSource } from './desktop-update-source.ts'
import { CloseLabel, HeaderContent, TriggerContent } from './chrome.tsx'
import { GeneralSection } from './GeneralSection.tsx'
import { CurrentVersionRow } from './CurrentVersionRow.tsx'
import { DeveloperToolsRow, type DeveloperToolsRowInjected } from './DeveloperToolsRow.tsx'
import { SettingsDocumentAction } from './SettingsDocumentAction.tsx'
import type { SettingsDocumentActionInjected } from './SettingsDocumentAction.tsx'
import { SettingsDocumentStore } from './settings-document-store.ts'
import { en, zh, type SettingsKey } from './locales.ts'

export type {
  CloseLabelProps, HeaderContentProps, TriggerContentProps,
} from './chrome.tsx'
export type {
  GeneralSectionComponentProps,
} from './GeneralSection.tsx'
export type { SettingsDocumentActionInjected, SettingsDocumentActionProps } from './SettingsDocumentAction.tsx'
export type { SettingsDocumentState } from './settings-document-store.ts'
export { SettingsDocumentStore } from './settings-document-store.ts'
export type { SettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Shell chrome + shell-owned General section copy. */
    settings: SettingsKey
  }
}

/** Dictionary namespace owned by this plugin (shell chrome + General copy). */
const NS = 'settings'

/**
 * Required services (cordis fiber inject). The target slots are declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; registrations depend on their slots through `slots.inject()`.
 */
export const inject = ['slots', 'locale', 'connection', 'remote', 'remote.settings', 'configForms', 'shortcuts']

/**
 * Register the `settings` dictionaries, the chrome content, and the General
 * section, each once its slot declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item', id: 'developer-tools', order: 15, locale: NS,
    inject: (): DeveloperToolsRowInjected => ({
      hooks: { developerTools: ctx.configForms.developerTools.enabled },
      setEnabled: enabled => ctx.configForms.developerTools.setEnabled(enabled),
    }),
  }, DeveloperToolsRow))
  // Last row: every feature-registered preference row orders below 100.
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item', id: 'current-version', order: 100, locale: NS,
  }, CurrentVersionRow))
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-general: dictionaries')
  const connection = ctx.get('connection') as ConnectionHandle
  const carrier = (globalThis as typeof globalThis & { dshDesktop?: { protocolVersion: number; updates?: DesktopUpdateBridge } }).dshDesktop
  const desktopUpdate = new DesktopUpdateSource(carrier?.protocolVersion === 1 ? carrier.updates : undefined)
  ctx.effect(() => () => { desktopUpdate.dispose() }, 'ui-settings-general: desktop update carrier')
  ctx.slots.inject('sidebar.toggle.badge', () => ctx.slots.register({
    name: 'sidebar.toggle.badge', locale: NS,
    inject: () => ({ hooks: { desktopUpdate: desktopUpdate.store, connectionState: connection.state } }),
  }, DesktopUpdateBadge))

  // Copy freshness is framework-owned: components read the standard `t`
  // seat, and the nav label is a thunk the owner resolves per render — no
  // locale/change re-registration wiring.
  const t = ctx.locale.bind(NS)
  // The shared ConfigForm mirror updates after document commits and reconnects.
  const documentController = ctx.remote.$host.isLoopback
    ? new SettingsDocumentStore(ctx, ctx.configForms.describe())
    : undefined
  const documentInjected = documentController === undefined
    ? undefined
    : (): SettingsDocumentActionInjected => ({
      controller: documentController,
      hooks: { snapshot: documentController.store },
    })
  ctx.effect(() => () => { documentController?.dispose() }, 'ui-settings-general: document action directory')
  // The settings shell: this package occupies the sidebar-owned hole and
  // declares the settings slots. Ledger → nav-row projection as an observable
  // source (uSES contract: getSnapshot returns the cached rows until the
  // ledger version moves). Labels may be locale-following thunks, so the cache
  // key includes the locale revision and subscribers ride both sources.
  let rowsVersion = -1
  let rowsRevision = -1
  let rows: readonly SettingsSectionRow[] = []
  let onboardingVersion = -1
  let onboardingSteps: readonly SettingsOnboardingStep[] = []
  const shellInjected = (): SettingsRootInjected => ({
    openDesktopUpdate: () => { desktopUpdate.open() },
    reconnect: () => { connection.reconnect() },
    hooks: {
      shortcuts: ctx.shortcuts.catalog,
      desktopUpdate: desktopUpdate.store,
      connectionState: connection.state,
      sections: {
        getSnapshot: () => {
          const version = ctx.slots.getVersion('settings.section')
          const revision = ctx.locale.getSnapshot().revision
          if (version !== rowsVersion || revision !== rowsRevision) {
            rowsVersion = version
            rowsRevision = revision
            rows = ctx.slots.entries('settings.section')
              .map(e => ({
                /* v8 ignore next -- list-slot registration requires id (SlotCore rejects an entry without one) */
                id: e.options.id ?? '',
                order: e.options.order ?? 0,
                label: resolveSlotLabel(e.options.label) ?? '',
              }))
              .sort((a, b) => a.order - b.order)
          }
          return rows
        },
        subscribe: (listener) => {
          const offLedger = ctx.slots.subscribe('settings.section', listener)
          const offLocale = ctx.locale.subscribe(listener)
          return () => {
            offLedger()
            offLocale()
          }
        },
      },
      onboardingSteps: {
        getSnapshot: () => {
          const version = ctx.slots.getVersion('settings.onboarding')
          if (version !== onboardingVersion) {
            onboardingVersion = version
            onboardingSteps = ctx.slots.entries('settings.onboarding')
              .map(e => ({
                /* v8 ignore next -- list-slot registration requires id */
                id: e.options.id ?? '',
                order: e.options.order ?? 0,
              }))
              .sort((a, b) => a.order - b.order)
          }
          return onboardingSteps
        },
        subscribe: listener => ctx.slots.subscribe('settings.onboarding', listener),
      },
    },
  })
  ctx.slots.inject('sidebar.settings', () => {
    const shellHandle = createSettingsShellStore()
    const shellInstance = shellHandle.create()
    const shellStore: typeof shellHandle = { ...shellHandle, create: () => shellInstance }
    const disposeCommand = ctx.shortcuts.register({
      id: 'settings.open' as ShortcutCommandId, label: () => t('shortcut.open'), aliases: ['settings', 'preferences'],
      defaults: {
        'desktop:macos': { code: 'Comma', modifiers: ['primary'] },
        'desktop:windows': { code: 'Comma', modifiers: ['primary'] },
        'desktop:linux': { code: 'Comma', modifiers: ['primary'] },
        'web:macos': { code: 'Comma', modifiers: ['primary'] },
        'web:windows': { code: 'Comma', modifiers: ['primary'] },
      },
      regions: ['page', 'editable', 'terminal'], modals: ['settings'],
      resolve: ({ modal }) => {
        if (modal !== null && modal !== 'settings') return { status: 'blocked', reason: 'modal' }
        return { status: 'handled', run: () => {
          if (modal === 'settings') closeTopModal(document)
          else shellInstance.actions.open()
        } }
      },
    })

    const disposeSlot = ctx.slots.register({
      name: 'sidebar.settings',
      locale: NS,
      store: shellStore,
      children: {
        'settings.launcher': { kind: 'single', scope: 'root' },
        'settings.trigger': { kind: 'single', scope: 'root' },
        'settings.header': { kind: 'single', scope: 'root' },
        'settings.action': { kind: 'list', scope: 'root' },
        'settings.close': { kind: 'single', scope: 'root' },
        'settings.section': { kind: 'list', scope: 'root' },
        'settings.onboarding': { kind: 'list', scope: 'root' },
      },
      inject: shellInjected,
    }, SettingsRoot)
    return () => { disposeCommand(); disposeSlot() }
  })

  ctx.slots.inject('settings.trigger', () =>
    ctx.slots.register({ name: 'settings.trigger', locale: NS }, TriggerContent))
  ctx.slots.inject('settings.header', () =>
    ctx.slots.register({ name: 'settings.header', locale: NS }, HeaderContent))
  if (documentInjected !== undefined) {
    ctx.slots.inject('settings.action', () => ctx.slots.register({
      name: 'settings.action',
      id: 'open-document',
      order: 0,
      locale: NS,
      inject: documentInjected,
    }, SettingsDocumentAction))
  }
  ctx.slots.inject('settings.close', () =>
    ctx.slots.register({ name: 'settings.close', locale: NS }, CloseLabel))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'general',
    order: 0,
    label: () => t('general.nav'),
    locale: NS,
    children: { 'settings.general.item': { kind: 'list', scope: 'root' } },
  }, GeneralSection))
}
