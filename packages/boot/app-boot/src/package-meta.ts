/** Read plugin display text and icons through exported resources without evaluating plugin code. */

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve, sep, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ModuleLoader } from '@deepseek-ai/cordis-plugin-loader'
import type { LocalizedText, PluginLocalizedMeta } from '@deepseek-ai/dsh-package-manifest'
import { barePackageName } from './profile-resolution/resolver.ts'

const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u

type DisplayFields = Record<'title' | 'description', string | undefined>

/** Maximum raw icon bytes admitted to plugin metadata. */
const MAX_ICON_BYTES = 256 * 1024
const ICON_MEDIA_TYPES = new Map([
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],
])

function iconOf(value: unknown, manifestPath: string): string | undefined {
  const icon = textOf(value, `${manifestPath}: icon`)
  if (icon === undefined) return undefined
  if (isAbsolute(icon) || win32.isAbsolute(icon) || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(icon)) {
    throw new Error(`${manifestPath}: icon must be a relative file path`)
  }
  const mediaType = ICON_MEDIA_TYPES.get(extname(icon).toLowerCase())
  if (mediaType === undefined) throw new Error(`${manifestPath}: icon must be SVG, PNG, JPEG, or WebP`)
  const directory = realpathSync(dirname(manifestPath))
  const file = realpathSync(resolve(directory, icon))
  const local = relative(directory, file)
  if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new Error(`${manifestPath}: icon must remain inside its manifest directory`)
  }
  const stat = statSync(file)
  if (!stat.isFile()) throw new Error(`${manifestPath}: icon must be a regular file`)
  if (stat.size > MAX_ICON_BYTES) throw new Error(`${manifestPath}: icon exceeds 256 KiB`)
  const bytes = readFileSync(file)
  if (bytes.length > MAX_ICON_BYTES) throw new Error(`${manifestPath}: icon exceeds 256 KiB`)
  return `data:${mediaType};base64,${bytes.toString('base64')}`
}

/**
 * Resolve a plugin resource through the active Node ESM resolver without evaluating it.
 * @param specifier - complete resource module specifier, including its locale filename.
 * @param parentURL - owning module-resolution base.
 * @returns the local filesystem path selected by Node and the active profile.
 * @throws when the resolver is unavailable or the resource cannot resolve to a local file.
 */
export function resolvePluginResource(specifier: string, parentURL: string): string {
  const loader = ModuleLoader.fromInternal()
  if (loader === undefined) throw new Error('Plugin metadata requires the Node module resolver')
  const result = loader.version === 'v2'
    ? loader.resolveSync(parentURL, { specifier, attributes: {} })
    : loader.resolveSync(specifier, parentURL, {})
  return fileURLToPath(result.url)
}

function missingResource(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' || code === 'ERR_MODULE_NOT_FOUND'
    || code === 'MODULE_NOT_FOUND' || code === 'ENOENT' || code === 'ENOTDIR'
}

function optionalResourcePath(specifier: string, parentURL: string): string | undefined {
  try {
    return resolvePluginResource(specifier, parentURL)
  } catch (error) {
    if (missingResource(error)) return undefined
    throw error
  }
}

function objectOf(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function textOf(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${path} must be a non-empty string`)
  return value
}

function readObject(file: string): Record<string, unknown> {
  let contents: unknown
  try {
    contents = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${file}: ${String(error)}`)
  }
  return objectOf(contents, file)
}

function fallbackText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function dictionariesOf(englishPath: string, specifier: string, parentURL: string): Map<string, DisplayFields> {
  const dictionaries = new Map<string, DisplayFields>()
  for (const entry of readdirSync(dirname(englishPath), { withFileTypes: true })) {
    if (!entry.name.endsWith('.json')) continue
    const resource = `${specifier}/locale/${entry.name}`
    const language = entry.name.slice(0, -5)
    if (!LANGUAGE_ID.test(language)) throw new Error(`${resource} must use a language id as its filename`)
    const id = language.toLowerCase()
    if (dictionaries.has(id)) throw new Error(`${resource} duplicates locale ${id}`)
    const file = resolvePluginResource(resource, parentURL)
    if (dirname(file) !== dirname(englishPath)) {
      throw new Error(`${resource}: ${file} must share the English locale directory ${dirname(englishPath)}`)
    }
    const parsed = readObject(file)
    const meta = parsed.meta === undefined ? undefined : objectOf(parsed.meta, `${file}: meta`)
    dictionaries.set(id, {
      title: textOf(meta?.title, `${file}: meta.title`),
      description: textOf(meta?.description, `${file}: meta.description`),
    })
  }
  return dictionaries
}

function localizedText(
  field: keyof DisplayFields, dictionaries: Map<string, DisplayFields>, fallback: string | undefined, finalFallback: string,
): LocalizedText | undefined {
  const entries = [...dictionaries].flatMap(([language, fields]): [string, string][] => {
    const value = fields[field]
    return value === undefined ? [] : [[language, value]]
  })
  if (entries.length === 0) return fallback
  return { en: fallback ?? finalFallback, ...Object.fromEntries(entries) }
}

/**
 * Read localized display text and the icon declared in a plugin's exported package.json.
 * Icons are manifest-relative SVG, PNG, JPEG, or WebP files of at most 256 KiB,
 * contained in the manifest directory after realpath resolution. Icon failures retain display text.
 * Non-package specifiers are skipped without invoking the resource resolver.
 * Language files share the directory containing the resolved English resource;
 * each file is resolved through the complete plugin specifier before reading.
 * Missing fields use the same address's package.json name/description. Translation
 * maps retain an English fallback, ultimately the full module specifier for titles and empty for descriptions.
 * @param specifier - configured plugin module name, including any package subpath.
 * @param parentURL - owning Loader tree's module-resolution base.
 * @returns display fields and any icon diagnostic, or undefined for non-package specifiers or absent metadata.
 */
export function readPluginMeta(specifier: string, parentURL: string): PluginLocalizedMeta | undefined {
  if (barePackageName(specifier) === undefined) return undefined
  try {
    const englishPath = optionalResourcePath(`${specifier}/locale/en.json`, parentURL)
    const dictionaries = englishPath === undefined ? new Map<string, DisplayFields>() : dictionariesOf(englishPath, specifier, parentURL)
    const manifestPath = optionalResourcePath(`${specifier}/package.json`, parentURL)
    const manifest = manifestPath === undefined ? undefined : readObject(manifestPath)
    const title = localizedText('title', dictionaries, fallbackText(manifest?.name), specifier)
    const description = localizedText('description', dictionaries, fallbackText(manifest?.description), '')
    const text = {
      ...title === undefined ? {} : { title },
      ...description === undefined ? {} : { description },
    }
    let icon: string | undefined
    try {
      icon = manifestPath === undefined ? undefined : iconOf(manifest?.icon, manifestPath)
    } catch (error) {
      return { ...text, error: `Plugin metadata for ${specifier}: ${String(error)}` }
    }
    if (title === undefined && description === undefined && icon === undefined) return undefined
    return { ...text, ...icon === undefined ? {} : { icon } }
  } catch (error) {
    return { error: `Plugin metadata for ${specifier}: ${String(error)}` }
  }
}
