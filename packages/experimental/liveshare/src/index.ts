/**
 * Owner-side Liveshare Web bundle plugin.
 * @module @deepseek-ai/dsh-experimental-liveshare
 */

export { apply, name, inject, type Config } from './host/share-host.ts'
export { LiveshareShares } from './host/share-remote.ts'
export {
  ViewerDeclarations,
  viewerDeclarationsOf,
  type ViewerDeclarationsSurface,
} from './host/viewer-declarations.ts'

import type { LiveshareShares } from './host/share-remote.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Owner share management served to the owner page over Typert Remote. */
    liveshareShares: LiveshareShares
  }
}
