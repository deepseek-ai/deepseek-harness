/**
 * Settings shell and ownerless-copy plugin, browser half: renders the
 * `sidebar.settings` occupant — panel chrome, section navigation, and the
 * onboarding stage — and registers everything on the Settings pages that
 * belongs to no single feature: the trigger/header chrome content,
 * local-document action, General section, `settings` dictionaries, and the
 * Host release change confirmation.
 * Feature-owned rows and sections stay with their features.
 * Export discipline: packages/client/AGENTS.md.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the remoteAccess service merge (ctx.remoteAccess).
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
// Type-only: pulls the ctx.remote merge and its fixed Host facts.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the ctx.modules merge.
import type {} from '@deepseek-ai/dsh-client-modules/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { closeTopModal } from '@deepseek-ai/dsh-client-ui-primitives/client'
// Type-only: the settings slot declarations plus the ctx.configForms Context
// merge. Cross-plugin collaboration goes through the service, never a value
// import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls ctx.locale into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-product-analytics/client'
import type {
  SettingsOnboardingStep, SettingsRootInjected, SettingsSectionRow,
} from './shell-contract.ts'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import { compareGroupOrder } from './group-order.ts'
import { createSettingsShellStore } from './shell-store.ts'
import { SettingsRoot } from './SettingsRoot.tsx'
import { DesktopUpdateBadge } from './DesktopUpdateIndicator.tsx'
import type { DesktopUpdateBridge } from '../types.ts'
import { DesktopChannelSource, type DesktopChannelSnapshot } from './desktop-channel-source.ts'
import { DesktopChannelRow, DesktopChannelToast } from './DesktopChannelRow.tsx'
import { DesktopUpdateSource } from './desktop-update-source.ts'
import { CloseLabel, HeaderContent, TriggerContent } from './chrome.tsx'
import { GeneralSection, type GeneralSectionInjected } from './GeneralSection.tsx'
import { SettingsSectionView } from './SettingsSectionView.tsx'
import { GeneralGroup, DisplayGroup, InteractionGroup, NotificationsGroup, DataGroup, UpdatesGroup } from './GeneralGroup.tsx'
import { CurrentVersionRow, type CurrentVersionRowInjected } from './CurrentVersionRow.tsx'
import { DeveloperToolsRow, type DeveloperToolsRowInjected } from './DeveloperToolsRow.tsx'
import { SettingsDocumentAction } from './SettingsDocumentAction.tsx'
import type { SettingsDocumentActionInjected } from './SettingsDocumentAction.tsx'
import { SettingsDocumentStore } from './settings-document-store.ts'
import { HostReleasePrompt, type HostReleasePromptInjected } from './HostReleasePrompt.tsx'
import { en, ja, es, fr, de, ru, pt, zh, type SettingsKey } from './locales.ts'

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

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
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
export const inject = ['slots', 'locale', 'connection', 'remote', 'remote.settings', 'configForms', 'shortcuts', 'modules', 'remoteAccess']

/**
 * Register the `settings` dictionaries, the chrome content, and the General
 * section, each once its slot declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.general.group.display.item', () => ctx.slots.register({
    name: 'settings.general.group.display.item', id: 'developer-tools', order: 15, locale: NS,
    inject: (): DeveloperToolsRowInjected => ({
      hooks: { developerTools: ctx.configForms.developerTools.enabled },
      setEnabled: async (enabled) => {
        const settings = ctx.configForms.get<{ enabled: boolean }>('ui-settings')
        const previous = settings.getSnapshot().value?.enabled
        const timestamp = Date.now()
        await ctx.configForms.developerTools.setEnabled(enabled)
        if (previous !== undefined && previous !== enabled && settings.getSnapshot().value?.enabled === enabled) {
          ctx.get('productAnalytics')?.track('code_work_view_toggle', { is_enabled: enabled }, timestamp)
        }
      },
    }),
  }, DeveloperToolsRow))
  // Version information follows the core preferences; Desktop binds hidden 5-click channel unlock.
  const inactiveChannel = createSnapshotStore<DesktopChannelSnapshot>({ failed: false })
  let channel: DesktopChannelSource | undefined
  ctx.slots.inject('settings.general.group.updates.item', () => ctx.slots.register({
    name: 'settings.general.group.updates.item',
    id: 'current-version',
    order: 101,
    locale: NS,
    inject: (): CurrentVersionRowInjected => {
      const desktopChannel = channel
      return {
        hooks: { channel: desktopChannel?.store ?? inactiveChannel },
        ...(desktopChannel === undefined ? {} : { unlock: () => desktopChannel.select('nightly') }),
      }
    },
  }, CurrentVersionRow))
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-settings-general: dictionaries')
  const connection = ctx.get('connection') as ConnectionHandle
  const carrier = (globalThis as typeof globalThis & { dshDesktop?: { protocolVersion: number; updates?: DesktopUpdateBridge } }).dshDesktop
  const desktopUpdate = new DesktopUpdateSource(carrier?.protocolVersion === 1 ? carrier.updates : undefined)
  ctx.effect(() => () => { desktopUpdate.dispose() }, 'ui-settings-general: desktop update carrier')
  const channelBridge = carrier?.protocolVersion === 1 ? carrier.updates?.channels : undefined
  if (channelBridge !== undefined) {
    const desktopChannel = new DesktopChannelSource(channelBridge)
    channel = desktopChannel
    ctx.effect(() => () => { desktopChannel.dispose() }, 'ui-settings-general: desktop channel')
    ctx.slots.inject('settings.general.group.updates.item', () => ctx.slots.register({
      name: 'settings.general.group.updates.item', id: 'desktop-update-channel', order: 100, locale: NS,
      inject: () => ({ hooks: { channel: desktopChannel.store }, select: (value: 'nightly' | 'stable') => desktopChannel.select(value) }),
    }, DesktopChannelRow))
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: 'desktop-channel-toast', locale: NS,
      inject: () => ({ hooks: { channel: desktopChannel.store },
        dismiss: (sequence: number) => { desktopChannel.dismissNotice(sequence) }, openConfiguration: () => { desktopUpdate.open() } }),
    }, DesktopChannelToast))
  }

  ctx.slots.inject('sidebar.toggle.badge', () => ctx.slots.register({
    name: 'sidebar.toggle.badge', locale: NS,
    inject: () => ({ hooks: { desktopUpdate: desktopUpdate.store, connectionState: connection.state } }),
  }, DesktopUpdateBadge))

  // Copy freshness is framework-owned: components read the standard `t`
  // seat, and the nav label is a thunk the owner resolves per render — no
  // locale/change re-registration wiring.
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.general.group', () => ctx.slots.register({
    name: 'settings.general.group', id: 'general', order: 10,
    label: () => t('general.group.general'),
    children: { 'settings.general.item': { kind: 'list', scope: 'root' } },
  }, GeneralGroup))
  ctx.slots.inject('settings.general.group', () => ctx.slots.register({
    name: 'settings.general.group', id: 'display', order: 20,
    label: () => t('general.group.display'),
    children: { 'settings.general.group.display.item': { kind: 'list', scope: 'root' } },
  }, DisplayGroup))
  ctx.slots.inject('settings.general.group', () => ctx.slots.register({
    name: 'settings.general.group', id: 'interaction', order: 30,
    label: () => t('general.group.interaction'),
    children: { 'settings.general.group.interaction.item': { kind: 'list', scope: 'root' } },
  }, InteractionGroup))
  ctx.slots.inject('settings.general.group', () => ctx.slots.register({
    name: 'settings.general.group', id: 'notifications', order: 40,
    label: () => t('general.group.notifications'),
    children: { 'settings.general.group.notifications.item': { kind: 'list', scope: 'root' } },
  }, NotificationsGroup))
  ctx.slots.inject('settings.general.group', () => ctx.slots.register({
    name: 'settings.general.group', id: 'data', order: 50,
    label: () => t('general.group.data'),
    children: { 'settings.general.group.data.item': { kind: 'list', scope: 'root' } },
  }, DataGroup))
  ctx.slots.inject('settings.general.group', () => ctx.slots.register({
    name: 'settings.general.group', id: 'updates', order: 60,
    label: () => t('general.group.updates'),
    children: { 'settings.general.group.updates.item': { kind: 'list', scope: 'root' } },
  }, UpdatesGroup))
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
  // The settings shell reads this host's configuration, so it follows access to its description.
  ctx.remoteAccess.whenAccess('settings/describe', () =>
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
          'web:macos': { code: 'Comma', modifiers: ['primary', 'alt'] },
          'web:windows': { code: 'Comma', modifiers: ['primary', 'alt'] },
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
          'settings.notice': { kind: 'single', scope: 'root' },
          'settings.trigger': { kind: 'single', scope: 'root' },
          'settings.header': { kind: 'single', scope: 'root' },
          'settings.action': { kind: 'list', scope: 'root' },
          'settings.close': { kind: 'single', scope: 'root' },
          'settings.section.icon': { kind: 'list', scope: 'root', inline: true },
          'settings.onboarding': { kind: 'list', scope: 'root' },
        },
        inject: shellInjected,
      }, SettingsRoot)
      return () => { disposeCommand(); disposeSlot() }
    }))

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
  // Every surface that shows a settings page renders it through this Factory, which declares `settings.section`.
  ctx.slots.registerFactory({
    name: 'settings.section.view', scope: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  }, SettingsSectionView)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'general',
    order: 0,
    label: () => t('general.nav'),
    locale: NS,
    children: { 'settings.general.group': { kind: 'list', scope: 'root' } },
    inject: (): GeneralSectionInjected => {
      const slots = ctx.slots
      const locale = ctx.locale
      let version = -1
      let revision = -1
      let groups: readonly { id: string; label: string }[] = []
      return { hooks: { groups: {
        getSnapshot: () => {
          const nextVersion = slots.getVersion('settings.general.group')
          const nextRevision = locale.getSnapshot().revision
          if (version !== nextVersion || revision !== nextRevision) {
            version = nextVersion
            revision = nextRevision
            groups = slots.entriesOfSlot('settings.general.group')
              .toSorted(compareGroupOrder)
              .map(entry => ({
                /* v8 ignore next -- list registrations require an id */
                id: entry.options.id ?? '',
                label: resolveSlotLabel(entry.options.label) ?? '',
              }))
          }
          return groups
        },
        subscribe: (listener) => {
          const offGroups = slots.subscribe('settings.general.group', listener)
          const offLocale = locale.subscribe(listener)
          return () => { offGroups(); offLocale() }
        },
      } } }
    },
  }, GeneralSection))
  // The page's module system applies no plugin update from another Host release; this dialog offers the reload.
  const releasePromptInjected = (): HostReleasePromptInjected => ({
    dismissRelease: () => { ctx.modules.entries.dismissRelease() },
    reloadPage: () => { globalThis.location.reload() },
    hooks: { releaseChange: ctx.modules.entries.releaseChange },
  })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'host-release-change', locale: NS, inject: releasePromptInjected,
  }, HostReleasePrompt))
}
