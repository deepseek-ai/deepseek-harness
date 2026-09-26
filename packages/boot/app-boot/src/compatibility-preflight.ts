/** Compatibility checks at the composition entry points DSH owns; no Loader instrumentation. */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { load } from 'js-yaml'
import { resolvePluginResource } from './package-meta.ts'
import { barePackageName } from './profile-resolution/resolver.ts'
import type {} from './profile-resolution/service.ts'
import type {} from './profile-context.ts'
import { evaluatePluginCompatibility, pluginCompatibilityWarning } from './plugin-compatibility.ts'
import { readProfileCompatibility } from './profile-compatibility.ts'

function readManifest(filename: string): object {
  return JSON.parse(readFileSync(filename, 'utf8')) as object
}

/** Render the patch wording an Include would report, through the profile's logger. */
function patchWarning(ctx: Context): (message: string, ...args: unknown[]) => void {
  return (message, ...args) => {
    let index = 0
    ctx.logger.warn(message.replace(/%C/g, () => JSON.stringify(args[index++])))
  }
}

function manifestOf(ctx: Context, name: string, parentURL: string): object | undefined {
  if (name.startsWith('cordis:')) return undefined
  const specifier = name.startsWith('#') ? resolvePluginResource(name, parentURL) : name
  const packages = ctx.get('pluginPackages')
  const pkg = packages?.packageOf(specifier, parentURL)
  if (pkg !== undefined) return readManifest(pkg.manifestPath)
  const bare = barePackageName(specifier)
  if (bare !== undefined && packages === undefined) {
    // An embedder without the package service falls back to Node's own lookup, as `packageDirFromParent` does.
    for (const path of createRequire(parentURL).resolve.paths(bare) as string[]) {
      const filename = join(path, bare, 'package.json')
      if (existsSync(filename)) return readManifest(filename)
    }
  }
  if (!isAbsolute(specifier) && !specifier.startsWith('.') && !specifier.startsWith('file:')) return undefined
  const url = isAbsolute(specifier) ? pathToFileURL(specifier) : new URL(specifier, parentURL)
  let dir: string
  try { dir = dirname(realpathSync(fileURLToPath(url))) }
  catch (error) {
    // A row this profile cannot resolve is the Loader's import failure to report, not a compatibility decision.
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(String((error as NodeJS.ErrnoException).code))) return undefined
    throw error
  }
  while (true) {
    try { return readManifest(join(dir, 'package.json')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(dir)
      if (parent === dir) return undefined
      dir = parent
    }
  }
}

/** Prepare profile or preset rows before the owning DSH caller passes them to Loader.
 * Only a compatibility conflict denies a row: an entry whose manifest cannot be resolved keeps
 * the Loader's own import failure. A denied ordinary row gains `disabled`; a native Include that
 * reaches a denied plugin is denied as a whole, because its file is never rewritten.
 * @param ctx Context carrying launcher-owned profile facts; non-profile contexts retain their rows.
 * @param entries Complete effective entry list, after patch composition.
 * @param parentURL Resolution base of the tree that will import these rows.
 * @param binName Diagnostic prefix for a denied row; defaults to `dsh`.
 * @returns Detached rows with incompatible entries denied; reads the profile compatibility file once.
 * @throws For malformed compatibility permissions or a profile composition without a resolution base.
 */
export function prepareProfileEntries(
  ctx: Context, entries: readonly EntryOptions[], parentURL: string | undefined, binName = 'dsh',
): EntryOptions[] {
  // Admission runs before the composed tree mounts, so no plugin-owned logger exporter exists yet;
  // composition-stage diagnostics go to stderr like the profile launcher's skipped-bundle report.
  return preflight(ctx, entries, parentURL, (row, reason) => {
    // Preset rows may omit ids, and a bundle row's name is its resolved module URL.
    const label = typeof row.id === 'string' ? `row ${JSON.stringify(row.id)}` : row.name
    process.stderr.write(`${binName}: disabling profile plugin ${label}: ${reason}\n`)
  }).rows
}

/** Denial reporter invoked once per denied row. */
type DenialReporter = (row: EntryOptions, reason: string) => void

function preflight(
  ctx: Context, entries: readonly EntryOptions[], parentURL: string | undefined, report: DenialReporter,
) {
  const rows = structuredClone(entries) as EntryOptions[]
  const profile = ctx.get('profileContext')
  if (profile === undefined) return { rows, blocked: false }
  if (parentURL === undefined) throw new Error('Profile compatibility preflight requires a resolution base')
  // A damaged permission file authorizes nothing, but it must not stop the profile from starting.
  const { exemptions, warnings } = readProfileCompatibility(profile.dir)
  for (const warning of warnings) process.stderr.write(`${warning}\n`)
  const includes = new Set<string>()
  /** Only a compatibility conflict denies a row; every other failure keeps the Loader's own diagnosis. */
  const denial = (row: EntryOptions, base: string): string | undefined => {
    try {
      const manifest = manifestOf(ctx, row.name, base)
      if (manifest === undefined) return undefined
      const issue = evaluatePluginCompatibility(manifest, exemptions)
      return issue === undefined || issue.exempted ? undefined : pluginCompatibilityWarning(issue)
    } catch (error) {
      // Peer metadata that cannot be read or validated is refused rather than silently admitted.
      /* v8 ignore next -- every reader and parser used here rejects with an Error. */
      const detail = error instanceof Error ? error.message : String(error)
      return `its declared peer dependencies cannot be validated: ${detail}`
    }
  }
  const deny = (row: EntryOptions, reason: string): void => {
    row.disabled = true
    if (row.group) row.group = false
    report(row, reason)
  }
  const check = (rows: EntryOptions[], base: string): boolean => {
    let blocked = false
    for (const row of rows) {
      if (row.disabled === true && !row.group) continue
      const conflict = denial(row, base)
      if (conflict !== undefined) {
        deny(row, conflict)
        blocked = true
        continue
      }
      // The `group` marker, not the module name, is what makes a row another tree carrier.
      if ((row.group === true || row.name === 'cordis:group' || row.name === '@deepseek-ai/cordis-plugin-group')
        && Array.isArray(row.config) && check(row.config as EntryOptions[], base)) blocked = true
      if (row.name !== 'cordis:include' && row.name !== '@deepseek-ai/cordis-plugin-include') continue
      const reached = includedConflicts(row, base)
      if (reached !== undefined) {
        deny(row, reached)
        blocked = true
      }
    }
    return blocked
  }
  /** Whether a native Include reaches a denied plugin; an unreadable one has no compatibility opinion. */
  const includedConflicts = (row: EntryOptions, base: string): string | undefined => {
    const config = row.config as { path?: unknown; patches?: PatchOptions[]; initial?: EntryOptions[] } | undefined
    if (typeof config?.path !== 'string' || !['.yml', '.yaml', '.json'].includes(extname(config.path))) {
      // A dynamic Include is resolved by the Include plugin itself; this walk cannot judge its rows.
      return undefined
    }
    const requested = isAbsolute(config.path) ? config.path : fileURLToPath(new URL(config.path, base))
    const filename = existsSync(requested) ? realpathSync(requested) : requested
    if (includes.has(filename)) return undefined
    includes.add(filename)
    try {
      let data: unknown
      try { data = load(readFileSync(filename, 'utf8'), { schema: entryListSchema }) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || config.initial === undefined) return undefined
        data = config.initial
      }
      if (!Array.isArray(data)) return undefined
      const children = applyEntryPatches(data as EntryOptions[], config.patches, patchWarning(ctx))
      return check(children, pathToFileURL(filename).href)
        ? `its included file ${filename} reaches an incompatible plugin, and that file is never rewritten`
        : undefined
    } finally {
      includes.delete(filename)
    }
  }
  return { rows, blocked: check(rows, parentURL) }
}

/** Apply compatibility policy to the complete patch composition over a profile's empty root.
 * The caller passes every patch layer of the profile, because this returns one insertion patch for
 * that empty root: a non-empty root config would lose the caller's override patches by id.
 * @param ctx Profile context prepared by the launcher.
 * @param patches Original ordered profile patches; these remain unchanged.
 * @param parentURL Root Include's resolution base.
 * @param binName Diagnostic prefix for a denied row; defaults to `dsh`.
 * @returns One prepared insertion patch for profiles, or the original patches for non-profile callers.
 */
export function prepareProfilePatches(
  ctx: Context, patches: PatchOptions[], parentURL: string, binName = 'dsh',
): PatchOptions[] {
  if (ctx.get('profileContext') === undefined) return patches
  const entries = applyEntryPatches([], patches, patchWarning(ctx))
  const rows = prepareProfileEntries(ctx, entries, parentURL, binName)
  return rows.length === 0 ? [] : [{ insert: rows }]
}
