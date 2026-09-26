/** Boot-free inspection of declared plugin Config schemas using profile module resolution. */

import { readFile, realpath } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as yaml from 'js-yaml'
import Loader, { EntryGroup, ModuleLoader, isJsExpr, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import Include, { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { Profile, RuntimeResolution } from '../profile.ts'
import { installRuntimeInterception } from '../profile-resolution/resolver.ts'
import { buildConfigSchemaDocument } from './document.ts'
import type { CollectedConfigEntry, ConfigSchemaDiagnostic, ConfigSchemaDump } from './types.ts'
import { isNativeConfigSchema } from './native.ts'

interface ParsedEntry {
  id?: string
  name: string
  config?: unknown
  group?: boolean | null
  disabled?: unknown
}

function objectLike(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function configOf(plugin: unknown): unknown {
  return objectLike(plugin) ? Reflect.get(plugin, 'Config') : undefined
}

function validateMetadata(row: object): void {
  for (const key of ['id', 'name']) {
    const value: unknown = Reflect.get(row, key)
    if (value !== undefined && typeof value !== 'string') throw new Error(`${key} must be a literal string`)
  }
  const group: unknown = Reflect.get(row, 'group')
  if (group !== undefined && group !== null && typeof group !== 'boolean') throw new Error('group must be a literal boolean or null')
}

function validateEntry(value: unknown): asserts value is ParsedEntry {
  if (!record(value) || typeof value.name !== 'string') throw new Error('each entry must be a mapping with a literal plugin name')
  validateMetadata(value)
}

function entryList(value: unknown): unknown[] {
  if (value === undefined) throw new Error('entry list config is missing')
  if (!Array.isArray(value)) throw new Error('expected a literal entry list; config expressions are not evaluated')
  return value as unknown[]
}

function includePatches(value: unknown): PatchOptions[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('include patches must be a literal patch list; config expressions are not evaluated')
  for (const patch of value as unknown[]) {
    if (!record(patch) || isJsExpr(patch)) throw new Error('include patches must be literal mappings; config expressions are not evaluated')
    validateMetadata(patch)
    if (patch.insert !== undefined) entryList(patch.insert)
  }
  return value as PatchOptions[]
}

/**
 * Generate JSON Schema from parsed entry rows and root-tree patches without applying plugins or evaluating expressions.
 * Imports, Config getters, and lazy schema builders execute trusted plugin code; transform callbacks do not. Calls must not overlap
 * another profile-resolution interception; module imports remain cached after the interception is released.
 * @param profile - prepared profile whose directory anchors root module and include resolution.
 * @param entries - unvalidated rows from profile composition; malformed rows become positioned diagnostics without losing siblings.
 * @param resolution - the same immutable package resolution used for profile boot.
 * @param diagnostics - existing composition diagnostics; copied into the returned catalog.
 * @returns a JSON Schema document with partial-result diagnostics and Config references under `x-cordis`.
 * @throws when Node's profile module resolution cannot be installed.
 */
export async function collectConfigSchemas(
  profile: Profile,
  entries: readonly unknown[],
  resolution: RuntimeResolution,
  diagnostics: readonly ConfigSchemaDiagnostic[] = [],
): Promise<ConfigSchemaDump> {
  const result: { entries: CollectedConfigEntry[]; diagnostics: ConfigSchemaDiagnostic[] } = {
    entries: [], diagnostics: [...diagnostics],
  }
  const byOptions = new Map<object, CollectedConfigEntry>()
  const interception = installRuntimeInterception(resolution)
  try {
    const loader = ModuleLoader.fromInternal()
    if (loader === undefined) throw new Error('config schema dump requires the Node module loader used by profile resolution')
    const builtins: Record<string, unknown> = { group: Group, include: Include }
    const nativeCarriers = new Map<string, Promise<{ group: unknown; include: unknown }>>()
    const carrier = async (plugin: unknown, baseUrl: string): Promise<'group' | 'include' | undefined> => {
      if (plugin === Group) return 'group'
      if (plugin === Include) return 'include'
      if (!objectLike(plugin) || !Reflect.get(plugin, EntryGroup.key)) return undefined
      let resolved = nativeCarriers.get(baseUrl)
      if (resolved === undefined) {
        // Include may be bundled into app-boot; compare against the native packages resolved for this tree as well.
        resolved = Promise.allSettled([
          loader.import('@deepseek-ai/cordis-plugin-group', baseUrl, {}),
          loader.import('@deepseek-ai/cordis-plugin-include', baseUrl, {}),
        ]).then(([group, include]) => {
          const groupPlugin: unknown = group.status === 'fulfilled' ? Loader.prototype.unwrapExports(group.value) : undefined
          const includePlugin: unknown = include.status === 'fulfilled' ? Loader.prototype.unwrapExports(include.value) : undefined
          return { group: groupPlugin, include: includePlugin }
        })
        nativeCarriers.set(baseUrl, resolved)
      }
      const native = await resolved
      if (plugin === native.group) return 'group'
      if (plugin === native.include) return 'include'
      throw new Error('unrecognized Loader tree carrier; use cordis:group or cordis:include for native child collection')
    }
    const ancestors = new Set<string>()
    const report = (path: string, error: unknown): void => {
      result.diagnostics.push({ level: 'error', path, message: error instanceof Error ? error.message : String(error) })
    }
    const warn = (path: string) => (message: string, ...args: unknown[]): void => {
      let index = 0
      result.diagnostics.push({ level: 'warning', path, message: message.replace(/%C/g, () => JSON.stringify(args[index++])) })
    }

    const walkInclude = async (config: unknown, baseUrl: string, path: string): Promise<void> => {
      if (config === undefined) throw new Error('include config is missing')
      if (!record(config) || isJsExpr(config)) throw new Error('include config must be literal; config expressions are not evaluated')
      if (typeof config.path !== 'string') throw new Error('include path must be literal; config expressions are not evaluated')
      const filename = fileURLToPath(new URL(config.path, baseUrl))
      const extension = extname(filename)
      if (!['.json', '.yaml', '.yml'].includes(extension)) throw new Error(`include extension ${JSON.stringify(extension)} is not supported`)
      let source: unknown
      let canonical: string
      try {
        canonical = await realpath(filename)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        canonical = filename
      }
      if (ancestors.has(canonical)) throw new Error(`include cycle at ${filename}`)
      let content: string | undefined
      try {
        content = await readFile(filename, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        source = config.initial
        if (source === undefined) throw new Error(`include file not found: ${filename}`)
      }
      if (content !== undefined) {
        try {
          source = extension === '.json' ? JSON.parse(content) : yaml.load(content, { schema: entryListSchema })
        } catch (error) {
          // Parser messages can quote configuration values; retain only the file and location.
          const at = error instanceof yaml.YAMLException ? ` at line ${error.mark.line + 1}, column ${error.mark.column + 1}` : ''
          throw new Error(`invalid ${extension === '.json' ? 'JSON' : 'YAML'} include ${filename}${at}`)
        }
      }
      const patches = includePatches(config.patches)
      const rows = entryList(source)
      let children: EntryOptions[]
      try {
        children = applyEntryPatches(rows as EntryOptions[], patches, warn(path))
      } catch (error) {
        throw new Error(`include patches could not be composed for ${filename}; child declarations are unavailable`, { cause: error })
      }
      ancestors.add(canonical)
      try {
        await walk(children, new URL('.', pathToFileURL(filename)).href, `${path}/include`)
      } finally {
        ancestors.delete(canonical)
      }
    }

    const walk = async (rows: readonly unknown[], baseUrl: string, prefix: string): Promise<void> => {
      for (const [index, value] of rows.entries()) {
        const path = `${prefix}/${index}`
        const identity = record(value) ? value : undefined
        const entry: CollectedConfigEntry = {
          path,
          ...(typeof identity?.id === 'string' ? { id: identity.id } : {}),
          ...(typeof identity?.name === 'string' ? { name: identity.name } : {}),
          status: 'error',
        }
        result.entries.push(entry)
        const row = value
        try {
          validateEntry(row)
        } catch (error) {
          report(path, error)
          continue
        }
        entry.status = 'absent'
        byOptions.set(row, entry)
        let plugin: unknown
        try {
          let exports: unknown
          if (row.name.startsWith('cordis:')) {
            const name = row.name.slice(7)
            if (!Object.hasOwn(builtins, name)) throw new Error(`unknown Cordis builtin ${JSON.stringify(row.name)}`)
            exports = builtins[name]
          } else exports = await loader.import(row.name, baseUrl, {})
          plugin = Loader.prototype.unwrapExports(exports)
          const schema = configOf(plugin)
          if (schema !== undefined && schema !== null) {
            if (!isNativeConfigSchema(schema)) {
              entry.status = 'unsupported'
              report(path, 'Config is not a native Schemastery schema')
            } else {
              entry.status = 'schema'
              entry.native = schema
            }
          }
        } catch (error) {
          entry.status = 'error'
          report(path, error)
        }
        try {
          const kind = await carrier(plugin, baseUrl)
          if (kind === undefined) continue
          entry.tree = kind
          // The Loader never initializes a disabled carrier unless group: true forces it, so a missing config declares no children.
          if (row.config === undefined && row.group !== true && (row.disabled === true || isJsExpr(row.disabled))) continue
          if (kind === 'group') await walk(entryList(row.config), baseUrl, `${path}/config`)
          else await walkInclude(row.config, baseUrl, path)
        } catch (error) {
          report(path, error)
        }
      }
    }

    await walk(entries, pathToFileURL(join(profile.dir, 'cordis.yml')).href, '')
    const targets = new Map<string, CollectedConfigEntry>()
    const indexTargets = (rows: readonly unknown[]): void => {
      for (const row of rows) {
        if (!record(row)) continue
        if (typeof row.id === 'string' && row.id) {
          const entry = byOptions.get(row)
          if (entry) targets.set(row.id, entry)
          else targets.delete(row.id)
        }
        if (row.group && Array.isArray(row.config)) indexTargets(row.config)
      }
    }
    indexTargets(entries)
    return await buildConfigSchemaDocument(profile.name, result.entries, targets, result.diagnostics)
  } finally {
    interception.dispose()
  }
}
