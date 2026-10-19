/** Turn a source list into a validated format-1 index, reusing cached results for unchanged releases and commits. */
import { existsSync } from 'node:fs'
import { join, posix } from 'node:path'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'
import semver from 'semver'
import { cacheKey, gitRefs, npmPackument, npmTarball, withGitObjects, type FetchLimits, type GitObjects, type GitTransports } from './fetchers.ts'
import { readJsonFile, writeIfChanged, type PackageFiles } from './files.ts'
import { GENERATED_ICON, readDisplayMetadata, type Display, type IconFile } from './metadata.ts'
import { dshRange, findBundlePackages, isBundle, isPrivate, readManifest, type Manifest } from './packages.ts'
import type { Source } from './sources.ts'

/** One generated version, in the field order of the format. */
export interface GeneratedVersion {
  readonly version: string
  readonly publishTimestamp: number
  readonly source: Readonly<Record<string, string>>
  readonly engines?: { readonly dsh: string }
}

/** One generated plugin, in the field order of the format. */
export interface GeneratedEntry extends Display {
  readonly name: string
  readonly versions: readonly GeneratedVersion[]
}

/** Everything one run needs besides the network. */
export interface GenerateOptions {
  readonly sources: readonly Source[]
  readonly cacheDir: string
  /** npm registry base URL ending in `/`. */
  readonly registry: string
  /** Whether versions name `registry`; false for the public registry, which clients use by default. */
  readonly recordRegistry: boolean
  readonly title: string
  readonly description?: string
  readonly inlineIconBytes: number
  readonly limits: FetchLimits
  readonly concurrency: number
  readonly warn: (message: string) => void
  /** Git transports allowed besides none; `['https', 'ssh']` when absent. Tests add `file` for local repositories. */
  readonly gitTransports?: GitTransports
}

/** A finished run: the index document, the icon files it refers to, and the sources that could not be read. */
export interface GenerateResult {
  readonly index: { readonly format: 1; readonly title: string; readonly description?: string; readonly plugins: readonly GeneratedEntry[] }
  /** Icon files by index-relative path; contents live under the cache. */
  readonly icons: ReadonlyMap<string, string>
  readonly failures: readonly string[]
}

/** One listable version of a package; `display` is read from that version's files when they were read. */
interface Release {
  readonly name: string
  readonly version: GeneratedVersion
  readonly display?: Display
}

/** Base URL only used to validate relative icon references. */
const VALIDATION_URL = 'https://index.invalid/index.json'
/** Part of every cache key; change it when the way entries are derived changes, so cached results are rebuilt. */
const CACHE_VERSION = 8

/** Why the index format rejects these plugins, or undefined when it accepts them. */
function invalid(plugins: unknown): string | undefined {
  try {
    parseMarketIndex({ format: 1, title: 'check', plugins }, VALIDATION_URL)
    return undefined
  } catch (error) {
    return (error as Error).message
  }
}

/** Combine releases of one package into an entry whose display fields come from the highest version. */
function entryOf(name: string, releases: readonly Release[]): GeneratedEntry {
  const sorted = [...releases].sort((left, right) => semver.rcompare(left.version.version, right.version.version))
  const { title, description, icon, author, homepage, repository, metadata } = sorted[0]?.display ?? {}
  return {
    name,
    ...title === undefined ? {} : { title }, ...description === undefined ? {} : { description },
    ...icon === undefined ? {} : { icon }, ...author === undefined ? {} : { author }, ...homepage === undefined ? {} : { homepage },
    ...repository === undefined ? {} : { repository },
    ...metadata === undefined ? {} : { metadata },
    versions: sorted.map(release => release.version),
  }
}

/** The result cache. A record is used only when the index format accepts its plugins and their icon files exist. */
class Cache {
  constructor(private readonly dir: string) {}

  /** @returns the record file of an immutable identity. */
  file(...identity: unknown[]): string {
    return join(this.dir, 'results', `${cacheKey(JSON.stringify([CACHE_VERSION, ...identity]))}.json`)
  }

  usable(plugins: unknown): plugins is GeneratedEntry[] {
    return invalid(plugins) === undefined
      && (plugins as GeneratedEntry[]).every(({ icon }) => icon === undefined || icon.startsWith('data:')
        || (icon.startsWith('icons/') && GENERATED_ICON.test(icon.slice('icons/'.length)) && existsSync(join(this.dir, icon))))
  }

  /** @returns cached plugins, or undefined when the record is absent or unusable. */
  plugins(file: string): GeneratedEntry[] | undefined {
    const plugins = (readJsonFile(file) as { plugins?: unknown } | undefined)?.plugins
    return this.usable(plugins) ? plugins : undefined
  }

  /** @returns cached display fields, or undefined when the record is absent or unusable. */
  display(file: string): Display | undefined {
    const display = (readJsonFile(file) as { display?: Display } | undefined)?.display
    // The format validates display fields only as part of a plugin, so the record is checked inside a minimal one.
    const minimal = { ...display, name: 'placeholder', versions: [{ version: '0.0.0', publishTimestamp: 0, source: { type: 'npm' } }] }
    return display !== undefined && this.usable([minimal]) ? display : undefined
  }

  /** @returns a cached release, null for a cached absence, or undefined when the record is absent or unusable. */
  release(file: string): Release | null | undefined {
    const release = (readJsonFile(file) as { release?: Release | null } | undefined)?.release
    if (release === null) return null
    return release !== undefined && this.usable([entryOf(release.name, [release])]) ? release : undefined
  }

  write(file: string, value: object, icons: readonly IconFile[]): void {
    for (const icon of icons) writeIfChanged(join(this.dir, icon.path), icon.bytes)
    writeIfChanged(file, `${JSON.stringify(value)}\n`)
  }
}

/** Build a release from a version's manifest, or warn why the version is not listed. */
function releaseOf(
  name: string, manifest: Manifest, version: string, publishTimestamp: number, source: Record<string, string>,
  warn: (message: string) => void,
): Release | undefined {
  const range = dshRange(manifest)
  const release = {
    name,
    version: { version, publishTimestamp, source, ...typeof range === 'string' ? { engines: { dsh: range } } : {} },
  }
  const problem = range instanceof Error ? range.message : invalid([entryOf(name, [release])])?.replace('$.plugins[0]', 'entry')
  if (problem === undefined) return release
  warn(`${name}@${version} skipped: ${problem}`)
  return undefined
}

async function readDisplay(
  files: PackageFiles, manifest: Manifest, label: string, options: GenerateOptions, icons: IconFile[],
): Promise<Display> {
  const { display, iconFile } = await readDisplayMetadata(files, manifest, {
    inlineBytes: options.inlineIconBytes, warn: (message) => { options.warn(`${label}: ${message}`) },
  })
  if (iconFile !== undefined) icons.push(iconFile)
  return display
}

/**
 * Read every bundle version from the registry document that is neither deprecated nor private, and the display fields
 * from the tarball of the highest one, through a cache keyed by the listed versions.
 */
async function readNpm(source: Extract<Source, { kind: 'npm' }>, options: GenerateOptions, cache: Cache): Promise<GeneratedEntry[]> {
  const packument = await npmPackument(options.registry, source.name, options.limits)
  const npmSource = { type: 'npm', ...options.recordRegistry ? { registry: options.registry } : {} }
  const warn = (message: string) => { options.warn(`${source.line}: ${message}`) }
  const releases = Object.entries(packument.versions ?? {}).flatMap(([version, manifest]) => {
    const published = packument.time?.[version]
    const deprecated = typeof manifest.deprecated === 'string' && manifest.deprecated !== ''
    if (deprecated || isPrivate(manifest) || !isBundle(manifest) || typeof published !== 'string') return []
    return releaseOf(source.name, manifest, version, Math.floor(Date.parse(published) / 1000), npmSource, warn) ?? []
  })
  const highest = entryOf(source.name, releases).versions[0]?.version
  if (highest === undefined) {
    warn('no published version that is neither deprecated nor private declares dsh.bundle')
    return []
  }
  const file = cache.file('npm', options.registry, options.inlineIconBytes, source.name, releases.map(release => release.version.version).sort())
  const cached = cache.plugins(file)
  if (cached !== undefined) return cached
  const { files, manifest } = await npmTarball(source.name, highest, packument.versions?.[highest]?.dist, options.limits)
  const icons: IconFile[] = []
  const display = await readDisplay(files, manifest, `${source.name}@${highest}`, options, icons)
  const plugins = [entryOf(source.name, releases.map(release => release.version.version === highest ? { ...release, display } : release))]
  cache.write(file, { plugins }, icons)
  return plugins
}

/** A tag that names a release: `vX.Y.Z` and `X.Y.Z` for every package, `<name>@X.Y.Z` for one package. */
interface ReleaseTag {
  readonly tag: string
  readonly commit: string
  readonly version: string
  /** The one package the tag applies to; absent for every package. */
  readonly name?: string
}

function releaseTag(tag: string, commit: string): ReleaseTag | undefined {
  const { name, version = '' } = /^(?:(?<name>.+)@|v)?(?<version>[^@]+)$/u.exec(tag)?.groups ?? {}
  return semver.valid(version) === version ? { tag, commit, version, ...name === undefined ? {} : { name } } : undefined
}

/**
 * Read the bundle packages on a repository's default branch, with their versions at release tags and at the default
 * branch commit. Results are cached for the listed refs, and per commit and package directory.
 */
async function readGit(source: Extract<Source, { kind: 'git' }>, options: GenerateOptions, cache: Cache): Promise<GeneratedEntry[]> {
  const transports = options.gitTransports ?? ['https', 'ssh']
  const refs = await gitRefs(source.url, transports, options.limits)
  const tags = [...refs.tags].flatMap(([tag, commit]) => releaseTag(tag, commit) ?? [])
  const file = cache.file('git', options.inlineIconBytes, source.url, refs.head, tags.map(tag => [tag.tag, tag.commit]))
  const cached = cache.plugins(file)
  if (cached !== undefined) return cached
  const warn = (message: string) => { options.warn(`${source.line}: ${message}`) }
  const unitFile = (kind: string, commit: string, path: string) => cache.file(kind, options.inlineIconBytes, source.url, commit, path)
  const plugins = await withGitObjects(source.url, refs, transports, options.limits, async (objects) => {
    const packages = await headPackages(await objects.tree(refs.head, ''), warn)
    // Lower ranks win when several commits carry one version: `<name>@` tags, then unified tags, then the default branch.
    const units = [
      ...tags.flatMap(tag => packages.filter(found => tag.name === undefined || tag.name === found.name)
        .map(found => ({ found, commit: tag.commit, version: tag.version, rank: tag.name === undefined ? 1 : 0 }))),
      ...packages.map(found => ({ found, commit: refs.head, version: undefined, rank: 2 })),
    ].map(unit => ({ ...unit, file: unitFile('release', unit.commit, unit.found.path) }))
    const cached = new Map(units.map(unit => [unit.file, cache.release(unit.file)]))
    await objects.fetch(units.flatMap(unit => cached.get(unit.file) === undefined ? [unit.commit] : []))
    const releases = new Map<string, Release | null>()
    const candidates: { release: Release; rank: number; path: string }[] = []
    for (const unit of units) {
      const known = releases.has(unit.file) ? releases.get(unit.file) : cached.get(unit.file)
      const release = known === undefined ? await readRelease(objects, unit.file, unit.commit, unit.found.path) : known
      releases.set(unit.file, release)
      if (release?.name === unit.found.name && (unit.version ?? release.version.version) === release.version.version) {
        candidates.push({ release, rank: unit.rank, path: unit.found.path })
      }
    }
    const time = (candidate: { release: Release }) => candidate.release.version.publishTimestamp
    candidates.sort((left, right) => left.rank - right.rank || time(left) - time(right))
    const chosen = new Map(packages.map(found => [found.name, new Map<string, { release: Release; path: string }>()]))
    for (const { release, path } of candidates) {
      const versions = chosen.get(release.name) as Map<string, { release: Release; path: string }>
      if (!versions.has(release.version.version)) versions.set(release.version.version, { release, path })
    }
    const entries: GeneratedEntry[] = []
    for (const [name, versions] of chosen) {
      const highest = entryOf(name, [...versions.values()].map(choice => choice.release)).versions[0]
      if (highest === undefined) continue
      const { path } = versions.get(highest.version) as { path: string }
      const display = await readGitDisplay(objects, highest.source.commit as string, path, `${name}@${highest.version}`)
      const listed = [...versions.values()].map(({ release }) => release.version === highest ? { ...release, display } : release)
      entries.push(entryOf(name, listed))
    }
    return entries
  })
  cache.write(file, { plugins }, [])
  return plugins

  /**
   * Read and cache the release at one commit and package directory; null when it lists none. A commit that cannot be
   * read, such as a release-named tag on a blob, is reported and lists none, so it cannot fail the repository.
   */
  async function readRelease(objects: GitObjects, releaseFile: string, commit: string, path: string): Promise<Release | null> {
    let release: Release | null
    try {
      const files = await objects.tree(commit, path)
      const manifest = await readManifest(files, '')
      const gitSource = { type: 'git', url: source.url, commit, ...path === '' ? {} : { path } }
      release = isBundle(manifest) && !isPrivate(manifest) && typeof manifest?.name === 'string' && typeof manifest.version === 'string'
        ? releaseOf(manifest.name, manifest, manifest.version, await objects.committed(commit), gitSource, warn) ?? null : null
    } catch (error) {
      warn(`${commit}:${path} skipped: ${(error as Error).message}`)
      release = null
    }
    cache.write(releaseFile, { release }, [])
    return release
  }

  /** Read and cache the display fields at one commit and package directory. */
  async function readGitDisplay(objects: GitObjects, commit: string, path: string, label: string): Promise<Display> {
    const displayFile = unitFile('display', commit, path)
    const known = cache.display(displayFile)
    if (known !== undefined) return known
    const files = await objects.tree(commit, path)
    const icons: IconFile[] = []
    const display = await readDisplay(files, await readManifest(files, '') as Manifest, label, options, icons)
    cache.write(displayFile, { display }, icons)
    return display
  }
}

/** Names of the bundle packages on the default branch that are not private, by package directory. */
async function headPackages(files: PackageFiles, warn: (message: string) => void): Promise<{ path: string; name: string }[]> {
  const paths = await findBundlePackages(files, warn)
  if (paths.length === 0) warn('no package declares dsh.bundle')
  const packages: { path: string; name: string }[] = []
  let privates = 0
  for (const path of paths) {
    const manifest = await readManifest(files.within(path), '')
    if (isPrivate(manifest)) privates++
    else if (typeof manifest?.name === 'string') packages.push({ path, name: manifest.name })
    else warn(`${posix.join(path, 'package.json')} has no name`)
  }
  if (privates > 0 && privates === paths.length) warn('every package that declares dsh.bundle is private')
  return packages
}

/** Run `work` over `items` with at most `limit` in flight, keeping results in input order. */
async function mapLimited<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index] as T, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/**
 * Generate an index. A source that cannot be read keeps its last successful result, so a transient outage does not
 * drop plugins; it is still reported in `failures`.
 * @param options - sources, cache, and limits.
 * @returns the index document, the icon files it refers to, and the failed sources in list order.
 */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const cache = new Cache(options.cacheDir)
  const failed: (string | undefined)[] = new Array<string | undefined>(options.sources.length)
  const results = await mapLimited(options.sources, options.concurrency, async (source, position) => {
    const lastFile = join(options.cacheDir, 'last', `${cacheKey(JSON.stringify([CACHE_VERSION, options.registry, options.inlineIconBytes, source.line]))}.json`)
    try {
      const plugins = source.kind === 'npm' ? await readNpm(source, options, cache) : await readGit(source, options, cache)
      cache.write(lastFile, { plugins }, [])
      return plugins
    } catch (error) {
      // Any failure of one source keeps that source's last result instead of failing the run.
      const message = `${source.line}: ${(error as Error).message}`
      const last = cache.plugins(lastFile)
      failed[position] = message
      options.warn(last === undefined ? message : `${message}; keeping the last successful result`)
      return last ?? []
    }
  })
  const names = new Set<string>()
  const plugins: GeneratedEntry[] = []
  const icons = new Map<string, string>()
  for (const entry of results.flat()) {
    if (names.has(entry.name)) {
      options.warn(`${entry.name}: listed by more than one source; keeping the first`)
      continue
    }
    names.add(entry.name)
    plugins.push(entry)
    if (entry.icon?.startsWith('icons/') === true) icons.set(entry.icon, join(options.cacheDir, entry.icon))
  }
  const index = {
    format: 1 as const,
    title: options.title,
    ...options.description === undefined ? {} : { description: options.description },
    plugins,
  }
  parseMarketIndex(index, VALIDATION_URL)
  return { index, icons, failures: failed.filter(message => message !== undefined) }
}
