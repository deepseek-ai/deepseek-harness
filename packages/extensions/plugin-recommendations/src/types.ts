/** Fields, recorded data and catalog text of `enable_official_plugin` cards. */
import type { ManagementError } from '@deepseek-ai/dsh-plugin-manager/types'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'

/** Card fields the skill asks the model to write in `details`. */
export interface PluginDetails {
  /** Package name as written in the catalog; enabling checks it against the current catalog. */
  readonly name: string
}

/**
 * Phases a plugin card records besides the shared `dismissed`. `unconfirmed` marks an enable or installation whose
 * outcome an unload cut off; the next action that finds the plugin enabled, Not now included, records `enabled`, since
 * this card's own change landed.
 */
export type PluginPhase = 'enabled' | 'already-enabled' | 'failed' | 'unconfirmed'

/** Data each plugin decision records; profile files own the actual configuration. */
export interface PluginData {
  /** `restart-required` when the saved selection applies only after DSH restarts. */
  readonly application?: 'restart-required' | undefined
  /** Plugin manager error code of a failed change, or `operation-error` when the change was rejected; no diagnostic text is recorded. */
  readonly errorCode?: ManagementError['code'] | undefined
  /**
   * Install scripts awaiting the user's permission, as the profile's pnpm settings name them, recorded only when pnpm
   * stopped a connector installation on them (package failure kind `build-blocked`); the card's `approve` allows
   * exactly these. Any other failure records none, because the plugin manager lists every undecided script in the
   * profile after any failed run. The status notice omits them.
   */
  readonly pendingBuilds?: string[] | undefined
}

/**
 * The card's text, read when it is displayed: catalog text of an eligible plugin or an installed official connector,
 * or `installable` with the text, in every shipped language, that the connector catalog of
 * `@deepseek-ai/dsh-official-bundles` holds for an official connector the profile does not hold, which has no plugin
 * manager listing or details page yet; any other name gets a refusal.
 */
export type RecommendationDetails =
  | {
    readonly status: 'available'
    readonly title: LocalizedText
    readonly description: LocalizedText
    readonly enabled: boolean
    /** Present for an official connector, whose account the user connects on its Plugins page. */
    readonly connector?: true
  }
  | { readonly status: 'installable'; readonly title: LocalizedText; readonly description: LocalizedText }
  | { readonly status: 'refused'; readonly reason: 'unknown' | 'unavailable' | 'not-live-root' | 'closing' }
