/**
 * Shared boot glue for `dsh` profiles, including the CLI packaged by the Python runtime wheel: load the gitignored
 * `.env`, install the fail-loud Loader guards, resolve the config path (snapshot-aware), load the
 * optional user patch layers from the Harness home (`~/.dsh`), expose its path resolver to
 * config expressions, and drive the Cordis Loader against a leaf `cordis.yml` until the tree settles.
 * @module @deepseek-ai/dsh-app-boot
 */

import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { Context, type FiberState } from '@deepseek-ai/cordis'
import Loader, { type Entry, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import Include, { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import { dshHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createLaunchEnvironmentSnapshot, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/cordis-plugin-hmr'
import type {} from '@deepseek-ai/dsh-system-prompt'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Harness-home path resolver available to Loader `!!js` config expressions. */
    dshHomePath?: typeof dshHomePath
  }
}

export {
  composeEntries,
  DEFAULT_PROFILE_BUNDLES,
  DEFAULT_PROFILE_PATCH_RELOAD,
  healProfilesModuleFallback,
  initProfile,
  loadProfile,
  loadProfileDirectory,
  PROFILE_PATCH_FILENAME,
  PROFILE_TEMPLATES,
  PROFILES_DIR,
  readProfileManifest,
  resolveBundleDir,
  resolveProfileDir,
  writeProfileManifest,
  type Profile,
  type ProfileLayer,
  type ProfileManifest,
  type ProfileModuleFallbackOptions,
  type ProfileTemplate,
} from './profile.ts'

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

/** Options for live user patch-layer reconciliation. */
export interface UserPatchWatchOptions {
  /** Diagnostic prefix used by {@link loadOptionalPatches}. */
  binName: string
  /** Absolute path of the watched patch file (a profile's `cordis.patch.yml`). */
  filename: string
  /**
   * Compose the full patch list for a fresh user-layer generation —
   * the same composition the app booted with, so a reload can interleave the
   * new user patches between app-owned layers (bundle layers below,
   * overlays above). Identity when omitted: the user layer
   * is the whole patch list.
   */
  compose?: (userPatches: PatchOptions[]) => PatchOptions[]
}

/**
 * Watch the user patch layer through Cordis HMR and transactionally reapply it to the boot include.
 * @param ctx - settled app context containing the root Include and an active HMR service.
 * @param options - diagnostic, file, and patch-composition inputs.
 * @returns an asynchronous disposer after the exact-path watcher is ready.
 * @throws when HMR or the root Include is absent, watcher setup fails, or initial path resolution fails.
 */
export async function watchUserPatches(
  ctx: Context,
  options: UserPatchWatchOptions,
): Promise<() => Promise<void>> {
  const { binName, filename, compose = (patches: PatchOptions[]) => patches } = options
  const hmr = ctx.get('hmr')
  if (hmr === undefined) throw new Error(`${binName}: user patch-layer watching requires the Cordis HMR service`)
  const entry = bootstrapIncludes.get(ctx)
  if (entry === undefined) throw new Error(`${binName}: user patch-layer watching requires the root Include entry`)
  const register = hmr.registerConfig(filename, async () => {
    // Re-read the include's non-patch options per refresh so a writer that
    // updates another option between refreshes is not silently reverted.
    const { patches: _previousPatches, ...includeConfig } = entry.options.config as Include.Config
    const userPatches = loadOptionalPatches(binName, filename) ?? []
    const patches = compose(userPatches)
    await entry.update({
      config: {
        ...includeConfig,
        patches,
      },
    })
  })
  try {
    return await register
  } catch (error) {
    // A surface can dispose the whole tree while the watcher is still opening;
    // the HMR effect registration then fails with INACTIVE_EFFECT. That is the
    // app exiting exactly as asked, not a watch failure, so return a no-op
    // disposer instead of crashing.
    if ((error as { code?: string } | null)?.code === 'INACTIVE_EFFECT') return async () => {}
    throw error
  }
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
 * Compose the effective entry list exactly as `boot()` would mount it: parse
 * the base config file with the include's entry-list dialect, apply every
 * layer's patches as ONE flattened list through the include's own patch
 * algorithm (`applyEntryPatches`) — the same single call `boot()` makes, so
 * even patch-visibility corner cases (a later layer targeting a group child a
 * plain config replacement introduced, which the single-pass id index never
 * sees) compose identically — then render the result as YAML in the same
 * dialect (`!!js` expressions print verbatim, unevaluated).
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
  const provenance: { origin: string; patchedBy: string[] }[] = base.map(() => ({ origin: baseLabel, patchedBy: [] }))
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
      if (index >= before.length) provenance.push({ origin: layer.label, patchedBy: [] })
      else if (JSON.stringify(composed[index]) !== before[index]) provenance[index]?.patchedBy.push(layer.label)
    }
    previous = composed
    previousWarnings = warnings
  }
  return groupedDump(composed, provenance)
}

/** Render the composed rows grouped under one source-and-patches comment per contiguous run. */
function groupedDump(
  composed: readonly unknown[],
  provenance: readonly { origin: string; patchedBy: string[] }[],
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
    const record = provenance[index]
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
 * @returns the created root Include entry, or `undefined` when a surface
 * disposed the whole tree (taking the Loader service with it) while the
 * transactional create was still settling entry lifecycle.
 */
export async function mountRootInclude(
  ctx: Context,
  absoluteConfigPath: string,
  patches: readonly PatchOptions[] = [],
  bareModuleBaseUrl?: string,
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
  const includeConfig: Include.Config = {
    path: pathToFileURL(absoluteConfigPath).href,
    ...patches.length > 0 ? { patches: [...patches] } : {},
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

/**
 * The slice of `process` {@link installFailLoud} needs — injectable so tests
 * exercise the handler without registering on (or exiting) the real process.
 */
export interface FailLoudProcess {
  on(event: 'unhandledRejection', handler: (err: unknown) => void): unknown
  off(event: 'unhandledRejection', handler: (err: unknown) => void): unknown
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
 * Install before boot to turn a late unhandled plugin-init rejection into one
 * labelled stderr diagnostic and `exit(1)`. A rejection already included by
 * {@link assertEntriesActivated} is ignored during its process checkpoint;
 * every other rejection remains fatal. Stdout remains untouched for ACP; the
 * returned function removes the handler.
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
 * @returns the uninstaller that removes the rejection handler.
 */
export function installFailLoud(
  binName: string,
  proc: FailLoudProcess = process,
  release?: () => Promise<void> | void,
): () => void {
  let exiting = false
  const handler = (err: unknown): void => {
    if (assembledActivationRejections.has(err)) return
    // A release in flight already owns the exit. Swallow later rejections
    // (teardown's own included) rather than reporting a second failure over the
    // real one or letting Node kill the process before the terminal is back.
    if (exiting) return
    exiting = true
    proc.stderr.write(`${binName}: fatal load failure: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
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
  const uninstall = (): void => void proc.off('unhandledRejection', handler)
  proc.on('unhandledRejection', handler)
  return uninstall
}

/**
 * After the tree settles, reject entries with no fiber and name every plugin
 * whose module failed to resolve. Disabled entries are the only valid
 * fiber-less state.
 * @param ctx - the settled context whose loader entries to audit.
 * @param binName - the diagnostic prefix on the thrown error.
 */
export function assertEntriesLoaded(ctx: Context, binName: string): void {
  const failed = [...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
  if (failed.length > 0) {
    const names = failed.map(entry => entry.options.name).join(', ')
    throw new Error(`${binName}: plugin(s) failed to load: ${names}; Cordis startup failed because these plugin(s) could not be resolved (see the error(s) logged above)`)
  }
}

/**
 * Value mirrors used because Cordis's const enum has no runtime object to import.
 * Keep aligned with `packages/extensions/tool-cordis/src/fiber-state.ts` and
 * `packages/client/web/src/loader-status.ts`.
 */
const FIBER_PENDING = 0 as FiberState.PENDING
const FIBER_ACTIVE = 2 as FiberState.ACTIVE
const FIBER_FAILED = 3 as FiberState.FAILED

/** Render a thrown plugin value without discarding an Error's original stack. */
function formatActivationError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error)
}

/**
 * Reject a settled Loader tree when an enabled entry failed or remains inactive.
 * Plugin failures include the original thrown stack; pending entries name their
 * unresolved services because no plugin error exists for that state. Active
 * entries require no further wait; only failed fibers are awaited to recover
 * their private rejection reason.
 * @param ctx - the settled context whose Loader entries to audit.
 * @param binName - the diagnostic prefix on the thrown error.
 * @returns nothing when every enabled entry is active.
 * @throws after one process rejection checkpoint when an entry failed to
 * import, rejected during activation, or did not become active.
 */
export async function assertEntriesActivated(ctx: Context, binName: string): Promise<void> {
  assertEntriesLoaded(ctx, binName)
  const failures: string[] = []
  const rejectionReasons: unknown[] = []
  for (const entry of ctx.loader.entries()) {
    const fiber = entry.fiber
    if (fiber === undefined || entry.disabled) continue
    const state = fiber.state
    if (state === FIBER_ACTIVE) continue
    if (state === FIBER_FAILED) {
      try {
        await fiber.await()
      } catch (error) {
        rejectionReasons.push(error)
        failures.push(`${entry.options.name}: ${formatActivationError(error)}`)
      }
      continue
    }
    if (state === FIBER_PENDING) {
      const missing = Object.keys(fiber.inject).filter(service => fiber.ctx.get(service) === undefined)
      const subject = missing.length === 1 ? 'service' : 'services'
      failures.push(`${entry.options.name}: pending (waiting for ${subject}: ${missing.join(', ') || 'unknown'})`)
    } else {
      failures.push(`${entry.options.name}: fiber state ${String(state)}`)
    }
  }
  if (failures.length > 0) {
    if (rejectionReasons.length > 0) {
      await observeLoaderRejectionCheckpoint(rejectionReasons)
    }
    const noun = failures.length === 1 ? 'entry' : 'entries'
    throw new Error(`${binName}: ${String(failures.length)} ${noun} did not activate\n${failures.join('\n')}`)
  }
}

/**
 * Boot the Loader against `absoluteConfigPath` and return only after the whole
 * tree settles. Relative entry names resolve against the config directory;
 * bare package names resolve there by default or against an explicit
 * `bareModuleBaseUrl` for closed packaged runtimes. The bootstrap include
 * is statically imported and mounted as the `cordis:include` builtin, loading
 * through the ambient module pipeline (vite/tsx/plain ESM). The package build
 * embeds Include while leaving Loader external, so the built include tree and
 * host share one Loader peer. Loader
 * settlement rejects startup failures, which `boot` wraps after disposing the
 * partial context; a missing fiber or never-activating entry is rejected by
 * the final audit, {@link assertEntriesActivated}, which rethrows a plugin's
 * init rejection with its original stack; later unhandled rejections remain
 * covered by {@link installFailLoud}. Built bins need the Loader's native
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
 * @returns the root context once every entry has started, or as soon as a
 * surface disposed the tree while startup was still in flight.
 * @throws a labelled error after disposing the partial context — `host
 * preparation failed` when `prepare` threw before any config-tree entry
 * mounted, `plugin tree failed to load` afterwards.
 */
export async function boot(
  binName: string,
  absoluteConfigPath: string,
  patches?: PatchOptions[],
  prepare?: (ctx: Context) => Promise<void> | void,
  bareModuleBaseUrl?: string,
): Promise<Context> {
  const ctx = new Context()
  // Two failure labels: `prepare` runs before any config-tree entry mounts,
  // so its failure is host setup, not the plugin tree.
  let stage = 'host preparation failed'
  try {
    ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + '/'
    ctx.provide('dshHomePath', dshHomePath)
    await ctx.plugin(Loader)
    await prepare?.(ctx)
    stage = 'plugin tree failed to load'
    await mountRootInclude(ctx, absoluteConfigPath, patches, bareModuleBaseUrl)
    // A surface can finish and dispose the whole tree while startup is still
    // in flight, before the last entry settles. The Loader service goes with
    // it, and the activation audit describes a live tree — reading `ctx.loader`
    // past this point would throw a TypeError over an app that exited exactly
    // as asked. Transactional group updates settle
    // lifecycle inside the mount, so the teardown can land before it returns;
    // re-check after every await.
    await ctx.get('loader')?.await()
    if (ctx.get('loader') === undefined) return ctx
    await assertEntriesActivated(ctx, binName)
    return ctx
  } catch (cause) {
    // Root-fiber disposal contains cleanup failures per observer (Cordis
    // fiber.ts hardening) and a repeated call returns the settled single-shot
    // result, so this await cannot reject and replace `cause`.
    await ctx.fiber.dispose()
    const detail = cause instanceof Error ? cause.message : String(cause)
    // The transactional Loader wraps a failing entry apply in one message per
    // tree layer; every layer's message is folded into `detail` above, and the
    // deepest cause is the plugin's own thrown error, whose stack names the
    // real failure site — append it so the startup diagnostic preserves the
    // original activation error instead of only the wrap chain.
    let deepest: unknown = cause
    while (deepest instanceof Error && deepest.cause !== undefined) deepest = deepest.cause
    const stack = deepest instanceof AggregateError
      ? `\n${deepest.stack ?? deepest.message}\n${deepest.errors.map(formatActivationError).join('\n')}`
      : deepest instanceof Error && deepest !== cause ? `\n${deepest.stack ?? deepest.message}` : ''
    throw new Error(`${binName}: ${stage}: ${detail}${stack}`, { cause })
  }
}

/** Prompt-section name for the harness-source location line an app bin adds after boot. */
export const HARNESS_SOURCE_SECTION = 'harness:source'

/**
 * Add a global prompt section naming the on-disk harness source checkout while
 * explicitly distinguishing it from the task workspace and current working
 * directory. The self-referential `dsh-tool-cordis` toolset reads and edits this
 * checkout. Call once on the settled boot context ({@link boot}); the section
 * uses the shared first-party placement after reusable instructions
 * and before the Web surface and persona suffix. A booted tree with no
 * `systemPrompt` service has no prompt to augment, so this is then a no-op
 * that returns `undefined`. The section is
 * registered against the `systemPrompt` service's fiber, so a dev HMR reload of
 * that plugin drops it until the next boot.
 * @param ctx - the settled boot context whose global system prompt to augment.
 * @param sourceRoot - the absolute path to the harness checkout root.
 * @returns the section disposer, or `undefined` when no `systemPrompt` service is mounted.
 */
export function addHarnessSourceSection(ctx: Context, sourceRoot: string): (() => void) | undefined {
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt === undefined) return undefined
  return systemPrompt.section({
    name: HARNESS_SOURCE_SECTION,
    order: systemPrompt.getSectionOrder('HARNESS_SOURCE'),
    text: `The DeepSeek Harness implementation checkout is at ${sourceRoot}. The checkout location and current working directory are separate values and may differ; never infer the working directory from this path. Use pwd to determine the current working directory. Use this checkout only to inspect or extend DSH itself.`,
  })
}
