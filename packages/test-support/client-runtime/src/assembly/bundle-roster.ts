/**
 * The browser roster of a `dsh --profile`, read from its bundle patch files
 * the way the launcher composes them: each bundle's `dsh.bundle.patch` file list is
 * parsed with the include plugin's YAML dialect (`entryListSchema`) and
 * composed by its `applyEntryPatches`; every enabled row whose package
 * declares `dsh.client.platform === 'web'` becomes a roster row carrying that
 * declaration's `inject` and `immediately`; rows nested in Loader groups count
 * like the Loader counts them, a disabled group disabling every row beneath
 * it. A patch that matches nothing
 * throws here where the launcher warns. Nothing is copied from the bundles: a
 * bundle change is visible at the next import. Node only — the
 * whole-client tier runs under vitest, and this is the one place it reads the
 * repository.
 * @module @deepseek-ai/dsh-client-test-runtime/src/assembly/bundle-roster
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, isJsExpr, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { exactPackageSpecifier, parseDshClient } from '@deepseek-ai/dsh-client-modules/client'
import * as yaml from 'js-yaml'
import { ClientRoster, type ClientRosterRow } from './roster.ts'

/** The `web` profile's bundle layers, in the order `dsh --profile web` applies them (app-boot `PROFILE_TEMPLATES.web`). */
export const WEB_PROFILE_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

interface PackageManifest {
  name?: unknown
  dsh?: { bundle?: { patch?: unknown }; client?: unknown }
}

/** One bundle: where its package.json is (plugin names resolve from there) and its parsed patch list. */
interface BundleLayer {
  readonly manifestPath: string
  readonly patches: PatchOptions[]
}

/**
 * Compose the browser roster of `bundles`, applied in order.
 * @param bundles - bundle package names in application order.
 * @param anchor - file whose package resolution locates the bundles; default this package.
 * @param disabledContext - optional Loader evaluation scope for trusted `disabled` expressions.
 * @returns the roster in composition order, one row per package.
 * @throws {Error} when a bundle, its patch file, or an enabled row's package does not resolve, when the patch list
 * is not a list or does not apply as written, or when a browser row has an unevaluated `disabled` expression.
 */
export function bundleRoster(
  bundles: readonly string[],
  anchor: string = fileURLToPath(import.meta.url),
  disabledContext?: object,
): ClientRoster {
  const layers = bundles.map(name => readLayer(name, anchor))
  const entries = applyEntryPatches([], layers.flatMap(layer => layer.patches), (message: string, ...args: unknown[]) => {
    throw new Error(`client-test-runtime: bundle patch ${describe(message, args)}`)
  })
  const anchors = layers.map(layer => layer.manifestPath)
  const rows: ClientRosterRow[] = []
  const seen = new Set<string>()
  for (const { entry, disabled } of flattenGroups(entries)) {
    const name = exactPackageSpecifier(entry.name)
    if (name === undefined || disabled.includes(true) || seen.has(name)) continue
    if (disabledContext !== undefined
      && disabled.some(value => isJsExpr(value) && Boolean(evaluate(disabledContext, value.__jsExpr)))) continue
    seen.add(name)
    const manifestPath = locateManifest(anchors, name)
    if (manifestPath === undefined) {
      throw new Error(`client-test-runtime: cannot resolve plugin package ${name} from ${bundles.join(', ')}`)
    }
    const manifest = readManifest(manifestPath)
    if (manifest.name !== name) {
      throw new Error(`client-test-runtime: ${manifestPath} names ${JSON.stringify(manifest.name)}, expected ${name}`)
    }
    const declaration = parseDshClient(name, manifest.dsh?.client)
    if (declaration === undefined || declaration.platform !== 'web') continue
    if (disabled.some(value => value !== undefined && value !== null && typeof value !== 'boolean'
      && !(disabledContext !== undefined && isJsExpr(value)))) {
      throw new Error(`client-test-runtime: browser row ${name} has a \`disabled\` value this reader cannot evaluate (a !!js expression)`)
    }
    rows.push({ name, inject: declaration.inject ?? [], immediately: declaration.immediately === true })
  }
  return ClientRoster.of(rows)
}

function readLayer(bundle: string, anchor: string): BundleLayer {
  const manifestPath = locateManifest([anchor], bundle)
  if (manifestPath === undefined) throw new Error(`client-test-runtime: cannot resolve bundle ${bundle} from ${anchor}`)
  const declared = readManifest(manifestPath).dsh?.bundle?.patch
  const files = typeof declared === 'string' ? [declared] : declared
  if (!Array.isArray(files) || !files.every(file => typeof file === 'string')) {
    throw new Error(`client-test-runtime: bundle ${bundle} declares no dsh.bundle.patch file list in ${manifestPath}`)
  }
  const patches = files.flatMap((patch) => {
    const file = join(dirname(manifestPath), patch)
    const parsed: unknown = yaml.load(readFileSync(file, 'utf8'), { schema: entryListSchema })
    if (!Array.isArray(parsed)) throw new Error(`client-test-runtime: ${file} must be a top-level list of patches`)
    return parsed as PatchOptions[]
  })
  return { manifestPath, patches }
}

/** One Loader row with its ancestor and own disable conditions, in outer-to-inner order. */
interface FlatEntry {
  readonly entry: EntryOptions
  readonly disabled: readonly unknown[]
}

/**
 * Rows in Loader order with groups descended, as the Loader loads them: a group is never a plugin itself, and a group's
 * `disabled` disables every row beneath it.
 * @param entries - composed entries, possibly nested.
 * @param inherited - the enclosing groups' disable conditions.
 * @returns the plugin rows.
 */
function flattenGroups(entries: readonly EntryOptions[], inherited: readonly unknown[] = []): FlatEntry[] {
  const rows: FlatEntry[] = []
  for (const entry of entries) {
    const disabled = [...inherited, (entry as { disabled?: unknown }).disabled]
    if (entry.group === true && Array.isArray(entry.config)) {
      rows.push(...flattenGroups(entry.config as EntryOptions[], disabled))
      continue
    }
    rows.push({ entry, disabled })
  }
  return rows
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
}

/** Resolve package manifests to real paths so linked bundles use their own dependency directories. */
function locateManifest(anchors: readonly string[], name: string): string | undefined {
  const paths = anchors.map(anchor => createRequire(anchor).resolve.paths(name) ?? [])
  for (let depth = 0; depth < Math.max(...paths.map(search => search.length)); depth++) {
    for (const search of paths) {
      const directory = search[depth]
      if (directory === undefined) continue
      const candidate = join(directory, name, 'package.json')
      if (existsSync(candidate)) return realpathSync(candidate)
    }
  }
  return undefined
}

/** The include plugin's `%C` placeholders, filled the way the launcher prints them. */
function describe(message: string, args: readonly unknown[]): string {
  let index = 0
  return message.replace(/%C/g, () => JSON.stringify(args[index++]))
}

const webProfileServices: Readonly<Record<string, object | undefined>> = { profileContext: { name: 'web' } }

/** The `web` profile's browser roster, composed with its profile name and no business Host services. */
export const webApp: ClientRoster = bundleRoster(WEB_PROFILE_BUNDLES, undefined, {
  get: (name: string) => webProfileServices[name],
})
