/**
 * Models settings and product-onboarding plugin, browser half. It registers
 * the Models page plus the ordered internal-testing and official-DeepSeek
 * onboarding dialogs, whose UI shares this package's modal wrapper. The Host
 * settings and credential contracts stay behind their existing wire APIs.
 * Export discipline:
 * packages/client/AGENTS.md.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the ctx.remote merge and the forwarded-event key face
// (settings/credentials invalidations ride the allowlist) into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { ModelsSection } from './ModelsSection.tsx'
import type { ModelsSectionInjected } from './ModelsSection.tsx'
import { DeepSeekOnboardingDialog } from './DeepSeekOnboardingDialog.tsx'
import type { DeepSeekOnboardingInjected } from './DeepSeekOnboardingDialog.tsx'
import { WelcomeNotice } from './WelcomeNotice.tsx'
import type { WelcomeNoticeInjected } from './WelcomeNotice.tsx'
import { WelcomeNoticeStore } from './welcome-store.ts'
import { ModelsSettingsStore } from './store.ts'
import { createModelsOperations } from './operations.ts'
import { createSettingsSchemaOperations } from './schema-operations.ts'
import { en, zh, type ModelsKey } from './locales.ts'
import { WELCOME_NOTICE_SETTINGS_NAMESPACE } from '../onboarding-copy.ts'
import { Config, ONBOARDING_CONFIG_GLOBAL } from '../onboarding-config.ts'

export type { ModelsSectionInjected, ModelsSectionProps } from './ModelsSection.tsx'
export type { ModelsFooterOwnerProps, ProviderCardExtrasOwnerProps } from './slot-contract.ts'
export type { ModelsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Models page + product-onboarding copy. */
    'settings.models': ModelsKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.models'

export type {
  ModelsSettingsState, ProviderDirectoryEntry, ProviderRow,
} from './store.ts'
export type { ModelDiscoveryOutcome, ModelsOperations, SettingsWriteOutcome } from './operations.ts'

/**
 * Refetch the page snapshot only after its first load: an unopened Models
 * page must not fetch on background invalidations.
 * @param controller - the page store.
 */
export function refreshIfLoaded(controller: ModelsSettingsStore): void {
  if (controller.store.getSnapshot().status === 'idle') return
  void controller.load()
}

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; registration depends on each slot through `slots.inject()`.
 */
export const inject = [
  'slots', 'locale', 'remote', 'remote.credentials', 'remote.llm', 'remote.settings', 'remote.session',
  'configForms', 'settingsSchema',
]

/**
 * Register the Models section once the `settings.section` declaration is on
 * the ledger, wire its store to the connection, and keep it fresh on every
 * pushed invalidation (settings, credentials, or provider topology).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const page = globalThis as Partial<Record<typeof ONBOARDING_CONFIG_GLOBAL, unknown>>
  const payload = page[ONBOARDING_CONFIG_GLOBAL]
  const configured = Config(payload === undefined ? {} : payload)
  const credentialOnboarding = configured.credentialOnboarding && !('dshDesktop' in globalThis)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-models: copy dictionaries')

  const schema = createSettingsSchemaOperations(ctx.settingsSchema)
  // Bound once here, where the Remote namespaces are declared in this plugin's
  // own `inject`; the cards receive callbacks and never a context.
  const operations = createModelsOperations(ctx)
  const controller = new ModelsSettingsStore(ctx, schema, ctx.configForms.describe())
  // Registration-time text (the nav label thunk) and the inject faces share
  // one bound translate; copy freshness rides the locale revision.
  const t = ctx.locale.bind(NS) as ModelsSectionInjected['t']
  const injected = (): ModelsSectionInjected => ({
    controller,
    hooks: { snapshot: controller.store },
    operations,
    schema,
    t,
  })
  const deepSeekOnboardingInjected = (): DeepSeekOnboardingInjected => ({
    automatic: credentialOnboarding,
    controller,
    hooks: { models: controller.store },
    operations,
    schema,
    t,
  })
  // The scope's own memory mode is what keeps a remote browser process-local,
  // so the store needs no isLoopback branch of its own.
  const welcomeController = new WelcomeNoticeStore(ctx.configForms.get<Record<string, unknown>>(WELCOME_NOTICE_SETTINGS_NAMESPACE))
  const welcomeInjected = (): WelcomeNoticeInjected => ({
    controller: welcomeController,
    hooks: { welcome: welcomeController.store },
    t,
  })

  // Pushed invalidations converge every open surface without polling. The
  // configForms injection makes ui-settings activate first, and remote
  // dispatch preserves listener order; its listener therefore starts the
  // mirror refresh before this store joins that refresh. The welcome notice
  // follows its settings scope, so it needs no subscription here.
  ctx.effect(() => {
    const refreshModels = (): void => { refreshIfLoaded(controller) }
    const disposers = [
      ctx.remote.$on('settings/document-updated', () => { refreshModels() }),
      ctx.remote.$on('credentials/record-updated', refreshModels),
      ctx.remote.$on('credentials/reference-updated', refreshModels),
      ctx.remote.$on('llm/adapters-updated', refreshModels),
      ctx.on('connection/reset', refreshModels),
    ]
    return () => {
      welcomeController.dispose()
      for (const dispose of disposers) dispose()
    }
  }, 'ui-settings-models: pushed invalidations')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'models',
    order: 10,
    label: () => t('nav'),
    inject: injected,
    children: {
      'settings.models.provider-card': { kind: 'keyed', scope: 'root' },
      'settings.models.footer': { kind: 'list', scope: 'root' },
    },
  }, ModelsSection))
  if (!('dshDesktop' in globalThis)) ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding',
    id: 'welcome-notice',
    order: -100,
    inject: welcomeInjected,
  }, WelcomeNotice))
  ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding',
    id: 'deepseek-official',
    children: { 'settings.models.sign-in': { kind: 'single', scope: 'root' } },
    order: 0,
    inject: deepSeekOnboardingInjected,
  }, DeepSeekOnboardingDialog))
}
