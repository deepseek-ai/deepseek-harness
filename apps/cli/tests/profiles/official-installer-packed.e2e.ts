/** Install actual packed Official providers through the ordinary manager in a source-independent Web process. */
import { existsSync, globSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import yaml from 'js-yaml'
import { expect, it, onTestFinished } from 'vitest'
import type { BundleInfo, ChangeResult } from '@deepseek-ai/dsh-plugin-manager'
import { getDshRuntimeVersion } from '../../../../packages/boot/app-boot/src/plugin-compatibility.ts'
import { generateOfficialBundleCatalog } from '../../../../scripts/gen-official-bundle-catalog.ts'
import {
  REGISTRY_MANIFEST_FILE,
  createRegistryManifest,
  hostPlatform,
  packBundleArtifacts,
  readReleaseMembers,
  readWorkspacePackages,
  selectBundleDependencies,
  sourceEvidence,
  startBundleRegistry,
  verifyBuiltBundles,
  writeRegistryManifest,
} from '../../../../scripts/local-bundle-registry.ts'
import { assertInstalledTree, createPackedInstallation } from './packed-installation.ts'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const packages = ['@deepseek-ai/dsh-subagent-claude-code', '@deepseek-ai/dsh-subagent-codex']
const built = existsSync(join(root, 'apps/cli/lib/bin.js'))
  && packages.every(name => existsSync(join(root, 'packages/subagent', name.slice('@deepseek-ai/dsh-'.length), 'lib/index.js')))

interface Observation {
  initial: BundleInfo[]
  sessionCount: number
  steps: Array<{
    name: string
    install: ChangeResult
    savedVersion: string
    installed: BundleInfo
    providerEnabled: boolean
    nativeArtifact: boolean
    localDependency: string
    presets: Array<{ id: string; broken?: string }>
    unavailable: ChangeResult
    unchangedAfterUnavailable: boolean
    off: ChangeResult
    disabled: BundleInfo
    on: ChangeResult
    enabled: BundleInfo
    removed: ChangeResult
    absent: BundleInfo
  }>
}

/**
 * Read the tail of the newest plugin-manager pnpm log, for a failure the child cannot report itself.
 * @param profile - isolated profile directory.
 * @returns The last log lines, or a marker when no run logged anything.
 */
function pnpmLogTail(profile: string): string {
  const logs = join(profile, '.plugin-manager', 'logs')
  const newest = existsSync(logs)
    ? readdirSync(logs, { withFileTypes: true }).filter(entry => entry.isDirectory())
      .map(entry => join(logs, entry.name, 'pnpm.log'))
      .filter(path => existsSync(path))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0]
    : undefined
  if (newest === undefined) return '--- plugin-manager log: none ---'
  return `--- ${newest} ---\n${readFileSync(newest, 'utf8').split('\n').slice(-40).join('\n')}`
}

it.skipIf(!built)('installs the exported registry\'s local closure and switches Official bundles through the generic manager', {
  // Real packing of two dependency closures, an isolated product installation, and an isolated plugin installation
  // own this budget; no native model request runs.
  timeout: 900_000,
  retry: 0,
}, async () => {
  // The product under test is a real source-independent installation that ships neither provider, so both stay
  // available to the Official catalog and only the local registry can supply them.
  const fixture = await createPackedInstallation('dsh-official-packed-', [])
  const { temporary, installation, home, profile, environment } = fixture

  // The registry packs and serves the catalog's own local dependency closure; no checkout link or file: override
  // stands in for a package the registry should answer.
  const entries = generateOfficialBundleCatalog(root).map(entry => entry.packageName)
  const workspace = readWorkspacePackages(root)
  verifyBuiltBundles({ entries, packages: workspace })
  const selection = selectBundleDependencies({ entries, packages: workspace, platform: hostPlatform() })
  const runDirectory = join(temporary, 'registry')
  const artifacts = await packBundleArtifacts({
    root, destination: runDirectory, members: selection.members, release: readReleaseMembers(root),
  })
  const version = artifacts.find(artifact => artifact.name === packages[0])?.version
  if (version === undefined) throw new Error('the local registry packed no claude-code provider')
  for (const name of packages) expect(artifacts.find(artifact => artifact.name === name), name).toMatchObject({ version })
  await writeRegistryManifest(join(runDirectory, REGISTRY_MANIFEST_FILE), createRegistryManifest({
    buildId: 'packed-e2e',
    source: sourceEvidence(root, getDshRuntimeVersion()),
    entries,
    workspaceNames: selection.workspaceNames,
    artifacts,
  }))
  const registry = await startBundleRegistry({
    directory: runDirectory, artifacts, workspaceNames: selection.workspaceNames,
  })
  onTestFinished(() => registry.close())

  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'packed-official-profile', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }))
  // Only the settings a real profile gets. No override, ignore list, or scoped .npmrc may route a package around the
  // registry, so every dependency of the packed bundles is answered by this run or by its fixed upstream redirect.
  await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  const userConfig = join(temporary, 'empty.npmrc')
  await writeFile(userConfig, '')
  environment.npm_config_userconfig = userConfig
  const observer = join(temporary, 'official-installer-observer.mjs')
  await writeFile(observer, await readFile(new URL('./fixtures/official-installer-observer.mjs', import.meta.url), 'utf8'))
  const patch = join(temporary, 'official-installer.patch.yml')
  await writeFile(patch, yaml.dump([{ insert: [{ id: 'official-installer-observer', name: observer,
    config: {
      registry: registry.url,
      profile,
      packages,
      localDependency: '@deepseek-ai/dsh-brand',
      nativePackages: {
        // The Agent SDK publishes a musl variant of its Linux artifact, which is what pnpm installs there.
        '@deepseek-ai/dsh-subagent-claude-code': `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${hostPlatform().libc?.[0] === 'musl' ? '-musl' : ''}`,
        '@deepseek-ai/dsh-subagent-codex': `@openai/codex-${process.platform}-${process.arch}`,
      },
    },
  }] }]))
  const child = execa(process.execPath, [join(installation, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
    'web', '--patch', patch, '--no-open', '--port', '0'], {
    cwd: temporary, env: environment, extendEnv: false, reject: false, timeout: 240_000,
  })
  if (child.stdout === null) throw new Error('installed Web process has no stdout')
  const lines = createInterface({ input: child.stdout })
  // A failure in the body must stay the reported one: teardown asserts only when the body
  // passed, so a Web process that does not exit cannot replace the real error.
  let failure: unknown
  try {
    const observed = await new Promise<Observation>((resolveObservation, reject) => {
      lines.on('line', (line) => {
        if (!line.startsWith('PACKED_OFFICIAL_RESULT=')) return
        const report = JSON.parse(line.slice('PACKED_OFFICIAL_RESULT='.length)) as { value?: Observation; error?: string }
        if (report.error !== undefined) reject(new Error(report.error))
        else if (report.value !== undefined) resolveObservation(report.value)
      })
      void child.then((result) => { reject(new Error(`Web process exited before observation:\n${result.stdout}\n${result.stderr}`)) })
    })
    for (const name of packages) expect(observed.initial.find(entry => entry.name === name)).toMatchObject({
      official: true, availability: 'missing', installed: false, enabled: false, installTarget: { spec: `${name}@${version}`, version },
    })
    expect(observed.steps).toHaveLength(packages.length)
    for (const step of observed.steps) {
      expect(step.install, JSON.stringify(step.install)).toMatchObject({ application: 'applied', enabled: true, version })
      expect(step.savedVersion).toBe(version)
      expect(step.installed).toMatchObject({ official: true, availability: 'profile', enabled: true, installed: true, version })
      const product = step.name.replace('@deepseek-ai/dsh-subagent-', '')
      expect(step.installed.rows.map(row => row.rowId)).toEqual([`subagent-${product}`, `tool-subagent-${product}`])
      expect(step.providerEnabled).toBe(true)
      expect(step.nativeArtifact).toBe(true)
      // A transitive repository package the closure needs can only have come from this run's artifacts.
      expect(step.localDependency).toBe(version)
      expect(step.presets.every(preset => preset.broken === undefined)).toBe(true)
      expect(step.unavailable).toMatchObject({ application: 'failed', stage: 'install' })
      expect(step.unchangedAfterUnavailable).toBe(true)
      expect(step.off).toMatchObject({ application: 'applied' })
      expect(step.disabled).toMatchObject({ official: true, installed: true, enabled: false })
      expect(step.on).toMatchObject({ application: 'applied' })
      expect(step.enabled).toMatchObject({ official: true, installed: true, enabled: true })
      expect(step.removed, JSON.stringify(step.removed)).toMatchObject({ application: 'applied' })
      expect(step.absent).toMatchObject({ official: true, availability: 'missing', enabled: false, installed: false })
    }
    expect(observed.sessionCount).toBe(0)
    expect(globSync('sessions/**/*.jsonl*', { cwd: home })).toEqual([])
    await assertInstalledTree(profile)
    // The completed run records every package it served, so a failure can be matched to the exact checkout.
    const record = JSON.parse(await readFile(join(runDirectory, REGISTRY_MANIFEST_FILE), 'utf8')) as { buildId: string; packages: unknown[] }
    expect(record.buildId).toBe('packed-e2e')
    expect(record.packages).toHaveLength(selection.members.length)
    expect(record.packages).toEqual(expect.arrayContaining([expect.objectContaining({ name: packages[0], version })]))
  } catch (error) {
    // The manager's own pnpm output names a stalled or refused operation, which the child's stdout cannot show.
    failure = error instanceof Error ? new Error(`${error.message}\n\n${pnpmLogTail(profile)}`) : error
  } finally {
    lines.close()
    child.kill('SIGTERM')
    const result = await child
    if (failure === undefined) {
      // The installed Web process stops on SIGTERM within its own budget; a timed-out child is a teardown defect.
      expect(result.timedOut, `${result.stdout}\n${result.stderr}`).toBe(false)
      expect(result.exitCode === 0 || result.signal === 'SIGTERM', result.stderr).toBe(true)
    }
  }
  if (failure !== undefined) throw failure
})
