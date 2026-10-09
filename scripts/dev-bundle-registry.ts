/**
 * Build, pack, and serve the Official on-demand bundles' local dependency
 * closure as a loopback registry, so a packaged test app can install them
 * before their release reaches npm.
 *
 * The run is a build/test utility, not a Harness application launcher: it
 * starts no agent and needs no credentials. It shares only the artifact
 * transport with the release path; packing, manifests, and validation stay with
 * the owners that already perform them.
 */

import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { execa } from 'execa'
import { getDshRuntimeVersion } from '../packages/boot/app-boot/src/plugin-compatibility.ts'
import { generateOfficialBundleCatalog } from './gen-official-bundle-catalog.ts'
import {
  REGISTRY_MANIFEST_FILE,
  REGISTRY_OUTPUT_ROOT,
  createRegistryManifest,
  hostPlatform,
  packBundleArtifacts,
  pnpmInvocationFor,
  readReleaseMembers,
  readWorkspacePackages,
  selectBundleDependencies,
  sourceEvidence,
  startBundleRegistry,
  verifyBuiltBundles,
  verifyReleaseVersions,
  writeRegistryManifest,
  type BundleArtifact,
} from './local-bundle-registry.ts'

/** The preparation step a signal stopped, so the failure is not reported as a command's. */
class Interrupted extends Error {
  /**
   * @param stage - the step that was running when the signal arrived.
   */
  constructor(readonly stage: string) {
    super(`interrupted during ${stage}`)
  }
}

/**
 * Run one package script in the repository root, propagating its exit status.
 * @param root - repository root the command runs in.
 * @param args - pnpm arguments.
 * @param signal - abort signal that stops the child on SIGINT/SIGTERM.
 * @param label - step name used in the failure message.
 */
async function runStep(root: string, args: readonly string[], signal: AbortSignal, label: string): Promise<void> {
  const invocation = pnpmInvocationFor(args)
  let result
  try {
    result = await execa(invocation.command, invocation.args, {
      cwd: root, stdio: 'inherit', reject: false, killDescendants: true, cancelSignal: signal,
    })
  } catch (error) {
    if (signal.aborted) throw new Interrupted(label)
    throw error
  }
  if (result.isCanceled || signal.aborted) throw new Interrupted(label)
  if (result.exitCode !== 0) throw new Error(`${label} exited with ${String(result.exitCode ?? result.signal)}`)
}

/**
 * Print the installation summary the developer copies from.
 * Only the catalog roots are installable specs; the rest of the closure is a
 * dependency the installer resolves itself and stays in the run manifest.
 * @param options - run directory, registry URL, catalog roots, packed artifacts, source evidence.
 */
function printSummary(options: {
  readonly directory: string
  readonly url: string
  readonly entries: readonly string[]
  readonly artifacts: readonly BundleArtifact[]
  readonly source: ReturnType<typeof sourceEvidence>
}): void {
  const roots = options.entries.flatMap(name => options.artifacts.filter(artifact => artifact.name === name))
  process.stdout.write(`Source: ${options.source.commit}${options.source.dirty ? ' (dirty worktree)' : ''}, DSH ${options.source.dshVersion}\n`)
  process.stdout.write(`Artifacts: ${options.directory}\n`)
  process.stdout.write(`Registry: ${options.url}\n`)
  process.stdout.write(`Packages (${String(options.artifacts.length)} archives served):\n`)
  for (const artifact of roots) process.stdout.write(`  ${artifact.name}@${artifact.version}\n`)
  process.stdout.write('In Plugins > Add plugin, use an exact package above and this custom registry URL.\n')
  process.stdout.write('Keep this process running during package operations. Ctrl+C stops the registry.\n')
}

/** Build one run directory name: sortable by time and unique per invocation. */
function runId(): string {
  return `${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`
}

/** Build, pack, and serve the local bundle closure until a signal stops the run. */
async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, '..')
  const abort = new AbortController()
  // A persistent listener, so a second signal during shutdown cannot fall back to the default kill;
  // the second signal is an explicit forced exit instead.
  let stopping = false
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) {
      process.exit(130)
      return
    }
    stopping = true
    abort.abort(signal)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  let registry
  try {
    // 1. The catalog is the only root list; the inventory is how a local package is distinguished from an external one.
    const entries = generateOfficialBundleCatalog(root).map(entry => entry.packageName)
    const packages = readWorkspacePackages(root)
    const selection = selectBundleDependencies({ entries, packages, platform: hostPlatform() })
    const release = readReleaseMembers(root)
    verifyReleaseVersions(root)

    // 2. Current official artifacts, so the run never serves an earlier build.
    await runStep(root, ['run', 'build:official'], abort.signal, 'build:official')
    verifyBuiltBundles({ entries, packages })

    // 3. One immutable, run-owned directory; a later run never overwrites these bytes.
    const buildId = runId()
    const directory = join(root, REGISTRY_OUTPUT_ROOT, buildId)
    mkdirSync(directory, { recursive: true })
    const artifacts = await packBundleArtifacts({
      root, destination: directory, members: selection.members, release, signal: abort.signal,
    })

    // 4. The manifest is the completion marker: only a fully packed run has one.
    const source = sourceEvidence(root, getDshRuntimeVersion())
    const manifest = createRegistryManifest({
      buildId, source, entries, workspaceNames: selection.workspaceNames, artifacts,
    })
    await writeRegistryManifest(join(directory, REGISTRY_MANIFEST_FILE), manifest)

    // 5. Serve, then announce: the summary is never printed for a registry that did not listen.
    registry = await startBundleRegistry({
      directory, artifacts, workspaceNames: selection.workspaceNames,
    })
    printSummary({ directory, url: registry.url, entries, artifacts, source })
    await new Promise<void>((resolveStop) => {
      if (abort.signal.aborted) resolveStop()
      else abort.signal.addEventListener('abort', () => { resolveStop() }, { once: true })
    })
    await registry.close()
    registry = undefined
    process.stdout.write('Registry stopped. Artifacts and installed packages stay on disk.\n')
  } catch (error) {
    if (registry !== undefined) await registry.close()
    // A signal that stopped packing or packing's child is the same stop as a stopped build step.
    if (error instanceof Interrupted || abort.signal.aborted) {
      const stage = error instanceof Interrupted ? error.message : 'interrupted during preparation'
      process.stderr.write(`dev:bundle-registry: ${stage}\n`)
      process.exitCode = 130
      return
    }
    throw error
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

await main()
