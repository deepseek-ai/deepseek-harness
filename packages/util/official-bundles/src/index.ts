/**
 * Installation-owned bundle lists and the plugin manager's protected and presented packages, kept apart from the code that applies them.
 * @module @deepseek-ai/dsh-official-bundles
 */

import type { DshBundleManifest, LocalizedText } from '@deepseek-ai/dsh-package-manifest'

export {
  CONNECTOR_BUNDLES, DEFAULT_PROFILE_BUNDLES, INSTALLATION_OWNED_PROFILE_TUPLES, ON_DEMAND_BUNDLES, OPTIONAL_BUNDLES,
  PROFILE_TEMPLATES, RETIRED_BUNDLES, type ProfileTemplate,
} from './bundles.ts'
export { DESKTOP_ONLY_BUNDLES, EXPERIMENTAL_BUNDLES, EXTENSION_BUNDLES, HIDDEN_BUNDLES, MORE_BUNDLES, PROTECTED_PLUGINS } from './plugin-manager.ts'

/** Offline discovery metadata; installation state and the requested version belong to the running host. */
export interface OfficialBundleCatalogEntry {
  /** Exact npm package name accepted by the existing bundle installer. */
  readonly packageName: string
  /** Package-owned Host platform declaration, available before installation. */
  readonly platforms?: DshBundleManifest['platforms']
  /**
   * Package-owned title and description, each keyed by language id with an entry for every shipped language, and a
   * self-contained icon, embedded without provider code.
   */
  readonly meta: {
    readonly title: Exclude<LocalizedText, string>
    readonly description: Exclude<LocalizedText, string>
    readonly icon: string
  }
}

export { OFFICIAL_CONNECTOR_CATALOG, OFFICIAL_ON_DEMAND_CATALOG } from './catalog.generated.ts'
