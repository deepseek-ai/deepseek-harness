/** Notarize and qualify macOS disk images after electron-builder creates them. */

import { notarize } from '@electron/notarize'
import { rmSync } from 'node:fs'
import { resolveMacOSNotarizationEnvironment } from './desktop-release-environment.mjs'
import { verifyMacOSDiskImage } from './verify-macos-signature.mjs'

/**
 * Submit one generated DMG to Apple, staple its ticket, and verify Gatekeeper acceptance.
 * @param {{ file: string }} artifact - Completed electron-builder artifact.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {{ signingIdentity: string, teamId: string }} expected - Public release identity.
 * @param {(options: object) => Promise<void>} submit - Notary submission implementation.
 * @param {(path: string, expected: object) => void} verify - Disk-image qualification implementation.
 * @returns {Promise<void>}
 */
export async function notarizeMacOSDiskImageArtifact(
  artifact,
  env,
  expected,
  submit = notarize,
  verify = verifyMacOSDiskImage,
) {
  if (!artifact.file.endsWith('.dmg')) return
  rmSync(`${artifact.file}.blockmap`, { force: true })
  const credentials = resolveMacOSNotarizationEnvironment(env)
  await submit({ appPath: artifact.file, ...credentials })
  verify(artifact.file, expected)
  process.stdout.write(`desktop macOS notarization: verified disk image ${artifact.file}\n`)
}
