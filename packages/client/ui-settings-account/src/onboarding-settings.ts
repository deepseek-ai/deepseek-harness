/** Device-local onboarding progress stored in the Host settings document. */
import z from '@deepseek-ai/schemastery'

/** Account feature's durable onboarding namespace. */
export const DESKTOP_ONBOARDING_NAMESPACE = 'ui-settings-account'

/** Persisted steps; a native top-up page leaves the durable step at credit. */
export type OnboardingStep = 'welcome' | 'credit' | 'purpose' | 'process' | 'done'
/** Work scenarios offered by the desktop introduction. */
export type OnboardingPurpose = 'office' | 'development' | 'both'
/** Work-detail mode applied to Chat when onboarding completes. */
export type OnboardingProcess = 'compact' | 'standard' | 'detailed'
/** One installation's resumable choices and terminal outcome. */
export interface OnboardingProgress {
  version: 1
  step: OnboardingStep
  purpose: OnboardingPurpose | null
  process: OnboardingProcess | null
  completion: 'completed' | 'skipped' | 'api-key' | null
  usage: 'compact' | 'detailed'
  developerTools: boolean
}

/** Host values may omit choices that have never been saved. */
export interface OnboardingSettings extends Omit<OnboardingProgress, 'purpose' | 'process' | 'completion'> {
  purpose?: OnboardingProgress['purpose']
  process?: OnboardingProgress['process']
  completion?: OnboardingProgress['completion']
}

/** Validated defaults for a fresh installation. */
export const OnboardingSettingsFields = {
  version: z.const(1).default(1),
  step: z.union(['welcome', 'credit', 'purpose', 'process', 'done']).default('welcome'),
  purpose: z.union(['office', 'development', 'both', z.const(null)]),
  process: z.union(['compact', 'standard', 'detailed', z.const(null)]),
  completion: z.union(['completed', 'skipped', 'api-key', z.const(null)]),
  usage: z.union(['compact', 'detailed']).default('compact'),
  developerTools: z.boolean().default(false),
}

/** Validated defaults for a fresh installation. */
export const OnboardingSettingsSchema: z<Partial<OnboardingSettings>, OnboardingSettings> = z.object(OnboardingSettingsFields)
