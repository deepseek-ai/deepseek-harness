/** Build the ZIP and DMG from separate signed application copies with overlapping notarization. */

import { execFile } from 'node:child_process'
import { mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { Arch, getArchSuffix } from 'electron-builder'
import { notarize } from '@electron/notarize'
import {
  resolveMacOSNotarizationEnvironment,
  resolveMacOSSigningEnvironment,
} from './desktop-release-environment.mjs'
import { desktopUpdateMetadataFilename } from './desktop-auto-update-environment.mjs'
import { verifyMacOSNotarizedApplication, verifyMacOSSignature } from './verify-macos-signature.mjs'

const execute = promisify(execFile)

/** One electron-builder artifact made from an already signed application. */
export interface DesktopPrepackagedArtifact {
  readonly format: 'dmg' | 'zip'
  readonly appPath: string
  readonly output: string
}

/** A signed macOS directory build and its final release destination. */
export interface MacOSArtifactRequest {
  readonly arch: 'arm64' | 'x64'
  readonly version: string
  readonly artifactsRoot: string
  readonly environment: NodeJS.ProcessEnv
}

/** Apple-tool operations replaced by deterministic fixtures in orchestration tests. */
export interface MacOSArtifactOperations {
  readonly copyApp: (source: string, destination: string) => Promise<void>
  readonly notarize: (options: ReturnType<typeof resolveMacOSNotarizationEnvironment> & { appPath: string }) => Promise<void>
  readonly verifySignature: typeof verifyMacOSSignature
  readonly verifyNotarization: typeof verifyMacOSNotarizedApplication
}

const operations: MacOSArtifactOperations = {
  async copyApp(source, destination) {
    await execute('/usr/bin/ditto', [source, destination])
  },
  notarize,
  verifySignature: verifyMacOSSignature,
  verifyNotarization: verifyMacOSNotarizedApplication,
}

async function timed(label: string, action: () => Promise<void>): Promise<void> {
  const start = performance.now()
  process.stdout.write(`desktop macOS packaging: ${label} started at ${new Date().toISOString()}\n`)
  await action()
  process.stdout.write(`desktop macOS packaging: ${label} completed in ${((performance.now() - start) / 1000).toFixed(2)}s\n`)
}

/**
 * Notarize independent App/DMG copies concurrently, then promote their completed artifacts.
 * Both lanes settle before cleanup or rejection. The ZIP contains a stapled App; the DMG
 * carries its own ticket and encloses the signed App without an individually stapled ticket.
 * @param request - Signed directory build, release version, architecture, and credentials.
 * @param build - Runs electron-builder with publishing disabled; resolves only after its DMG
 * notarization and verification hook succeeds, and rejects on build or hook failure.
 * @param apple - Apple signing, copying, and notarization operations.
 * @returns Resolves after both qualified payloads, ZIP metadata, and the stapled App are in the final directory.
 */
export async function packageMacOSArtifacts(
  request: MacOSArtifactRequest,
  build: (artifact: DesktopPrepackagedArtifact) => Promise<void>,
  apple: MacOSArtifactOperations = operations,
): Promise<void> {
  const { arch, version, artifactsRoot, environment } = request
  const expected = resolveMacOSSigningEnvironment(environment)
  const credentials = resolveMacOSNotarizationEnvironment(environment)
  const appPath = join(artifactsRoot, `mac${getArchSuffix(Arch[arch])}`, 'DeepSeek Harness.app')
  const root = await mkdtemp(join(dirname(artifactsRoot), 'notarization-'))
  const zipApp = join(root, 'zip', basename(appPath))
  const dmgApp = join(root, 'dmg', basename(appPath))
  const zipOutput = join(root, 'zip-artifacts')
  const dmgOutput = join(root, 'dmg-artifacts')
  try {
    await apple.copyApp(appPath, zipApp)
    await apple.copyApp(appPath, dmgApp)
    apple.verifySignature(zipApp, expected)
    apple.verifySignature(dmgApp, expected)
    const results = await Promise.allSettled([
      timed('App notarization and ZIP', async () => {
        await apple.notarize({ appPath: zipApp, ...credentials })
        apple.verifyNotarization(zipApp, expected)
        await build({ format: 'zip', appPath: zipApp, output: zipOutput })
      }),
      timed('DMG creation and notarization', async () => {
        await build({ format: 'dmg', appPath: dmgApp, output: dmgOutput })
      }),
    ])
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length > 0) {
      throw new AggregateError(failures.map(result => result.reason), 'desktop macOS packaging: artifact lanes failed')
    }
    const base = `deepseek-harness-${version}-mac-${arch}`
    const artifacts = [
      [dmgOutput, `${base}.dmg`],
      [zipOutput, `${base}.zip`],
      [zipOutput, `${base}.zip.blockmap`],
      [zipOutput, desktopUpdateMetadataFilename(version, 'darwin')],
    ] as const
    for (const [output, filename] of artifacts) {
      const file = join(output, filename)
      const details = await stat(file)
      if (!details.isFile() || details.size === 0) {
        throw new Error(`desktop macOS packaging: missing or empty artifact ${file}`)
      }
    }
    for (const [output, filename] of artifacts) {
      await rename(join(output, filename), join(artifactsRoot, filename))
    }
    await rm(appPath, { recursive: true })
    await rename(zipApp, appPath)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
