/** Fields, recorded data and catalog text of `enable_official_plugin` cards. */
import type { ManagementError } from '@deepseek-ai/dsh-plugin-manager/types'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'

/** Card fields the skill asks the model to write in `details`. */
export interface PluginDetails {
  /** Package name as written in the catalog; enabling checks it against the current catalog. */
  readonly name: string
}

/**
 * Phases a plugin card records besides the shared `dismissed`. `unconfirmed` marks an enable whose outcome an unload
 * cut off; the next action that finds the plugin enabled, Not now included, records `enabled`, since this card's own
 * change landed.
 */
export type PluginPhase = 'enabled' | 'already-enabled' | 'failed' | 'unconfirmed'

/** Data each plugin decision records; profile files own the actual configuration. */
export interface PluginData {
  /** `restart-required` when the saved selection applies only after DSH restarts. */
  readonly application?: 'restart-required' | undefined
  /** Plugin manager error code of a failed change, or `operation-error` when the change was rejected; no diagnostic text is recorded. */
  readonly errorCode?: ManagementError['code'] | undefined
}

/** Catalog text for a card, read when it is displayed; a name outside the eligible catalog gets no card text. */
export type RecommendationDetails =
  | { readonly status: 'available'; readonly title: LocalizedText; readonly description: LocalizedText; readonly enabled: boolean }
  | { readonly status: 'refused'; readonly reason: 'unknown' | 'unavailable' | 'not-live-root' | 'closing' }
