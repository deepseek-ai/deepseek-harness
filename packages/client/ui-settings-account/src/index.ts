/** Host configuration for the account settings client. */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import { type ContactConfig, ContactConfigFields, CONTACT_CONFIG_GLOBAL } from './contact-config.ts'
import z from '@deepseek-ai/schemastery'
import { OnboardingSettingsFields, type OnboardingStep, type OnboardingPurpose, type OnboardingProcess } from './onboarding-settings.ts'
/** Public contact options and live device-local onboarding progress. */
export interface Config extends ContactConfig {
  /** Onboarding progress format version. */
  version: Volatile<1>
  /** Last accepted onboarding page. */
  step: Volatile<OnboardingStep>
  /** Selected work scenario. */
  purpose?: Volatile<OnboardingPurpose | null | undefined>
  /** Selected transcript detail. */
  process?: Volatile<OnboardingProcess | null | undefined>
  /** Completion reason, absent until completion. */
  completion?: Volatile<'completed' | 'skipped' | 'api-key' | null | undefined>
  /** Selected usage detail. */
  usage: Volatile<'compact' | 'detailed'>
  /** Selected developer-tool visibility. */
  developerTools: Volatile<boolean>
}

/** Configuration projected through the account plugin's shared form. */
export const Config = z.object({
  contactFormUrl: ContactConfigFields.contactFormUrl,
  contactSource: ContactConfigFields.contactSource,
  bonusAckRetryDelayMs: ContactConfigFields.bonusAckRetryDelayMs,
  bonusAckRetryMaxDelayMs: ContactConfigFields.bonusAckRetryMaxDelayMs,
  version: OnboardingSettingsFields.version.volatile(),
  step: OnboardingSettingsFields.step.volatile(),
  purpose: OnboardingSettingsFields.purpose.volatile(),
  process: OnboardingSettingsFields.process.volatile(),
  completion: OnboardingSettingsFields.completion.volatile(),
  usage: OnboardingSettingsFields.usage.volatile(),
  developerTools: OnboardingSettingsFields.developerTools.volatile(),
})

/**
 * Publish public questionnaire options before browser plugins activate.
 * @param ctx - Host context collecting page initialization data.
 * @param config - validated deployment options.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['settings'], (scope) => {
    scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber))
  })
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: CONTACT_CONFIG_GLOBAL, value: {
      contactFormUrl: config.contactFormUrl, contactSource: config.contactSource,
      bonusAckRetryDelayMs: config.bonusAckRetryDelayMs, bonusAckRetryMaxDelayMs: config.bonusAckRetryMaxDelayMs,
    } satisfies ContactConfig })
  })
}
