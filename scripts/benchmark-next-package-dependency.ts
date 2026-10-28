/** Benchmark which additional Host package most reduces npm peer resolution. */

import { availableParallelism } from 'node:os'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  benchmarkNpmResolution,
  buildRegistryIndex,
  parsePositiveIntegerOption,
  publishWorkspaceRange,
  type RegistryIndex,
} from './benchmark-npm-resolution.ts'
import {
  readPackageDependencyFacts,
  readPackageDependencyState,
  readWorkspacePackageManifests,
  repairPackageDependencyManifest,
  type PackageDependencyFacts,
  type WorkspacePackageManifest,
} from './verify-package-dependencies.ts'

const TARGET_PACKAGE = '@deepseek-ai/dsh'
const CORDIS = '@deepseek-ai/cordis'

interface Options {
  readonly candidates?: readonly string[]
  readonly coarseRuns: number
  readonly finalistRuns: number
  readonly finalists: number
  readonly jobs: number
  readonly timeoutMs: number
}

export interface MutableRegistryManifest {
  name: string
  version: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

interface Measurement {
  readonly package: string
  readonly seconds: readonly number[]
  readonly medianSeconds: number
}

/** Parse benchmark selection and repetition options. */
export function parseNextPackageBenchmarkOptions(args: readonly string[]): Options {
  const normalized = args[0] === '--' ? args.slice(1) : args
  const { values } = parseArgs({
    args: [...normalized],
    options: {
      candidates: { type: 'string' },
      runs: { type: 'string' },
      'finalist-runs': { type: 'string' },
      finalists: { type: 'string' },
      jobs: { type: 'string' },
      'timeout-ms': { type: 'string' },
    },
    allowPositionals: false,
  })
  return {
    ...(values.candidates === undefined
      ? {}
      : { candidates: values.candidates.split(',').filter(Boolean) }),
    coarseRuns: parsePositiveIntegerOption(values.runs, 1, '--runs'),
    finalistRuns: parsePositiveIntegerOption(values['finalist-runs'], 3, '--finalist-runs'),
    finalists: parsePositiveIntegerOption(values.finalists, 5, '--finalists'),
    jobs: parsePositiveIntegerOption(values.jobs, Math.min(8, availableParallelism()), '--jobs'),
    timeoutMs: parsePositiveIntegerOption(values['timeout-ms'], 120_000, '--timeout-ms'),
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0
}

function cloneIndex(index: RegistryIndex): Map<string, Map<string, MutableRegistryManifest>> {
  return new Map([...index].map(([name, versions]) => [
    name,
    new Map([...versions].map(([version, manifest]) => [
      version,
      structuredClone(manifest) as MutableRegistryManifest,
    ])),
  ]))
}

function publishedSection(
  values: Readonly<Record<string, string>> | undefined,
  workspaceVersions: ReadonlyMap<string, string>,
): Record<string, string> | undefined {
  if (values === undefined) return undefined
  return Object.fromEntries(Object.entries(values).map(([name, range]) => {
    const version = workspaceVersions.get(name)
    return [name, version === undefined ? range : publishWorkspaceRange(range, version)]
  }))
}

/** Apply one source-derived policy result to an in-memory registry manifest. */
export function applyFactsToRegistry(
  index: Map<string, Map<string, MutableRegistryManifest>>,
  facts: PackageDependencyFacts,
  workspaceVersions: ReadonlyMap<string, string>,
): void {
  const source = structuredClone(facts.manifest)
  repairPackageDependencyManifest({ ...facts, manifest: source })
  const version = workspaceVersions.get(source.name ?? '')
  const target = version === undefined ? undefined : index.get(source.name ?? '')?.get(version)
  if (target === undefined) throw new Error(`local registry has no ${source.name ?? 'unnamed package'}@${version ?? 'unknown'}`)
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    const values = publishedSection(source[field], workspaceVersions)
    if (values !== undefined) target[field] = values
    else if (field === 'dependencies') delete target.dependencies
    else if (field === 'optionalDependencies') delete target.optionalDependencies
    else delete target.peerDependencies
  }
  if (source.peerDependenciesMeta === undefined) delete target.peerDependenciesMeta
  else target.peerDependenciesMeta = structuredClone(source.peerDependenciesMeta) as Record<string, { optional?: boolean }>
}

function currentVersion(pkg: WorkspacePackageManifest): string {
  const version = pkg.manifest.version
  if (typeof version !== 'string') throw new Error(`${pkg.manifestPath}: missing package version`)
  return version
}

/** Find reachable Host candidates whose published manifests still carry non-Cordis peers. */
export function discoverBenchmarkCandidates(
  index: RegistryIndex,
  workspaceVersions: ReadonlyMap<string, string>,
  releasePackages: ReadonlyMap<string, WorkspacePackageManifest>,
  policyPackages: ReadonlySet<string>,
): string[] {
  const reached = new Set<string>()
  const queue = [TARGET_PACKAGE]
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const name = queue[cursor]
    if (name === undefined || reached.has(name)) continue
    const version = workspaceVersions.get(name)
    const manifest = version === undefined ? undefined : index.get(name)?.get(version)
    if (manifest === undefined) continue
    reached.add(name)
    const installed = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...Object.fromEntries(Object.entries(manifest.peerDependencies ?? {})
        .filter(([peer]) => (manifest.peerDependenciesMeta?.[peer] as { optional?: boolean } | undefined)?.optional !== true)),
    }
    for (const dependency of Object.keys(installed).sort()) {
      if (!reached.has(dependency)) queue.push(dependency)
    }
  }
  return [...reached].filter((name) => {
    if (policyPackages.has(name) || !releasePackages.has(name)) return false
    const version = workspaceVersions.get(name)
    const manifest = version === undefined ? undefined : index.get(name)?.get(version)
    return Object.keys(manifest?.peerDependencies ?? {}).some(peer => peer !== CORDIS)
  }).sort()
}

async function measure(
  index: RegistryIndex,
  targetVersion: string,
  runs: number,
  timeoutMs: number,
): Promise<number[]> {
  const seconds: number[] = []
  for (let run = 0; run < runs; run += 1) {
    const result = await benchmarkNpmResolution(index, targetVersion, timeoutMs)
    if (result.archiveRequests > 0) throw new Error('metadata-only benchmark requested package archives')
    seconds.push(Number((result.durationMs / 1000).toFixed(2)))
  }
  return seconds
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  jobs: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(jobs, values.length) }, async () => {
    while (next < values.length) {
      const index = next
      next += 1
      const value = values[index]
      if (value === undefined) return
      results[index] = await operation(value)
    }
  }))
  return results
}

async function main(): Promise<void> {
  const options = parseNextPackageBenchmarkOptions(process.argv.slice(2))
  const root = resolve(import.meta.dirname, '..')
  const packages = readWorkspacePackageManifests(root)
  const workspaceVersions = new Map(packages.all.map(pkg => [pkg.name, currentVersion(pkg)]))
  const releaseByName = new Map(packages.release.map(pkg => [pkg.name, pkg]))
  const state = await readPackageDependencyState(root)
  if (state.policyViolations.length > 0) throw new Error(state.policyViolations.join('\n'))
  const base = cloneIndex(buildRegistryIndex(root))
  for (const facts of state.facts) applyFactsToRegistry(base, facts, workspaceVersions)
  const targetVersion = workspaceVersions.get(TARGET_PACKAGE)
  if (targetVersion === undefined) throw new Error(`workspace has no ${TARGET_PACKAGE}`)
  const policyNames = new Set(state.facts.map(facts => facts.manifest.name).filter(name => name !== undefined))
  const discovered = discoverBenchmarkCandidates(base, workspaceVersions, releaseByName, policyNames)
  const candidates = options.candidates ?? discovered
  for (const name of candidates) {
    if (!discovered.includes(name)) throw new Error(`${name} is not a reachable unconfigured Host candidate`)
  }
  const candidateFacts = new Map(await Promise.all(candidates.map(async (name) => {
    const pkg = releaseByName.get(name)
    if (pkg === undefined) throw new Error(`release set has no ${name}`)
    return [name, await readPackageDependencyFacts(root, pkg, 'configured-host', state.workspaceNames)] as const
  })))

  const baselineSeconds = await measure(base, targetVersion, options.finalistRuns, options.timeoutMs)
  const baseline = median(baselineSeconds)
  console.log(JSON.stringify({ type: 'baseline', seconds: baselineSeconds, medianSeconds: baseline }))

  const coarse = await mapConcurrent(candidates, options.jobs, async (name): Promise<Measurement> => {
    const index = cloneIndex(base)
    const facts = candidateFacts.get(name)
    if (facts === undefined) throw new Error(`missing source facts for ${name}`)
    applyFactsToRegistry(index, facts, workspaceVersions)
    const seconds = await measure(index, targetVersion, options.coarseRuns, options.timeoutMs)
    const result = { package: name, seconds, medianSeconds: median(seconds) }
    console.log(JSON.stringify({ type: 'coarse', ...result }))
    return result
  })
  const finalists = coarse.sort((left, right) => left.medianSeconds - right.medianSeconds)
    .slice(0, options.finalists)
  const measured: Measurement[] = []
  for (const finalist of finalists) {
    const index = cloneIndex(base)
    const facts = candidateFacts.get(finalist.package)
    if (facts === undefined) throw new Error(`missing source facts for ${finalist.package}`)
    applyFactsToRegistry(index, facts, workspaceVersions)
    const seconds = await measure(index, targetVersion, options.finalistRuns, options.timeoutMs)
    measured.push({ package: finalist.package, seconds, medianSeconds: median(seconds) })
  }
  const ranking = measured.sort((left, right) => left.medianSeconds - right.medianSeconds)
    .map(result => ({
      ...result,
      gainSeconds: Number((baseline - result.medianSeconds).toFixed(2)),
    }))
  console.log(JSON.stringify({
    type: 'result',
    baselineSeconds,
    baselineMedianSeconds: baseline,
    candidateCount: candidates.length,
    ranking,
  }, null, 2))
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(`benchmark-next-package-dependency: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
