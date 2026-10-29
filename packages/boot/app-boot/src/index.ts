/**
 * Shared boot glue for `dsh` profiles, including the CLI packaged by the Python runtime wheel: load the gitignored
 * `.env`, install the fail-loud Loader guards, resolve the config path (snapshot-aware), load the
 * optional user patch layers from the Harness home (`~/.dsh`), expose its path resolver to
 * config expressions, and drive the Cordis Loader against a leaf `cordis.yml` until the tree settles.
 * @module @deepseek-ai/dsh-app-boot
 */

import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { inspect, parseEnv } from 'node:util'
import { captureStartupComposition, type StartupCompositionDiagnostic } from './startup-diagnostics.ts'
export type { StartupCompositionDiagnostic, StartupPluginState, StartupServiceState } from './startup-diagnostics.ts'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { Context, type Fiber, type FiberState } from '@deepseek-ai/cordis'
import Loader, { type Entry, type EntryGroup, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import Include, { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import { dshHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createLaunchEnvironmentSnapshot, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
export { readBundlePatches, readProfilePatches, resolveTelemetryPatch, type ProfileContext, type ProfilePnpmInvocation } from './profile-context.ts'
export { sanitizeProfile } from './profile-sanitize.ts'
export { getDshRuntimeVersion, evaluatePluginCompatibility, pluginCompatibilityWarning, type PluginCompatibility } from './plugin-compatibility.ts'
export {
  PROFILE_COMPATIBILITY_FILENAME, readProfileCompatibility, readProfileVersionExemptions,
  setProfileVersionExemption, validatePluginVersionExemption, type ProfileCompatibility,
} from './profile-compatibility.ts'
import { prepareProfilePatches } from './compatibility-preflight.ts'
import { ProfileRuntimeResolution, type RuntimeResolution } from './profile.ts'
import { ResolutionRestartRequired } from './profile-resolution/resolver.ts'
export { prepareProfileEntries, prepareProfilePatches } from './compatibility-preflight.ts'
export { readPluginMeta, resolvePluginResource } from './package-meta.ts'
export { generateConfigSchema, type ConfigSchemaDump, type NativeConfigSchema } from './config-schema/index.ts'
export { createConfigProjector, LOADER_EXPRESSION_SCHEMA, type ConfigProjection } from './config-schema/projector.ts'
export { isNativeConfigSchema } from './config-schema/native.ts'

export {
  readProfilePlugins, reconcileProfilePlugins, writeProfileBundles,
  type ProfilePluginLocation, type ProfilePluginDependency, type ProfilePluginInventory, type ProfilePluginReconciliation,
} from './profile-plugins.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Harness-home path resolver available to Loader `!!js` config expressions. */
    dshHomePath?: typeof dshHomePath
  }

  interface Events {
    /**
     * Profile patches were reconciled into the running Loader tree: every entry update settled and no new
     * inactive entry was introduced. Carries no diff; listeners re-read Loader entries.
     * @mode emit
     */
    'app-boot/config-reload'(): void
  }
}

export { assertBundlePlatform, UnsupportedBundlePlatformError } from './bundle-platform.ts'
export {
  composeEntries,
  createRuntimeResolution,
  ProfileRuntimeResolution,
  bundlePatchFiles,
  bundlePatchPaths,
  initProfile,
  removeLinkProjections,
  loadProfile,
  loadProfileDirectory,
  PROFILE_PATCH_FILENAME,
  PROFILES_DIR,
  readProfileManifest,
  reportSkippedBundles,
  resolveBundleDir,
  resolveProfileDir,
  writeProfileManifest,
  type Profile,
  type ProfileLayer,
  type SkippedBundle,
  type ProfileManifest,
  type LinkedRoot,
  type RuntimeResolutionOptions,
  type RuntimeResolutionEntry,
  type RuntimeResolution,
} from './profile.ts'
export {
  PluginPackages,
  type PluginPackage,
  type PluginPackagesConfig,
} from './profile-resolution/service.ts'
export { ResolutionRestartRequired } from './profile-resolution/resolver.ts'

/**
 * Resolve the config to boot. Replay swaps a `cordis.yml` basename for
 * `cordis.snapshot.yml` in the same directory; every other mode keeps the path.
 * @param configPath - the requested config path (absolute, or relative to `cwd`).
 * @param snapshotMode - the bin's `$DSH_SNAPSHOT` value; only `'replay'` swaps the
 *   basename.
 * @param cwd - the base a relative `configPath` resolves against.
 * @returns the absolute path of the config to boot.
 */
export function resolveConfigPath(
  configPath: string, snapshotMode: string | undefined, cwd: string = process.cwd(),
): string {
  const absolute = resolve(cwd, configPath)
  if (snapshotMode !== 'replay') return absolute
  const dir = dirname(absolute)
  const replayName = basename(absolute).replace(/cordis\.ya?ml$/, 'cordis.snapshot.yml')
  return resolve(dir, replayName)
}

/**
 * Load the optional gitignored `.env` from `dir`. Missing files fall back to the
 * ambient environment; other read failures are reported through `warn`.
 * @param binName - the diagnostic prefix on the warn line.
 * @param dir - the directory whose `.env` to load.
 * @param warn - sink for the one-line misconfiguration diagnostic.
 */
export function loadEnv(
  binName: string, dir: string = process.cwd(),
  warn: (line: string) => void = line => void process.stderr.write(line),
): void {
  try {
    process.loadEnvFile(resolve(dir, '.env'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      warn(`${binName}: failed to load .env: ${String(error)}\n`)
    }
    // ENOENT (no .env) is fine — rely on the ambient environment.
  }
}

/** Exact names no discovered file may set. */
const BOOTSTRAP_NAMES = new Set([
  // Process launch and module resolution.
  'PATH', 'HOME', 'USERPROFILE', 'SHELL',
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT',
  // Interpreter startup hooks.
  'BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS',
  'PERL5OPT', 'PERL5LIB', 'PYTHONSTARTUP', 'PYTHONPATH', 'RUBYOPT', 'RUBYLIB',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS',
  'PYTHONHOME',
  // Version-control hooks, config redirects, and ambient command selectors.
  'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER', 'GIT_EDITOR',
  'GIT_ASKPASS', 'SSH_ASKPASS',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT',
  'EDITOR', 'VISUAL', 'PAGER', 'BROWSER',
  // Network reach and trust.
  'DEEPSEEK_BASE_URL', 'DEEPSEEK_SEARCH_BASE_URL',
  'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  'NODE_TLS_REJECT_UNAUTHORIZED',
])

/** Name prefixes no discovered file may set. */
const BOOTSTRAP_PREFIXES = ['DSH_', 'XDG_', 'DYLD_', 'BASH_FUNC_']

/**
 * The bootstrap names the Harness-home `.env` alone may set. A proxy chooses the route every
 * request takes, so the invoking directory's file — which arrives with a clone — keeps refusing
 * them; the home file is the user's own, and `DSH_HOME` is itself bootstrap-only, so no `.env` can
 * relocate this exemption. The CA and TLS names in the same group stay refused everywhere: they
 * change what is trusted, not where traffic goes.
 */
const HOME_LAYER_PROXY_NAMES = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'])

/**
 * Whether a variable may come only from the inherited process environment
 * because it changes process, runtime, VCS, or network bootstrap. The Harness-home
 * file is additionally allowed {@link HOME_LAYER_PROXY_NAMES}.
 * @param name - the variable name.
 * @returns true when only the inherited environment may supply it.
 */
function isBootstrapOnly(name: string): boolean {
  const upper = name.toUpperCase()
  return BOOTSTRAP_NAMES.has(upper) || BOOTSTRAP_PREFIXES.some(prefix => upper.startsWith(prefix))
}

/**
 * Parse one directory's `.env` without applying it, rejecting bootstrap-only
 * names before any value is materialized.
 * @param binName - the diagnostic prefix on the thrown error.
 * @param dir - the directory whose `.env` to read.
 * @param warn - sink for the one-line unreadable-file diagnostic.
 * @param home - the resolved Harness home; when `dir` is it, {@link HOME_LAYER_PROXY_NAMES} are accepted.
 * @returns the parsed entries, or `undefined` when the file is absent or unreadable.
 * @throws when the file declares a name {@link isBootstrapOnly} rejects and this layer may not set.
 */
function readEnvLayer(
  binName: string, dir: string, warn: (line: string) => void, home: string,
): { path: string; values: Record<string, string> } | undefined {
  const path = resolve(dir, '.env')
  const isHome = resolve(dir) === home
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      warn(`${binName}: failed to load .env: ${String(error)}\n`)
    }
    // ENOENT (no .env) is fine — rely on the ambient environment.
    return undefined
  }
  // Parse once so validation and materialization use exactly the same entries.
  const values = parseEnv(content) as Record<string, string>
  for (const name of Object.keys(values)) {
    if (!isBootstrapOnly(name)) continue
    const proxyName = HOME_LAYER_PROXY_NAMES.has(name.toUpperCase())
    if (isHome && proxyName) continue
    // A proxy name has a second way out that the other bootstrap names do not, so its message says so.
    const remedy = proxyName
      ? `export ${name}, or put it in ${resolve(home, '.env')}, which does not travel with a repository`
      : `export ${name} instead of putting it in a .env file`
    throw new Error(
      `${binName}: ${path} sets "${name}", which only the launching environment may set`
      + ' (it decides how this process starts, where its code and instructions load from, or how it'
      + ` reaches the network); ${remedy}`,
    )
  }
  return { path, values }
}

/**
 * Load the product CLI's inherited > invoking-directory `.env` > Harness-home
 * `.env` snapshot. The Harness home resolves before either file; both files
 * are checked before either is applied, and accepted values are materialized
 * without replacing inherited ones. The snapshot preserves which layer supplied each value.
 * @param binName - the diagnostic prefix on the diagnostics.
 * @param cwd - the invoking directory whose `.env` is the project layer.
 * @param warn - sink for the one-line misconfiguration diagnostics.
 * @returns this run's frozen environment snapshot.
 * @throws when either file declares a bootstrap-only variable, except {@link HOME_LAYER_PROXY_NAMES} in the Harness-home file.
 */
export function loadLayeredEnv(
  binName: string, cwd: string = process.cwd(),
  warn: (line: string) => void = line => void process.stderr.write(line),
): LaunchEnvironmentSnapshot {
  const home = resolveDshHome()
  const inherited = { ...process.env } as Record<string, string>
  // Parse both layers first: a rejection must not leave one file applied.
  const project = readEnvLayer(binName, cwd, warn, home)
  const user = home === resolve(cwd) ? undefined : readEnvLayer(binName, home, warn, home)
  // Apply the checked values without replacing a higher-ranked name.
  for (const layer of [project, user]) {
    if (layer === undefined) continue
    for (const [name, value] of Object.entries(layer.values)) {
      if (process.env[name] === undefined) process.env[name] = value
    }
  }
  return createLaunchEnvironmentSnapshot([
    { source: 'process', values: inherited },
    ...project === undefined ? [] : [{ source: 'project-env' as const, path: project.path, values: project.values }],
    ...user === undefined ? [] : [{ source: 'user-env' as const, path: user.path, values: user.values }],
  ])
}

const bootstrapIncludes = new WeakMap<Context, Entry>()

// The include's YAML dialect (`!!js` scalars become expression nodes the
// Loader interpolates against each entry's injection-ready context), imported
// from the include itself so patch parsing and config dumping can never drift
// from what the include mounts. User patch layers share it so they may
// reference `process.env`.
const userPatchesSchema = entryListSchema

/** What a caller of {@link recomposeProfile} already did and requires. */
export interface ProfileRecompositionOptions {
  /** Explicit enablement targets whose existing failures also reject the recomposition. */
  readonly requiredIds?: readonly string[]
  /**
   * Loader entries that ran before the caller stopped some of them. Each that no longer runs starts again, and each that
   * failed afterwards counts as a new failure.
   */
  readonly running?: readonly Entry[]
}

/** The outcome of a {@link recomposeProfile} that applied or kept the composition. */
export interface ProfileRecomposition {
  /** Diagnostics for unchanged pre-existing inactive entries. */
  warnings: string[]
  /** Present when the runtime resolution could not publish a moved package or a changed installation mapping. */
  restartReason?: 'package-moved'
}

/**
 * Recompose the profile from its complete patch list, together with its runtime resolution. The rows the generation no
 * longer lists are removed first and their disposal finishes while their packages are still mapped; the latest
 * generation of an installed, recomputable resolution is published; the compatibility preflight reads the published
 * packages; the generation is applied to the root Include; entries that ran, and enabled entries whose import failed,
 * start afterwards when the update left them without a running fiber; and activation is judged. A failure before the generation applies,
 * including a publication the resolution rejects, which reports `package-moved`, puts the removed rows back at their
 * places, starting them again, and starts the entries that ran again. An entry waiting for a service is reported as a
 * warning unless it is required. Patches are copied with `structuredClone`, so they hold no functions.
 * @param ctx Booted root context.
 * @param patches Complete ordered patch list.
 * @param binName Diagnostic prefix.
 * @param options What the caller already did and requires.
 * @returns Diagnostics for unchanged pre-existing inactive entries, and the restart reason of a rejected publication.
 * @throws When the root Include is missing; the latest resolution cannot be read or published; preparation or the
 * Loader update rejects; or for a new or changed failure, an inactive required entry, a failed entry that ran, or a
 * healthy fiber whose disposal rejected.
 */
export function recomposeProfile(
  ctx: Context, patches: PatchOptions[], binName: string, options: ProfileRecompositionOptions = {},
): Promise<ProfileRecomposition> {
  return recompose(ctx, patches, binName, options, true)
}

/**
 * Apply a complete patch list to the root Include and judge activation, leaving the runtime resolution and entries
 * whose import failed as they are.
 * @param ctx Booted root context.
 * @param patches Complete ordered patch list.
 * @param binName Diagnostic prefix.
 * @param requiredIds Explicit enablement targets whose existing failures also reject reconciliation.
 * @returns Diagnostics for unchanged pre-existing inactive entries; new or changed failures reject.
 */
export async function reconcileProfilePatches(
  ctx: Context, patches: PatchOptions[], binName: string, requiredIds: readonly string[] = [],
): Promise<string[]> {
  return (await recompose(ctx, patches, binName, { requiredIds }, false)).warnings
}

async function recompose(
  ctx: Context, patches: PatchOptions[], binName: string, options: ProfileRecompositionOptions, withResolution: boolean,
): Promise<ProfileRecomposition> {
  const { requiredIds = [], running = [] } = options
  let applying = false
  // The rows stopped first, which a failure before the generation applies puts back.
  let stopped: StoppedRow[] = []
  try {
    const entry = bootstrapIncludes.get(ctx)
    if (entry === undefined) throw new Error(`${binName}: profile reload requires the root Include entry`)
    // Reading the prior state imports nothing, so plugin code does not run before the next resolution publishes.
    const previousFailures = (await inactiveEntries(ctx, false)).map((failure): RecordedFailure => ({
      entry: failure.entry, fiber: failure.entry.fiber, options: JSON.stringify(failure.entry.options),
      // An entry without a running fiber has no import error yet; the judgment after the update reads it.
      diagnostic: failure.entry.fiber?.uid ? reloadDiagnostic(failure) : undefined,
    }))
    // Removed entries leave the Loader store before their async disposers finish.
    const previousFibers = [...ctx.loader.entries()].flatMap(row => row.fiber === undefined ? [] : [row.fiber])
    const { patches: previous = [], ...includeConfig } = entry.options.config as Include.Config
    const current = withResolution ? ctx.get('pluginPackages')?.resolution : undefined
    // A plain-data resolution has no inputs to recompute from.
    const successor = current instanceof ProfileRuntimeResolution ? await current.computeLatestResolution() : undefined
    if (successor !== undefined) {
      // Rows the generation no longer lists stop, and their disposal finishes, while their packages are still mapped.
      const listed = rowIds(structuredClone(patches))
      const composed = rowIds(structuredClone(previous))
      // Only rows of the root Include's tree; a nested Include file has its own ids.
      const tree = entry.subgroup?.tree
      const dropped = [...ctx.loader.entries()]
        .filter(row => row.parent.tree === tree && composed.has(row.options.id) && !listed.has(row.options.id))
      // A dropped group takes its rows with it.
      const ids = new Set(dropped.map(row => row.options.id))
      const topmost = dropped.filter(row => !ids.has(row.parent.ctx.fiber.entry?.options.id as string))
      // The Loader marks the options of a row it stops, so the copy taken before is the one restored.
      stopped = topmost.map(row => ({
        group: row.parent, options: structuredClone(row.options),
        index: row.parent.data.indexOf(row.options),
      }))
      if (topmost.length > 0) {
        const fibers = dropped.flatMap(row => row.fiber === undefined ? [] : [row.fiber])
        for (const row of topmost) {
          // A disabled row's disposal is the Loader's own, so it does not rewrite the profile's configuration file.
          row.options.disabled = true
          row.parent.remove(row.options.id)
        }
        await Promise.allSettled(fibers.map(fiber => fiber.await()))
        await ctx.loader.await()
      }
      try {
        publish(ctx, successor)
      } catch (error) {
        if (!(error instanceof ResolutionRestartRequired)) throw error
        // The generation waits for the mappings the rejected publication would change.
        return { warnings: [], restartReason: 'package-moved' }
      }
    }
    // The recomposition judges the rows the launch judged, resolved from the file this Include read.
    const parentURL = new URL('.', new URL(includeConfig.path, entry.parent.tree.ctx.baseUrl)).href
    const prepared = prepareProfilePatches(ctx, patches, parentURL, binName)
    applying = true
    const retried = [...new Set([...running, ...withResolution ? [...ctx.loader.entries()].filter(importFailed) : []])]
    // Group.update replaces its data array and attempts every row it still lists, including failed imports.
    const priorData = new Map(retried.map(row => [row, row.parent.data]))
    try {
      await entry.update({ config: { ...includeConfig, patches: prepared } })
    } finally {
      // Only rows whose Group did not update still need an explicit retry after the awaited update.
      await resume(ctx, retried.filter(row => row.parent.data === priorData.get(row)))
    }
    await Promise.allSettled(previousFibers.map(fiber => fiber.await()))
    await ctx.loader.await()
    const failures = await inactiveEntries(ctx)
    const introduced = failures.filter((failure) => {
      if (requiredIds.includes(failure.entry.options.id)) return true
      // An entry waiting for a service starts once a provider appears.
      if (failure.outcome.kind === 'pending') return false
      // An entry that ran before the caller stopped it is a new failure even when it failed the same way before.
      if (running.includes(failure.entry)) return true
      return !previousFailures.some(previous => sameFailure(previous, failure))
    })
    if (introduced.length > 0) throw new Error(activationDiagnostic(binName, introduced, false).trimEnd())
    ctx.emit('app-boot/config-reload')
    return { warnings: failures.map(reloadDiagnostic) }
  } finally {
    // Before the generation applies, the rows removed first and the entries the caller stopped run again.
    if (!applying && (stopped.length > 0 || running.length > 0)) {
      try {
        // Ascending original positions put each row back where it was.
        for (const { group, options, index } of stopped.toSorted((left, right) => left.index - right.index)) {
          // `create` starts the entry but leaves the group's option list as it is; that list is what the next update
          // compares against to remove the row and what the Include writes back.
          group.data.splice(index, 0, options)
          await group.create(options)
        }
        await resume(ctx, running)
        // A restored row is a new Loader entry with the id of the one that ran.
        const ran = new Set(running.map(row => row.options.id))
        for (const failure of await inactiveEntries(ctx)) {
          if (ran.has(failure.entry.options.id)) ctx.logger.warn(`${binName}: ${reloadDiagnostic(failure)}`)
        }
      } catch (error) {
        // The recomposition's own failure is the outcome.
        ctx.logger.warn(error)
      }
    }
  }
}

/** An inactive entry as a recomposition found it before changing anything. */
interface RecordedFailure {
  entry: Entry
  fiber: Fiber | undefined
  /** The entry's options as JSON. */
  options: string
  /** The reload diagnostic; `undefined` for an import failure, which matches any diagnostic. */
  diagnostic: string | undefined
}

/** Whether an inactive entry is the failure recorded before: the same entry, fiber and options, and a matching diagnostic. */
function sameFailure(previous: RecordedFailure, failure: InactiveEntry): boolean {
  return previous.entry === failure.entry && previous.fiber === failure.entry.fiber
    && previous.options === JSON.stringify(failure.entry.options)
    && (previous.diagnostic === undefined || previous.diagnostic === reloadDiagnostic(failure))
}

/** A row a recomposition removed before publishing, with its place in its group. */
interface StoppedRow {
  group: EntryGroup
  options: EntryOptions
  index: number
}

/** The ids of the rows a patch list inserts, including the rows of groups. */
function rowIds(patches: readonly PatchOptions[]): Set<string> {
  const ids = new Set<string>()
  const visit = (rows: readonly EntryOptions[]): void => {
    for (const row of rows) {
      ids.add(row.id)
      // A group keeps its rows in its configuration.
      if ((row.group === true || row.name === 'cordis:group') && Array.isArray(row.config)) visit(row.config as EntryOptions[])
    }
  }
  // Patch warnings are logged when the generation itself is prepared.
  visit(applyEntryPatches([], patches as PatchOptions[], () => {}))
  return ids
}

/** Publish a generation unless it maps exactly what is published, which would only drop the package caches. */
function publish(ctx: Context, next: RuntimeResolution): void {
  const table = ({ localPackageNames, entries, linkedRoots }: RuntimeResolution): string =>
    JSON.stringify([localPackageNames, entries, linkedRoots])
  const packages = ctx.pluginPackages
  if (table(packages.resolution as RuntimeResolution) !== table(next)) packages.replace(next)
}

/** Whether an enabled entry below a running parent has no fiber or keeps the disposed fiber of a failed import. */
function importFailed(entry: Entry): boolean {
  return enabledEntry(entry) && entry.parent.ctx.fiber.uid !== null
    && (entry.fiber === undefined || entry.fiber.state === FIBER_DISPOSED)
}

/** Whether an entry is enabled now; a throwing `disabled` expression counts as disabled. */
function enabledEntry(entry: Entry): boolean {
  try {
    return !entry.disabled
  } catch (_error) {
    // Judgment reports the expression failure.
    return false
  }
}

/** Start invalidated entries the Loader still holds without a running fiber, then wait until it settles. */
async function resume(ctx: Context, invalidated: readonly Entry[]): Promise<void> {
  const entries = new Set(ctx.loader.entries())
  // A stopped entry starts again on update even with unchanged options; an unchanged Include does not update its rows.
  for (const row of invalidated) if (entries.has(row) && !row.fiber?.uid) await row.update({}, false, true)
  await ctx.loader.await()
}

/**
 * Load an optional patch-list file: a top-level YAML array of loader patch
 * entries (`@deepseek-ai/cordis-plugin-include`'s `PatchOptions`): id-targeted config
 * overrides and `insert` lists, with `!!js` expressions allowed. A missing
 * file means "no layer"; an unreadable, unparsable, or non-array file throws —
 * a present patch file that cannot apply is a misconfiguration and must fail
 * loud at boot, never be silently skipped.
 * @param binName - the diagnostic prefix on the thrown error.
 * @param file - absolute path of the patch file.
 * @returns the parsed patches, or `undefined` when the file does not exist.
 */
export function loadOptionalPatches(binName: string, file: string): PatchOptions[] | undefined {
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
    throw new Error(`${binName}: failed to read patches ${file}: ${String(error)}`)
  }
  return parsePatchList(binName, file, content, 'patches')
}

/**
 * Load a required overlay patch list: a bundle's `cordis.patch.yml` or a
 * `--patch <path>` overlay. Same file format as {@link loadOptionalPatches},
 * but a missing file throws, because the caller named this file — its absence
 * is a misconfiguration, not "no overlay".
 * @param binName - the diagnostic prefix on the thrown error.
 * @param file - absolute path of the overlay file.
 * @returns the parsed patch list.
 */
export function loadOverlayPatches(binName: string, file: string): PatchOptions[] {
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`${binName}: failed to read overlay ${file}: ${String(error)}`)
  }
  return parsePatchList(binName, file, content, 'overlay')
}

/** Convert inserted filesystem paths to file URLs, anchoring relative paths beside the patch; keep assertion names literal. */
function anchorInsertedPluginNames(patches: PatchOptions[], file: string): PatchOptions[] {
  const base = dirname(resolve(file))
  const visit = (entry: EntryOptions): void => {
    if (typeof entry.name === 'string' && (isAbsolute(entry.name) || entry.name.startsWith('./') || entry.name.startsWith('../'))) {
      entry.name = pathToFileURL(resolve(base, entry.name)).href
    }
    if (entry.group && Array.isArray(entry.config)) entry.config.forEach(visit)
  }
  for (const patch of patches) patch.insert?.forEach(visit)
  return patches
}
/**
 * Parse one loader patch list: a top-level YAML array of
 * `@deepseek-ai/cordis-plugin-include` `PatchOptions` (id-targeted config overrides and
 * `insert` lists, `!!js` expressions allowed). Every invalid field or value throws,
 * because a patch file that cannot be applied at all is a misconfiguration; a
 * single patch whose target row is absent stays a per-entry Loader warning, so
 * one overlay shared across surfaces does not have to match every tree.
 * @param binName - the diagnostic prefix on the thrown error.
 * @param file - the source path, quoted in errors.
 * @param content - the file's text.
 * @param label - what to call this list in errors (`patches`, `overlay`).
 * @returns the parsed patch list.
 */
function parsePatchList(
  binName: string, file: string, content: string, label: string,
): PatchOptions[] {
  let parsed: unknown
  try {
    parsed = yaml.load(content, { schema: userPatchesSchema })
  } catch (error) {
    throw new Error(`${binName}: failed to parse ${label} ${file}: ${String(error)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${binName}: ${label} ${file} must be a top-level YAML array of loader patch entries`)
  }
  parsed.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`${binName}: ${label} entry ${index + 1} in ${file} must be a mapping (a loader patch entry)`)
    }
  })
  return anchorInsertedPluginNames(parsed as PatchOptions[], file)
}

/** One overlay patch list with the source label printed in dump comments. */
export interface ConfigDumpLayer {
  /** Source name shown in dump comments (a file basename or path). */
  label: string
  /** The layer's patches, from {@link loadOverlayPatches} / {@link loadOptionalPatches}. */
  patches: PatchOptions[]
}

/**
 * Compose the configured entry list: parse the base config file with the
 * include's entry-list dialect, apply every layer's patches as ONE flattened
 * list through the include's own patch algorithm (`applyEntryPatches`) — the
 * same call `boot()` makes, so even patch-visibility corner cases (a later
 * layer targeting a group child a plain config replacement introduced, which
 * the single-pass id index never sees) compose identically — then render the
 * result as YAML in the same dialect (`!!js` expressions print verbatim,
 * unevaluated). Row admission is a later stage: a plugin row the compatibility
 * policy denies still appears here, while a denied bundle contributes no layer.
 *
 * Every run of rows from the same file and patch layers is preceded by a `# ==` comment
 * naming the file that contributed the rows and any layers that patched them,
 * so the output stays a loadable YAML document while showing which section
 * comes from which file. The file and patch labels are derived from single-call prefix
 * snapshots (base + layers 1..k), diffed positionally: the patch algorithm
 * only rewrites rows in place or appends, so a top-level index identifies one
 * row across snapshots, and a layer whose addition changes the row (config
 * replacement, disable, group insert) is listed as having patched it.
 *
 * A patch that matches no row is reported through `warn` with its layer
 * label, mirroring the Loader's boot-time warning. Earlier layers' patches
 * see an identical preceding state in every snapshot that includes them, so
 * each snapshot's warning list extends the previous one and the new tail
 * belongs to the added layer.
 * @param binName - the diagnostic prefix on read/parse errors.
 * @param absoluteConfigPath - the base config file `boot()` would include.
 * @param layers - overlay layers in application order (later wins).
 * @param warn - sink for skipped-patch diagnostics; defaults to stderr.
 * @returns the composed entry list rendered as a YAML document with
 * source comment separators.
 */
export function renderConfigDump(
  binName: string,
  absoluteConfigPath: string,
  layers: ConfigDumpLayer[],
  warn: (line: string) => void = line => void process.stderr.write(`${line}\n`),
): string {
  let content: string
  try {
    content = readFileSync(absoluteConfigPath, 'utf8')
  } catch (error) {
    throw new Error(`${binName}: failed to read config ${absoluteConfigPath}: ${String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = yaml.load(content, { schema: entryListSchema })
  } catch (error) {
    throw new Error(`${binName}: failed to parse config ${absoluteConfigPath}: ${String(error)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${binName}: config ${absoluteConfigPath} must be a top-level YAML array of entries`)
  }
  const baseLabel = basename(absoluteConfigPath)
  // YAML parsing yields untyped rows; the include validates each entry
  // at mount, and the dump prints whatever the file holds, so `EntryOptions`
  // here is structural trust in the same file `boot()` would include.
  const base = parsed as Parameters<typeof applyEntryPatches>[0]
  // snapshot_k = ONE application of layers 1..k flattened, using the exact
  // arguments boot passes for that prefix. snapshot_N is the mounted composition.
  // The patches are cloned per call: applyEntryPatches detaches the entry
  // list but pushes `insert` rows by reference from the patch list, so
  // sharing patch objects across snapshot calls would leak a later
  // snapshot's mutations into an earlier one's result.
  const snapshot = (count: number, warnings: string[]): ReturnType<typeof applyEntryPatches> => {
    const flattened = structuredClone(layers.slice(0, count).flatMap(layer => layer.patches))
    return applyEntryPatches(base, flattened, (message: string, ...args: unknown[]) => {
      // The include logs through cordis's printf-style logger (`%C` = code); a
      // dump has no logger, so substitute inline for a plain line.
      let index = 0
      warnings.push(message.replace(/%C/g, () => JSON.stringify(args[index++])))
    })
  }
  let previous = base
  let previousWarnings: string[] = []
  const entryOrigins: { origin: string; patchedBy: string[] }[] = base.map(() => ({ origin: baseLabel, patchedBy: [] }))
  let composed = base
  for (let count = 1; count <= layers.length; count += 1) {
    const layer = layers[count - 1]
    /* v8 ignore next -- count iterates 1..length, so the slot exists */
    if (layer === undefined) continue
    const warnings: string[] = []
    composed = snapshot(count, warnings)
    for (const line of warnings.slice(previousWarnings.length)) {
      warn(`${binName}: [${layer.label}] ${line}`)
    }
    const before = previous.map(entry => JSON.stringify(entry))
    for (let index = 0; index < composed.length; index += 1) {
      if (index >= before.length) entryOrigins.push({ origin: layer.label, patchedBy: [] })
      else if (JSON.stringify(composed[index]) !== before[index]) entryOrigins[index]?.patchedBy.push(layer.label)
    }
    previous = composed
    previousWarnings = warnings
  }
  return groupedDump(composed, entryOrigins)
}

/** Render the composed rows grouped under one source-and-patches comment per contiguous run. */
function groupedDump(
  composed: readonly unknown[],
  entryOrigins: readonly { origin: string; patchedBy: string[] }[],
): string {
  const lines: string[] = []
  let currentLabel: string | undefined
  let group: unknown[] = []
  const flush = (): void => {
    if (currentLabel === undefined || group.length === 0) return
    lines.push(`# == ${currentLabel}`)
    lines.push(yaml.dump(group, { schema: entryListSchema, noRefs: true }).trimEnd())
    group = []
  }
  for (let index = 0; index < composed.length; index += 1) {
    const record = entryOrigins[index]
    /* v8 ignore next -- this array is index-aligned with composed by construction */
    if (record === undefined) continue
    const label = record.patchedBy.length === 0
      ? record.origin
      : `${record.origin}, patched by ${record.patchedBy.join(', ')}`
    if (label !== currentLabel) {
      flush()
      currentLabel = label
    }
    group.push(composed[index])
  }
  flush()
  return lines.join('\n') + '\n'
}

/**
 * Mount and remember the exact root Include entry used by app boot and user patch-layer HMR.
 * @param ctx - context carrying an initialized Loader service.
 * @param absoluteConfigPath - absolute YAML or JSON configuration path.
 * @param patches - initial app and user patches, applied in order.
 * @param bareModuleBaseUrl - optional installed-host base for bare package
 * names; relative names continue to resolve beside the configuration file.
 * @param binName - diagnostic prefix for a profile plugin denied by compatibility policy; defaults to `dsh`.
 * @returns the created root Include entry, or `undefined` when a surface
 * disposed the whole tree (taking the Loader service with it) while the
 * entry creation was in flight.
 */
export async function mountRootInclude(
  ctx: Context,
  absoluteConfigPath: string,
  patches: readonly PatchOptions[] = [],
  bareModuleBaseUrl?: string,
  binName = 'dsh',
): Promise<Entry | undefined> {
  ctx.loader.builtins.include = bareModuleBaseUrl === undefined
    ? Include
    : class HostResolvedRootInclude extends Include {
      override import(name: string, getOuterStack?: () => string[]): unknown {
        const specifier = isAbsolute(name) ? pathToFileURL(name).href : name
        if (name.startsWith('.') || name.startsWith('cordis:')) return super.import(specifier, getOuterStack)
        const internal = this.ctx.loader.internal
        /* v8 ignore next -- Node supplies the internal loader; this preserves the
           original diagnostic for hypothetical embedders without it. */
        if (internal === undefined) return super.import(specifier, getOuterStack)
        return internal.import(specifier, bareModuleBaseUrl, {})
      }
    }
  // `cordis:group` alongside it: a group row is how a composition gives one
  // `isolate` realm to a provider and its consumers together, and an agent
  // preset living outside this workspace cannot resolve `@deepseek-ai/cordis-plugin-group`
  // by name. Both builtins load through the ambient module pipeline, so neither
  // depends on the included tree's own specifier resolution.
  ctx.loader.builtins.group = Group
  // Pinned id: the bootstrap include is app glue, not a config row, and its
  // id appears in Loader failure chains — a random id would make startup
  // diagnostics unstable across runs (and snapshot fixtures).
  // The launcher's own copy is prepared here: compatibility decisions must be made before the root
  // Include imports anything, and they change no profile patch layer, manifest, or bundle list.
  const prepared = prepareProfilePatches(ctx, [...patches], pathToFileURL(dirname(absoluteConfigPath)).href + '/', binName)
  const includeConfig: Include.Config = {
    path: pathToFileURL(absoluteConfigPath).href,
    ...prepared.length > 0 ? { patches: prepared } : {},
  }
  const rootInclude: EntryOptions = {
    id: 'include',
    name: 'cordis:include',
    config: includeConfig,
  }
  const includeId = await ctx.loader.create(rootInclude)
  const loader = ctx.get('loader')
  if (loader === undefined) return undefined
  const entry = loader.resolve(includeId)
  bootstrapIncludes.set(ctx, entry)
  return entry
}

/** The two process events {@link installFailLoud} turns into a fatal exit. */
export type FailLoudEvent = 'unhandledRejection' | 'uncaughtException'

/**
 * The slice of `process` {@link installFailLoud} needs — injectable so tests
 * exercise the handler without registering on (or exiting) the real process.
 */
export interface FailLoudProcess {
  on(event: FailLoudEvent, handler: (err: unknown) => void): unknown
  off(event: FailLoudEvent, handler: (err: unknown) => void): unknown
  stderr: { write(chunk: string): unknown }
  /**
   * Terminate the process. Callers treat this as the end of the run, as
   * `process.exit` is; a fake that returns lets the caller continue, which only
   * a test observes.
   */
  exit(code: number): void
}

// Loader rc.5 derives and drops a rejected promise after a fiber fails. Keep
// exact reasons already folded into the boot diagnostic visible through the
// next process rejection checkpoint so the process guard can coalesce them.
const assembledActivationRejections = new Map<unknown, number>()

function retainAssembledRejection(reason: unknown): void {
  assembledActivationRejections.set(reason, (assembledActivationRejections.get(reason) ?? 0) + 1)
}

function releaseAssembledRejection(reason: unknown): void {
  const count = assembledActivationRejections.get(reason)
  if (count === undefined || count === 1) {
    assembledActivationRejections.delete(reason)
  } else {
    assembledActivationRejections.set(reason, count - 1)
  }
}

async function observeLoaderRejectionCheckpoint(reasons: readonly unknown[]): Promise<void> {
  for (const reason of reasons) retainAssembledRejection(reason)
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
  } finally {
    for (const reason of reasons) releaseAssembledRejection(reason)
  }
}

/**
 * How long {@link installFailLoud} waits for its `release` hook before exiting
 * anyway. A wedged disposer must delay the fatal exit, never cancel it.
 */
export const FAIL_LOUD_RELEASE_TIMEOUT_MS = 2_000

/**
 * Install before boot to turn an unhandled rejection or an uncaught exception,
 * at any point in the process lifetime, into one labelled stderr diagnostic and
 * `exit(1)`. A rejection already included by {@link auditStartupEntries} is
 * ignored during its process checkpoint; every other rejection and every
 * uncaught exception remains fatal. Control never returns to the failed
 * operation after either: only the throw site knows which state is intact, and
 * a listener that threw mid-update (a stream `'data'` handler, a half-applied
 * registry write) leaves silently wrong results behind if it were resumed. The
 * event loop keeps running only until the release hook settles or times out.
 * Stdout remains untouched for ACP; the returned function removes both handlers.
 *
 * The diagnostic is `util.inspect(err)`, not `err.stack`: a `node:fs` error's
 * `code`, `syscall`, and `path` and any `cause` chain are enumerable properties
 * that the stack line omits, and they are what a crash report needs. Once a
 * handler is installed Node prints nothing of its own, so this line is the
 * only record of the failure.
 *
 * The Loader mounts entries concurrently, so a surface that owns the terminal
 * can already hold it when a sibling entry rejects. Exiting straight from the
 * handler would strand raw mode, bracketed paste, and the keyboard protocol on
 * the user's shell, and leave an in-flight terminal query's reply to land as
 * literal text at the next prompt. `release` is the terminal owner's chance to
 * hand it back; it is awaited under {@link FAIL_LOUD_RELEASE_TIMEOUT_MS}, whose
 * timer stays referenced so a never-settling disposer cannot let Node reach an
 * empty event loop and exit 0 instead of failing.
 *
 * The diagnostic is written before the release so a hanging or failing disposer
 * cannot swallow the reason. The handler stays installed while the release runs
 * — removing it would let a second concurrent rejection become uncaught and kill
 * the process mid-teardown, stranding exactly the terminal state this restores —
 * so a latch keeps the first rejection the reported one and lets later
 * rejections (including the release's own) fall through to the pending exit.
 * @param binName - the diagnostic prefix on the fatal-failure line.
 * @param proc - the process slice to register on; tests inject a fake.
 * @param release - optional teardown awaited before exit, used by a
 *   terminal-owning surface to restore the terminal. Its own failure is
 *   swallowed because the pending fatal exit already owns the outcome.
 * @returns the uninstaller that removes both handlers.
 */
export function installFailLoud(
  binName: string,
  proc: FailLoudProcess = process,
  release?: () => Promise<void> | void,
): () => void {
  let exiting = false
  const report = (err: unknown, label: string): void => {
    // A release in flight already owns the exit. Swallow later failures
    // (teardown's own included) rather than reporting a second failure over the
    // real one or letting Node kill the process before the terminal is back.
    if (exiting) return
    exiting = true
    proc.stderr.write(`${binName}: ${label}: ${inspect(err, { depth: 4, maxArrayLength: 50 })}\n`)
    if (release === undefined) {
      proc.exit(1)
      return
    }
    void (async () => {
      // Definitely assigned: the timeout promise's executor runs synchronously
      // while the race is being constructed, before the first await.
      let timer!: ReturnType<typeof setTimeout>
      try {
        await Promise.race([
          (async () => release())(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, FAIL_LOUD_RELEASE_TIMEOUT_MS)
          }),
        ])
      } catch {
        // The terminal release failed; the fatal exit below is the outcome that
        // matters, and no reporter runs after it.
      }
      clearTimeout(timer)
      proc.exit(1)
    })()
  }
  const onRejection = (err: unknown): void => {
    if (assembledActivationRejections.has(err)) return
    // Label kept stable: the Web profile expected-output e2e tests match it.
    report(err, 'fatal load failure')
  }
  const onException = (err: unknown): void => { report(err, 'fatal uncaught exception') }
  const uninstall = (): void => {
    proc.off('unhandledRejection', onRejection)
    proc.off('uncaughtException', onException)
  }
  proc.on('unhandledRejection', onRejection)
  proc.on('uncaughtException', onException)
  return uninstall
}

/**
 * Value mirrors used because Cordis's const enum has no runtime object to import.
 * Keep aligned with `packages/client/web/src/loader-status.ts`.
 */
const FIBER_PENDING = 0 as FiberState.PENDING
const FIBER_ACTIVE = 2 as FiberState.ACTIVE
const FIBER_FAILED = 3 as FiberState.FAILED
const FIBER_DISPOSED = 4 as FiberState.DISPOSED

/**
 * Entry ids whose presence defines a usable DSH application.
 *
 * The list is global rather than profile metadata. Missing or disabled ids do
 * not affect startup; an enabled listed entry must activate. The list covers
 * shared Agent execution, application endpoints, and Web bootstrap/transport.
 */
const requiredStartupEntryIds = new Set<string>([
  'agent-loop',
  'tool-executor-native',
  'tool-executor-ptc',
  'webserver',
  'web-runtime',
  'modules',
  'connection',
  'headless-runner',
  'acp',
  'sdk-jsonrpc-server',
])

/** Render plugin stacks, nested causes, and aggregate member failures once per error. */
function formatActivationError(error: unknown, stacks = true): string {
  const details: string[] = []
  const seen = new Set<Error>()
  function visit(value: unknown): void {
    if (!(value instanceof Error)) {
      details.push(String(value))
      return
    }
    if (seen.has(value)) return
    seen.add(value)
    details.push(stacks ? value.stack ?? value.message : String(value))
    if (value.cause !== undefined) visit(value.cause)
    if (value instanceof AggregateError) value.errors.forEach(visit)
  }
  visit(error)
  return details.join('\n')
}

interface InactiveEntry {
  /** Loader entry used to identify the bootstrap Include and required ids. */
  entry: Entry
  /** Activation errors and missing services remain distinct for presentation. */
  outcome: { kind: 'failed'; error: unknown; phase?: string }
    | { kind: 'pending'; missing: string[] }
}

/** Inactive plugin metadata without retaining its Context or Fiber. */
interface StartupEntryDiagnostic {
  id: string
  module: string
  required: boolean
  fiberState: FiberState | undefined
  outcome: InactiveEntry['outcome']
}

/** Startup warning or error arguments, including import errors with no Fiber. */
interface StartupLogRecord {
  ts: number
  name: string
  type: string
  args: readonly unknown[]
}

/** Startup audit failure with non-enumerable metadata and original failures as its cause. */
export class StartupError extends Error {
  /** Plugin states captured before disposal, excluding configuration values. */
  composition?: StartupCompositionDiagnostic
  /** Root configuration and startup logs, attached by boot after disposal. */
  startup?: { configurationPath: string; messages: readonly StartupLogRecord[] }

  /**
   * @param message - concise terminal diagnostic.
   * @param entries - inactive plugin metadata and original failure values.
   */
  constructor(message: string, readonly entries: readonly StartupEntryDiagnostic[]) {
    const failures = entries.flatMap(({ outcome }) => outcome.kind === 'failed' ? [outcome.error] : [])
    super(message, failures.length > 0 ? { cause: new AggregateError(failures, 'Plugin activation failures') } : undefined)
    Object.defineProperties(this, {
      entries: { enumerable: false },
      startup: { enumerable: false },
      composition: { enumerable: false },
    })
  }
}

/** The error importing an entry's module raises now, which Node returns from its cache for a module that failed before. */
async function importFailure(entry: Entry): Promise<unknown> {
  try {
    await entry.parent.tree.import(entry.options.name)
    return undefined
  } catch (error) {
    return error
  }
}

/**
 * Collect Loader activation failures and disabled-expression errors. Failed
 * fibers are awaited to recover their recorded rejection reason and coalesce
 * duplicate Loader notifications through the next process rejection checkpoint.
 * An entry whose import failed reports the error importing it raises now; without
 * `importNow` nothing is imported and the entry reports a failed import without the import error.
 */
async function inactiveEntries(ctx: Context, importNow = true): Promise<InactiveEntry[]> {
  const failures: InactiveEntry[] = []
  const rejectionReasons: unknown[] = []
  for (const entry of ctx.loader.entries()) {
    try {
      if (entry.disabled) continue
    } catch (error) {
      failures.push({ entry, outcome: { kind: 'failed', error, phase: 'disabled expression failed' } })
      continue
    }
    const fiber = entry.fiber
    // An entry whose import failed has no fiber, or keeps the disposed fiber of its previous activation.
    if (fiber === undefined || fiber.state === FIBER_DISPOSED) {
      const error = importNow ? await importFailure(entry) : undefined
      failures.push({ entry, outcome: error === undefined
        ? { kind: 'failed', error: fiber === undefined ? 'failed to import' : `fiber state ${String(fiber.state)}` }
        : { kind: 'failed', error, phase: 'failed to import' } })
      continue
    }
    const state = fiber.state
    if (state === FIBER_ACTIVE) continue
    if (state === FIBER_FAILED) {
      try {
        await fiber.await()
      } catch (error) {
        rejectionReasons.push(error)
        failures.push({ entry, outcome: { kind: 'failed', error } })
      }
      continue
    }
    if (state === FIBER_PENDING) {
      const missing = Object.keys(fiber.inject).filter(service => fiber.ctx.get(service) === undefined)
      failures.push({
        entry,
        outcome: { kind: 'pending', missing },
      })
    } else {
      failures.push({ entry, outcome: { kind: 'failed', error: `fiber state ${String(state)}` } })
    }
  }
  if (rejectionReasons.length > 0) await observeLoaderRejectionCheckpoint(rejectionReasons)
  return failures
}

/** Render one failed plugin's original error and activation phase. */
function failureDetail(outcome: Extract<InactiveEntry['outcome'], { kind: 'failed' }>, stacks = true): string {
  return `${outcome.phase === undefined ? '' : `${outcome.phase}: `}${formatActivationError(outcome.error, stacks)}`
}

/** Render optional-only warnings without changing startup policy. */
function activationDiagnostic(
  binName: string,
  failures: readonly InactiveEntry[],
  stacks = true,
): string {
  const noun = failures.length === 1 ? 'entry' : 'entries'
  return `${binName}: warning: ${String(failures.length)} ${noun} did not activate\n${failures.map(failure => inactiveDiagnostic(failure, stacks)).join('\n')}\n`
}

/** Per-entry reload text, which people read through the Web UI and agents, so it carries error messages without stack frames. */
function reloadDiagnostic(failure: InactiveEntry): string {
  return inactiveDiagnostic(failure, false)
}

/** Stable per-entry text for reload comparisons and optional warnings. */
function inactiveDiagnostic({ entry, outcome }: InactiveEntry, stacks = true): string {
  const detail = outcome.kind === 'failed' ? failureDetail(outcome, stacks)
    : `pending (waiting for ${outcome.missing.length === 1 ? 'service' : 'services'}: ${outcome.missing.join(', ') || 'unknown'})`
  return `${entry.options.id} (${entry.options.name}): ${detail}`
}

/** Group startup failures and pending services, marking every required entry. */
function startupDiagnostic(binName: string, failures: readonly InactiveEntry[], required: ReadonlySet<Entry>): string {
  const lines = [`${binName}: startup failed: ${String(required.size)} required ${required.size === 1 ? 'plugin' : 'plugins'} did not activate`]
  const failed = failures.flatMap(({ entry, outcome }) => outcome.kind === 'failed' ? [{ entry, outcome }] : [])
  const pending = failures.flatMap(({ entry, outcome }) => outcome.kind === 'pending' ? [{ entry, outcome }] : [])
  pending.sort((left, right) => Number(required.has(right.entry)) - Number(required.has(left.entry)))
  const label = (entry: Entry): string => `${entry.options.id}${required.has(entry) ? ' (required)' : ''}`
  if (failed.length > 0) {
    lines.push('', `Failed plugins (${String(failed.length)}):`)
    for (const { entry, outcome } of failed) {
      lines.push(`  ${label(entry)}`, `    Package: ${entry.options.name}`)
      lines.push(...failureDetail(outcome).split('\n').map(line => `    ${line}`))
    }
  }
  if (pending.length > 0) {
    const width = Math.max('Plugin'.length, ...pending.map(({ entry }) => label(entry).length)) + 2
    lines.push('', `Plugins waiting for services (${String(pending.length)}):`, `  ${'Plugin'.padEnd(width)}Missing services`)
    for (const { entry, outcome } of pending) {
      lines.push(`  ${label(entry).padEnd(width)}${outcome.missing.join(', ') || 'unknown'}`)
    }
  }
  return lines.join('\n')
}

/**
 * Apply DSH startup policy to a settled Loader tree.
 *
 * Inactive entries from the global required list reject startup. Other
 * inactive entries join that failure diagnostic, or produce one warning when
 * no required entry failed and leave successful siblings running.
 * Required ids absent from the tree, and disabled required entries, are ignored.
 * A throwing disabled expression is an entry failure, not a disabled entry.
 * The bootstrap Include must activate so unreadable or invalid root config is fatal.
 * @param ctx - the settled context whose Loader entries to audit.
 * @param binName - the prefix on startup diagnostics.
 * @param warn - sink for optional-entry warnings.
 * @returns after optional warnings if required startup checks pass.
 * @throws {@link StartupError} when the bootstrap Include or a required entry is inactive or its disabled expression throws;
 * its message includes optional failures too.
 */
export async function auditStartupEntries(
  ctx: Context,
  binName: string,
  warn: (line: string) => void = line => void process.stderr.write(line),
): Promise<void> {
  const failures = await inactiveEntries(ctx)
  const required = new Set(failures.filter(({ entry }) => entry === bootstrapIncludes.get(ctx)
    || requiredStartupEntryIds.has(entry.options.id)).map(({ entry }) => entry))
  if (required.size > 0) {
    throw new StartupError(startupDiagnostic(binName, failures, required), failures.map(({ entry, outcome }) => ({
      id: entry.options.id, module: entry.options.name, required: required.has(entry), fiberState: entry.fiber?.state, outcome,
    })))
  }
  if (failures.length > 0) warn(activationDiagnostic(binName, failures))
}

/**
 * Boot the Loader against `absoluteConfigPath` and return only after the whole
 * tree settles. Relative entry names resolve against the config directory;
 * bare package names resolve there by default or against an explicit
 * `bareModuleBaseUrl` for closed packaged runtimes. The bootstrap include
 * is statically imported and mounted as the `cordis:include` builtin, loading
 * through the ambient module pipeline (vite/tsx/plain ESM). The package build
 * embeds Include while leaving Loader external, so the built include tree and
 * host share one Loader peer. Loader settlement drains entry work without
 * rejecting the whole tree. The final {@link auditStartupEntries} call rejects
 * failures in the global required list and warns about other failed, missing,
 * and pending entries while successful siblings remain active. Later unhandled
 * rejections remain covered by {@link installFailLoud}. Built bins need the Loader's native
 * helper for bare plugin specifiers; relative specifiers do not.
 * @param binName - the diagnostic prefix for load-failure errors.
 * @param absoluteConfigPath - the config to include; must already be absolute
 * (see {@link resolveConfigPath}).
 * @param patches - optional overlay patches applied over the included tree
 * (see {@link loadOptionalPatches}); an empty list mounts none.
 * @param prepare - optional host setup run after Loader installation and before any config-tree entry mounts.
 * @param bareModuleBaseUrl - optional installed-host base for bare package
 * names; use it when the host, rather than the configuration project, owns the
 * complete plugin set.
 * @returns the root context after the initial startup audit, or as soon as a
 * surface disposed the tree while startup was still in flight.
 * @throws {@link StartupError} for an inactive required entry, including all inactive plugins in its message;
 * otherwise a labelled error after disposing the partial context — `host
 * preparation failed` when `prepare` threw before any config-tree entry
 * mounted, `plugin tree failed to load` afterwards. Cyclic causes terminate
 * diagnostic traversal without replacing the original cause.
 */
export async function boot(
  binName: string,
  absoluteConfigPath: string,
  patches?: PatchOptions[],
  prepare?: (ctx: Context) => Promise<void> | void,
  bareModuleBaseUrl?: string,
): Promise<Context> {
  const ctx = new Context()
  const startupLogs: StartupLogRecord[] = []
  // The collector must outlive root disposal to retain asynchronous cleanup errors.
  const diagnostics = new Context()
  diagnostics.logger = ctx.logger
  diagnostics.logger.exporter({
    levels: { default: 2 },
    export: ({ ts, name, type, args }) => {
      if (type === 'warn' || type === 'error') startupLogs.push({ ts, name, type, args })
    },
  })
  // Two failure labels: `prepare` runs before any config-tree entry mounts,
  // so its failure is host setup, not the plugin tree.
  let stage = 'host preparation failed'
  try {
    ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + '/'
    ctx.provide('dshHomePath', dshHomePath)
    await ctx.plugin(Loader)
    await prepare?.(ctx)
    stage = 'plugin tree failed to load'
    await mountRootInclude(ctx, absoluteConfigPath, patches, bareModuleBaseUrl, binName)
    // A surface can finish and dispose the whole tree while startup is still
    // in flight, before the last entry settles. The Loader service goes with
    // it, and the activation audit describes a live tree — reading `ctx.loader`
    // past this point would throw a TypeError over an app that exited exactly
    // as asked. Re-check after settlement before auditing the tree.
    await ctx.get('loader')?.await()
    if (ctx.get('loader') === undefined) return ctx
    await auditStartupEntries(ctx, binName)
    return ctx
  } catch (cause) {
    if (cause instanceof StartupError) {
      try { cause.composition = captureStartupComposition(ctx) } catch (error) {
        ctx.logger.warn('Startup composition diagnostic unavailable', error)
      }
    }
    // Root-fiber disposal contains cleanup failures per observer (Cordis
    // fiber.ts hardening) and a repeated call returns the settled single-shot
    // result, so this await cannot reject and replace `cause`.
    await ctx.fiber.dispose()
    if (cause instanceof StartupError) {
      cause.startup = { configurationPath: absoluteConfigPath, messages: startupLogs }
      throw cause
    }
    const detail = cause instanceof Error ? cause.message : String(cause)
    // A wrapper can carry an activation error whose original stack names the failed plugin.
    let deepest: unknown = cause
    const seen = new Set<Error>()
    while (deepest instanceof Error && !seen.has(deepest) && deepest.cause !== undefined) {
      seen.add(deepest)
      deepest = deepest.cause
    }
    const stack = deepest instanceof AggregateError
      ? `\n${deepest.stack ?? deepest.message}\n${deepest.errors.map(error => formatActivationError(error)).join('\n')}`
      : deepest instanceof Error && deepest !== cause ? `\n${deepest.stack ?? deepest.message}` : ''
    throw new Error(`${binName}: ${stage}: ${detail}${stack}`, { cause })
  } finally {
    await diagnostics.fiber.dispose()
  }
}
