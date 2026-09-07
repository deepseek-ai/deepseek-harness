import type { NotarizeOptions } from '@electron/notarize'
import type { MacOSSigningEnvironment } from './desktop-release-environment.mjs'

/** Completed electron-builder artifact needed for disk-image notarization. */
export interface DesktopBuildArtifact {
  readonly file: string
}

/**
 * Submit one generated DMG to Apple, staple its ticket, and verify Gatekeeper acceptance.
 * @param artifact - Completed electron-builder artifact.
 * @param env - Packaging environment.
 * @param expected - Public release identity.
 * @param submit - Notary submission implementation.
 * @param verify - Disk-image qualification implementation.
 */
export function notarizeMacOSDiskImageArtifact(
  artifact: DesktopBuildArtifact,
  env: NodeJS.ProcessEnv,
  expected: MacOSSigningEnvironment,
  submit?: (options: NotarizeOptions) => Promise<void>,
  verify?: (path: string, expected: MacOSSigningEnvironment) => void,
): Promise<void>
