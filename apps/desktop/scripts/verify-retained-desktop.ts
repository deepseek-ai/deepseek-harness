/** Recheck distribution signatures on retained installers without signing credentials. */
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesktopRetainedManifest } from './desktop-release-store.ts'
import type { DesktopPublishConfig } from './desktop-publish-config.ts'
import { verifyMacOSDiskImage, verifyMacOSNotarizedApplication } from './verify-macos-signature.mjs'

/**
 * Verify Windows Authenticode or macOS DMG and archived app notarization on the original platform.
 * @param directory Retained attempt whose file hashes were already checked.
 * @param manifest Validated inventory and packaging mode.
 * @param config Public expected signer configuration.
 * @returns Resolves after platform verification; extracted ZIP contents are removed on all exits.
 */
export async function verifyRetainedDesktopSignatures(
  directory: string, manifest: DesktopRetainedManifest, config: DesktopPublishConfig,
): Promise<void> {
  const { source } = manifest
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/iu.test(key)))
  const run = (command: string, args: string[]) => execFileSync(command, args, { env, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })
  if (source.target === 'win-x64') {
    if (process.platform !== 'win32' || source.qualification !== 'signed' || !config.windows) throw new Error('desktop publish: signed Windows package and signer configuration required on Windows')
    const installer = manifest.files.find(file => file.name.endsWith('.exe'))
    if (!installer) throw new Error('desktop publish: installer missing')
    run('pwsh', ['-NoProfile', '-NonInteractive', '-File', join(import.meta.dirname, 'verify-published-windows.ps1'),
      '-Installer', join(directory, installer.name), '-Thumbprint', config.windows.certificateThumbprint])
    return
  }
  if (process.platform !== 'darwin' || source.qualification !== 'notarized' || !config.macOS) throw new Error('desktop publish: notarized package and signer configuration required on macOS')
  const dmg = manifest.files.find(file => file.name.endsWith('.dmg'))
  const zip = manifest.files.find(file => file.name.endsWith('.zip'))
  if (!dmg || !zip) throw new Error('desktop publish: DMG and ZIP are required')
  verifyMacOSDiskImage(join(directory, dmg.name), config.macOS)
  const zipPath = join(directory, zip.name)
  const listing = run('/usr/bin/unzip', ['-Z1', zipPath]).trim().split('\n')
  if (listing.some(name => name.startsWith('/') || name.includes('\\') || name.split('/').includes('..'))) throw new Error('desktop publish: unsafe ZIP path')
  const extracted = await mkdtemp(join(tmpdir(), 'desktop-publish-verify-'))
  try {
    run('/usr/bin/ditto', ['-x', '-k', zipPath, extracted])
    verifyMacOSNotarizedApplication(join(extracted, 'DeepSeek Harness.app'), config.macOS)
  } finally { await rm(extracted, { recursive: true, force: true }) }
}
