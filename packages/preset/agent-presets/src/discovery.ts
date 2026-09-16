/**
 * Filesystem discovery of agent presets. A preset is a directory holding
 * {@link COMPOSITION_FILE}, optionally beside a {@link METADATA_FILE} carrying
 * its display text; the directory name is the preset id. Discovery
 * re-reads the roots on every call so a preset authored while the process is
 * running is visible without a restart.
 *
 * Discovery also owns preset HEALTH: a directory whose composition is
 * missing or unloadable is reported as a broken roster row rather than
 * skipped. A skipped directory would still occupy its id on disk — the copy
 * path refuses the name while no surface shows anything to delete — and a
 * malformed composition would otherwise read as an ordinary preset until the
 * first session fails to mount it.
 *
 * Health is what every consumer reads before offering a preset — the pickers
 * drop a broken row rather than defer the discovery to a failed session
 * start — so it covers the way an authored preset actually rots: a row naming
 * a package that was renamed or uninstalled. Resolving those names is a
 * separate pass from the shape check and stops short of importing anything,
 * so a composition is judged without running a line of plugin code.
 * @module @deepseek-ai/dsh-agent-presets/discovery
 */

import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { load } from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { readPresetMetadata } from './metadata.ts'
import { PRESET_ID, type AgentPreset, type PresetRoot } from './preset.ts'
import { classifyRowSpecifier, type RowSpecifier } from './specifier.ts'

/** The composition file that makes a directory a preset. */
export const COMPOSITION_FILE = 'agent.cordis.yml'

/**
 * Harness-home directory holding locally authored presets.
 *
 * This package owns the writable root the way `dsh-skill-filesystem` owns
 * `<dshHome>/skills`: where a person's own presets go is the same place in
 * every deployment that does not say otherwise, so a launcher that forgets to
 * configure one still finds them.
 *
 * Package-internal on purpose: no consumer outside this package addresses the
 * directory by name, and a test that imported it could not catch this value
 * being wrong — the expected segment is spelled out where it is asserted.
 */
export const USER_PRESET_DIR = '.agent-presets'

/**
 * The shipped presets, bundled inside this package: the roster's built-in
 * compositions travel with the machinery that mounts them, the way each
 * preset's own skills travel inside its directory. Resolved relative to this
 * module so both launch layouts work — `src/` under tsx and the bundled
 * `lib/` sit one level below the package root.
 */
export const SHIPPED_PRESET_ROOT = fileURLToPath(new URL('../presets/', import.meta.url))

/**
 * Why `rows` cannot be an entry list, or undefined when it can.
 *
 * A shallow shape check, deliberately short of the loader's work: it does not
 * resolve plugin names or apply configs. What it catches is the hand-edit
 * that produces a file the loader cannot even begin with — and it must accept
 * everything the loader accepts, which is why rows are only required to be
 * maps carrying a plugin `name` (groups recurse into their own lists).
 *
 * Shared with the composition inventory, whose file reads race edits against
 * the health verdict and must judge the raced content by the same rule.
 * @param rows - the parsed composition document.
 * @param at - row-path prefix for nested diagnostics, empty at the top level.
 * @returns one human-readable reason, or undefined when the shape holds.
 */
export function entryListProblem(rows: unknown, at = ''): string | undefined {
  if (!Array.isArray(rows)) {
    return at === ''
      ? 'the composition must be a top-level list of plugin rows'
      : `group ${at} must hold a list of plugin rows`
  }
  for (const [index, row] of rows.entries()) {
    const label = at === '' ? `row ${String(index + 1)}` : `${at} row ${String(index + 1)}`
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      return `${label} is not a plugin row (expected a map with a "name")`
    }
    const { name, group, config } = row as { name?: unknown; group?: unknown; config?: unknown }
    if (typeof name !== 'string' || name === '') {
      return `${label} names no plugin (a "name" string is required)`
    }
    if (group === true) {
      const nested = entryListProblem(config, label)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** Package lookup injected into preset discovery. */
type PackageResolves = (specifier: string, base: string) => boolean

/**
 * Whether a package specifier is installed above `base` without importing it.
 *
 * The direct disk walk accepts unexported subpaths and rejects stale links
 * whose package directory no longer exists.
 * @param name - package specifier, possibly carrying a subpath.
 * @param base - directory URL whose ancestors contain candidate `node_modules` directories.
 * @returns true when the package is installed.
 */
function packageInstalled(name: string, base: string): boolean {
  const pkg = name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/')
  let dir = fileURLToPath(base)
  for (;;) {
    if (existsSync(join(dir, 'node_modules', pkg, 'package.json'))) return true
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

/**
 * Whether one classified row names a module that exists, importing nothing.
 *
 * Package rows delegate to the injected lookup. Relative and `file:` rows use
 * file metadata. No check evaluates the named module.
 * @param row - the classified specifier, from {@link classifyRowSpecifier}.
 * @param presetBase - directory URL a preset-relative specifier resolves against.
 * @param harnessBase - base URL a package name resolves against.
 * @param resolves - package lookup selected by the owning caller.
 * @returns true when the row names something that can be imported.
 */
async function rowResolves(
  row: RowSpecifier, presetBase: string, harnessBase: string, resolves: PackageResolves,
): Promise<boolean> {
  if (row.kind === 'builtin') return true
  if (row.kind === 'package') return isBuiltin(row.specifier) || resolves(row.specifier, harnessBase)
  const url = row.kind === 'file' ? new URL(row.specifier) : new URL(row.specifier, presetBase)
  return await isFile(fileURLToPath(url))
}

/** One row that names a module no resolver can find. */
interface UnresolvableRow {
  /** `row "id"`, or the row's position when it declares none. */
  readonly label: string
  /** The specifier exactly as the row wrote it. */
  readonly name: string
}

/**
 * Rows whose module cannot be resolved.
 *
 * Only rows that will certainly be started are checked, and the test is the
 * Loader's own: it starts a row when `Boolean(options.disabled)` is false, so
 * `disabled: 0` names a row that DOES start and must be checked. A `!!js`
 * expression is an object and therefore truthy, which skips exactly the rows
 * whose value only the loader context can decide. Skipping those trades a
 * missed name for the failure that matters more: calling a usable preset
 * broken makes it unselectable and uncopyable, which is worse than reporting
 * the same stale row at mount time as before.
 *
 * Shape is the caller's precondition: {@link entryListProblem} has already
 * proven every row is a map carrying a `name` string, and groups recurse the
 * same way it does.
 * @param rows - the parsed composition rows.
 * @param presetBase - directory URL a preset-relative specifier resolves against.
 * @param harnessBase - base URL a package name resolves against.
 * @param at - row-path prefix for nested diagnostics, empty at the top level.
 * @returns one entry per unresolvable row, in composition order.
 */
async function unresolvableRows(
  rows: readonly unknown[],
  presetBase: string,
  harnessBase: string,
  resolves: PackageResolves,
  at = '',
): Promise<UnresolvableRow[]> {
  const found: UnresolvableRow[] = []
  for (const [index, entry] of rows.entries()) {
    const row = entry as { id?: unknown; name: string; group?: unknown; config?: unknown; disabled?: unknown }
    if (Boolean(row.disabled)) continue
    const positional = at === '' ? `row ${String(index + 1)}` : `${at} row ${String(index + 1)}`
    if (row.group === true) {
      found.push(...await unresolvableRows(row.config as readonly unknown[], presetBase, harnessBase, resolves, positional))
      continue
    }
    if (await rowResolves(classifyRowSpecifier(row.name), presetBase, harnessBase, resolves)) continue
    const label = typeof row.id === 'string' && row.id !== '' ? `row "${row.id}"` : positional
    found.push({ label, name: row.name })
  }
  return found
}

/**
 * Why the composition at `path` cannot mount, or undefined when it looks
 * loadable. Parsed with the loader's own YAML dialect ({@link entryListSchema},
 * the one carrying `!!js`), so health can never call a composition broken
 * that the loader would accept.
 * A package-lookup failure becomes this composition's broken reason, so one
 * preset cannot abort discovery of the rest of the roster.
 * @param path - absolute path of the composition file.
 * @param harnessBase - base URL a row's package name resolves against.
 * @returns one human-readable reason, or undefined when the file is loadable.
 */
async function compositionProblem(
  path: string, harnessBase: string, resolves: PackageResolves,
): Promise<string | undefined> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch {
    // The caller statted this file moments ago; any read failure now —
    // deleted in between, permissions — is the same answer as unparsable.
    return `the composition file ${COMPOSITION_FILE} cannot be read`
  }
  let rows: unknown
  try {
    rows = load(content, { schema: entryListSchema })
  } catch (error) {
    /* v8 ignore next -- js-yaml throws YAMLException (an Error) for every parse failure; the fallback keeps a hostile value readable */
    const full = error instanceof Error ? error.message : String(error)
    // First line only: js-yaml appends a multi-line code-frame snippet, and
    // the reason is displayed on a roster card, not in a terminal.
    return `the composition is not valid YAML: ${full.replace(/\n[\s\S]*$/, '')}`
  }
  const shape = entryListProblem(rows)
  if (shape !== undefined) return shape
  // The composition's own directory, exactly as `Include` derives it, so a
  // row naming a file the preset ships resolves the way the mount will.
  const presetBase = new URL('.', pathToFileURL(path)).href
  let unresolvable: UnresolvableRow[]
  try {
    unresolvable = await unresolvableRows(rows as readonly unknown[], presetBase, harnessBase, resolves)
  } catch (error) {
    const full = error instanceof Error ? error.message : String(error)
    return `the composition's plugins cannot be checked: ${full.replace(/\n[\s\S]*$/, '')}`
  }
  const [first] = unresolvable
  if (first === undefined) return undefined
  if (unresolvable.length === 1) {
    return `${first.label} names a plugin that cannot be resolved: ${first.name}`
  }
  return `${String(unresolvable.length)} rows name plugins that cannot be resolved:\n`
    + unresolvable.map(row => `- ${row.label}: ${row.name}`).join('\n')
}

/**
 * Whether `path` names an existing regular file.
 * @param path - absolute path to test.
 * @returns true when the path resolves to a file.
 */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    // Any stat failure — absent, unreadable, a dangling link — means this
    // directory does not present a composition, which is not an error: the
    // directory simply is not a preset.
    return false
  }
}

/**
 * Scan one root for preset directories.
 *
 * An absent root yields no presets rather than throwing: the user root does
 * not exist until the first locally authored preset, and naming a default
 * that no root supplies already fails loud at resolution.
 *
 * Every directory whose name is a usable preset id is a roster row — broken
 * when its composition is missing or unloadable. A directory named outside
 * {@link PRESET_ID} is skipped instead: no copy could ever claim that name,
 * so it blocks nothing, and reporting `.DS_Store`-grade residue as broken
 * presets would teach users to ignore the marker.
 * @param root - the directory and the trust its presets inherit.
 * @param harnessBase - base URL a row's package name resolves against; the
 * caller's own `ctx.baseUrl`, which is where the installed harness lives.
 * @param resolves - package-presence lookup for the active runtime.
 * @returns the root's presets ordered by id.
 */
export async function scanRoot(
  root: PresetRoot, harnessBase: string, resolves: PackageResolves = packageInstalled,
): Promise<AgentPreset[]> {
  const dir = resolve(expandHomePath(root.path))
  let children
  try {
    children = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error(`agent-presets: cannot read preset root ${dir}: ${String(error)}`, { cause: error })
  }
  const found: AgentPreset[] = []
  for (const child of children) {
    if (!child.isDirectory() || !PRESET_ID.test(child.name)) continue
    const directory = join(dir, child.name)
    const path = join(directory, COMPOSITION_FILE)
    const broken = await isFile(path)
      ? await compositionProblem(path, harnessBase, resolves)
      : `the composition file ${COMPOSITION_FILE} is missing — the directory still occupies the id; delete it or restore the file`
    // Display text only, and never fatal: a preset with unreadable metadata
    // still mounts, it just shows its id.
    const metadata = await readPresetMetadata(directory)
    found.push({
      id: child.name, trust: root.trust, path, ...metadata,
      ...broken === undefined ? {} : { broken },
    })
  }
  // Declared order first so the shipped set reads by capability; everything
  // else falls back to the id, which keeps authored presets stable.
  return found.sort((left, right) => {
    const byOrder = (left.order ?? Number.POSITIVE_INFINITY) - (right.order ?? Number.POSITIVE_INFINITY)
    return byOrder === 0 ? left.id.localeCompare(right.id) : byOrder
  })
}

/**
 * Scan every root in precedence order.
 * @param roots - roots in precedence order; an earlier root wins a duplicate id.
 * @param harnessBase - base URL a row's package name resolves against.
 * @param resolves - package-presence lookup for the active runtime.
 * @returns every discovered preset, first-root-wins per id.
 */
export async function discoverPresets(
  roots: readonly PresetRoot[],
  harnessBase: string,
  resolves: PackageResolves = packageInstalled,
): Promise<AgentPreset[]> {
  const byId = new Map<string, AgentPreset>()
  for (const root of roots) {
    for (const preset of await scanRoot(root, harnessBase, resolves)) {
      if (byId.has(preset.id)) continue
      byId.set(preset.id, preset)
    }
  }
  return [...byId.values()]
}
