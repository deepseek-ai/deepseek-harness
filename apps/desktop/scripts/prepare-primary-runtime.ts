/** Desktop resource locations and signing-aware verification for the shared runtime builder. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { preparePrimaryRuntime as preparePayload, smokePrimaryRuntime as smokePayload } from '../../../scripts/primary-runtime/prepare.ts'
import { parsePrimaryRuntime, workspaceDependencyPaths } from '../../../packages/skill/tool-workspace-dependencies/src/index.ts'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { scrubWindowsSigningEnvironment } from './windows-sign.mjs'

/**
 * Prepare Desktop resources for its selected packaging target.
 * @param options - Signed Windows packaging defers execution until its supervised signing stage.
 * @returns Resolves after preparation and, unless deferred, native-target execution checks.
 */
export async function preparePrimaryRuntime(options: { deferSmoke?: boolean } = {}): Promise<void> {
  const paths = resolveDesktopTargetBuildPaths()
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  await preparePayload({ target: resolveDesktopBuildTarget(), output: paths.runtime, cache: paths.downloads, version })
  if (!options.deferSmoke) smokePrimaryRuntime(join(paths.runtime, 'primary-runtime'))
}

/**
 * Verify Desktop's complete payload after preparation or platform signing.
 * @param root - Final payload directory, including any platform signatures.
 */
export function smokePrimaryRuntime(root: string): void {
  const manifest = parsePrimaryRuntime(JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8')))
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) return
  if (Object.keys(manifest.pythonPackages).length === 0) throw new Error('primary runtime: missing Python distribution versions; prepare the payload before running its smoke checks.')
  const entries = workspaceDependencyPaths(root, manifest)
  if (entries.node === undefined || entries.pnpm === undefined) throw new Error('primary runtime: the Desktop payload must declare node and pnpm components.')
  smokePayload(root, scrubWindowsSigningEnvironment(process.env))
}

if (import.meta.main) await preparePrimaryRuntime()
