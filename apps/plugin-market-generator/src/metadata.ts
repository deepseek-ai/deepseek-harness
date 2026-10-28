/**
 * Read a package's display metadata from its files the way DSH reads installed plugin metadata: locale files and the
 * icon are resolved through the package `exports` map, and nothing is evaluated.
 */
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import hostedGitInfo from 'hosted-git-info'
import type { MarketRepository } from '@deepseek-ai/dsh-plugin-market-index'
import { exports as resolveExports, type Package } from 'resolve.exports'
import { PackageFiles } from './files.ts'
import type { Manifest } from './packages.ts'

/** Name of an icon file the generator writes under `icons/`: a content hash and the image extension. */
export const GENERATED_ICON = /^[0-9a-f]{16}\.(?:svg|png|jpg|jpeg|webp)$/u

/** Display fields of one plugin; `icon` is a data URL or a path relative to the index file. */
export interface Display {
  readonly title?: LocalizedText
  readonly description?: LocalizedText
  readonly icon?: string
  readonly author?: string
  /** The manifest `homepage`, copied as written. */
  readonly homepage?: string
  /** The web URL of the manifest `repository`, with its `directory`. */
  readonly repository?: MarketRepository
  /** Optional discovery metadata; keywords are copied from the manifest as written. */
  readonly metadata?: { readonly keywords: readonly string[] }
}

/** How icons are emitted and where diagnostics go. */
export interface DisplayOptions {
  /** Largest icon, in bytes, embedded as a data URL; larger icons are returned as files. */
  readonly inlineBytes: number
  /** Receives diagnostics about invalid manifest fields, locale files, and icons that are not used. */
  readonly warn: (message: string) => void
}

/** An icon too large to inline: the index refers to `path`, and the caller writes `bytes` there. */
export interface IconFile {
  readonly path: string
  readonly bytes: Uint8Array
}

type Fields = { title?: string; description?: string }

const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u
const MAX_ICON_BYTES = 256 * 1024
const ICON_TYPES = new Map([['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp']])

/** One segment of a package directory, as the index format accepts it; keep it equal to the parser's rule. */
const PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/u

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Resolve a package subpath such as `./icon` to a file path: through `exports` with the import, node, and default
 * conditions when the manifest has one, otherwise literally. A subpath that is not exported, or whose target leaves
 * the package, has no path.
 */
function resource(manifest: Manifest, subpath: string): string | undefined {
  if (manifest.exports === undefined) return PackageFiles.resolve('', subpath)
  let targets: string[]
  try {
    // With an `exports` field, resolve.exports returns a non-empty target list or throws for an unexported subpath.
    targets = resolveExports({ name: '', exports: manifest.exports as Package['exports'] }, subpath) as string[]
  } catch (_notExported) {
    return undefined
  }
  return PackageFiles.resolve('', targets[0] as string)
}

/** Parse one locale file's `meta` fields, or explain why the file is not used. */
function localeFields(bytes: Uint8Array): Fields | string {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch (error) {
    return String(error)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'must be a JSON object'
  const meta: unknown = (parsed as { meta?: unknown }).meta
  if (meta === undefined) return {}
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return 'meta must be an object'
  const fields: Fields = {}
  for (const key of ['title', 'description'] as const) {
    const value: unknown = (meta as Fields)[key]
    if (value === undefined) continue
    if (text(value) === undefined) return `meta.${key} must be a non-empty string`
    fields[key] = value as string
  }
  return fields
}

/**
 * Locale `meta` fields by lowercase language id. The English file `./locale/en.json` locates the locale directory;
 * every other `.json` file there is read through `./locale/<file>` and must resolve into the same directory.
 */
async function dictionaries(files: PackageFiles, manifest: Manifest, warn: (message: string) => void): Promise<Map<string, Fields>> {
  const result = new Map<string, Fields>()
  const english = resource(manifest, './locale/en.json')
  if (english === undefined || files.file(english) === undefined) return result
  const dir = posix.dirname(english)
  for (const name of files.fileNames(dir === '.' ? '' : dir)) {
    if (!name.endsWith('.json')) continue
    const language = name.slice(0, -5)
    const path = resource(manifest, `./locale/${name}`)
    const bytes = path === undefined || posix.dirname(path) !== dir ? undefined : await files.read(path)
    const fields = !LANGUAGE_ID.test(language) ? 'its name is not a language id'
      : result.has(language.toLowerCase()) ? `duplicates locale ${language.toLowerCase()}`
        : bytes === undefined ? `./locale/${name} does not resolve into ${dir}` : localeFields(bytes)
    if (typeof fields === 'string') warn(`locale file ${posix.join(dir, name)} ignored: ${fields}`)
    else result.set(language.toLowerCase(), fields)
  }
  return result
}

/**
 * Combine locale values with the manifest fallback: a plain string without translations, otherwise an `en`-keyed map.
 * The format requires English text, so translations without an English value or manifest fallback are dropped.
 */
function localized(field: keyof Fields, locales: Map<string, Fields>, fallback: string | undefined): LocalizedText | undefined {
  const translated = [...locales].flatMap(([language, fields]) => fields[field] === undefined ? [] : [[language, fields[field]] as const])
  if (translated.length === 0) return fallback
  const english = locales.get('en')?.[field] ?? fallback
  if (english === undefined) return undefined
  if (translated.length === 1 && translated[0]?.[0] === 'en') return english
  return Object.fromEntries([['en', english], ...translated]) as LocalizedText
}

/**
 * The web URL of a manifest `repository` string or object `url`: a shorthand or URL of a host npm knows becomes its
 * browse URL without a committish, and any other http(s) URL, after a `git+` prefix, loses its credentials, query, fragment, and `.git`
 * suffix.
 */
function repositoryUrl(declared: string): string | undefined {
  // A committish such as `#semver:^1` names a revision, not the repository page.
  const hosted = hostedGitInfo.fromUrl(declared.replace(/#.*$/u, ''))
  if (hosted !== undefined) return hosted.browse()
  const plain = declared.replace(/^git\+/u, '')
  if (!URL.canParse(plain)) return undefined
  const url = new URL(plain)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  url.pathname = url.pathname.replace(/\.git$/u, '')
  return url.href
}

/** The repository a manifest declares, or why it is omitted; a directory the format cannot hold is dropped with a warning. */
function readRepository(value: unknown, warn: (message: string) => void): MarketRepository | undefined {
  if (value === undefined) return undefined
  const object = typeof value === 'object' && value !== null ? value as { url?: unknown; directory?: unknown } : undefined
  const declared = text(object === undefined ? value : object.url)?.trim()
  const url = declared === undefined ? undefined : repositoryUrl(declared)
  if (url === undefined) {
    warn(`package.json repository ${JSON.stringify(value)} names no http(s) repository page; it is omitted`)
    return undefined
  }
  const directory = text(object?.directory)?.replace(/^\.\/|\/$/gu, '')
  const valid = directory !== undefined && directory.split('/').every(segment => segment !== '.' && segment !== '..' && PATH_SEGMENT.test(segment))
  if (object?.directory !== undefined && !valid) warn(`package.json repository.directory ${JSON.stringify(object.directory)} is not a relative directory; it is omitted`)
  return { url, ...valid ? { directory } : {} }
}

/** The icon a package declares, or why it is not used: the manifest `icon` takes priority over the `./icon` export. */
async function readIcon(
  files: PackageFiles, manifest: Manifest,
): Promise<{ type: string; path: string; bytes: Buffer } | string | undefined> {
  let path: string | undefined
  if (manifest.icon === undefined) {
    // As for Node module resolution, an `./icon` subpath without a file is absent.
    path = resource(manifest, './icon')
    if (path === undefined || files.file(path) === undefined) return undefined
  } else {
    const declared = text(manifest.icon)
    if (declared === undefined || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(declared)) return 'icon must be a relative file path'
    path = PackageFiles.resolve('', declared)
    if (path === undefined) return `icon ${declared} is outside the package`
  }
  const type = ICON_TYPES.get(posix.extname(path).toLowerCase())
  if (type === undefined) return `icon ${path} must be SVG, PNG, JPEG, or WebP`
  const file = files.file(path)
  if (file === undefined) return `icon ${path} is not a file in the package`
  if (file.size > MAX_ICON_BYTES) return `icon ${path} exceeds 256 KiB`
  return { type, path, bytes: Buffer.from(await file.read()) }
}

/**
 * Read display metadata, author, homepage, repository, and icon of a package. `homepage` is copied from the manifest as
 * written; a value that is not an absolute http(s) URL is reported and omitted, and nothing else stands in for it.
 * `repository` becomes the repository's web URL and its directory; one that names no http(s) page is reported and
 * omitted.
 * Manifest `keywords` arrays containing only strings are copied unchanged into `metadata.keywords`; any other
 * present value is reported and omitted without dropping the package.
 * @param files - the package's files.
 * @param manifest - its parsed `package.json`.
 * @param options - icon inlining threshold and diagnostics.
 * @returns the display fields, and the icon file to write when the icon is too large to inline.
 */
export async function readDisplayMetadata(
  files: PackageFiles, manifest: Manifest, options: DisplayOptions,
): Promise<{ display: Display; iconFile?: IconFile }> {
  const locales = await dictionaries(files, manifest, options.warn)
  const title = localized('title', locales, text(manifest.name))
  const description = localized('description', locales, text(manifest.description))
  // npm's person string is `Name <email> (url)`; only the name is published, so no address spreads into the index.
  const person = typeof manifest.author === 'object' && manifest.author !== null ? (manifest.author as { name?: unknown }).name : manifest.author
  const author = text(typeof person === 'string' ? person.replace(/<[^>]*>|\([^)]*\)/gu, '').trim() : person)
  const homepage = text(manifest.homepage)
  const linkable = homepage !== undefined && URL.canParse(homepage) && ['https:', 'http:'].includes(new URL(homepage).protocol)
  if (homepage !== undefined && !linkable) options.warn(`package.json homepage ${JSON.stringify(homepage)} is not an http(s) URL; it is omitted`)
  const repository = readRepository(manifest.repository, options.warn)
  const keywords = Array.isArray(manifest.keywords) && manifest.keywords.every((keyword): keyword is string => typeof keyword === 'string')
    ? manifest.keywords : undefined
  if (manifest.keywords !== undefined && keywords === undefined) options.warn('package.json keywords must be an array of strings; it is omitted')
  const display = {
    ...title === undefined ? {} : { title }, ...description === undefined ? {} : { description }, ...author === undefined ? {} : { author },
    ...linkable ? { homepage } : {},
    ...repository === undefined ? {} : { repository },
    ...keywords === undefined ? {} : { metadata: { keywords } },
  }
  const icon = await readIcon(files, manifest)
  if (typeof icon === 'string') options.warn(`${icon}; the icon is omitted`)
  if (typeof icon !== 'object') return { display }
  const { type, path, bytes } = icon
  if (bytes.length <= options.inlineBytes) return { display: { ...display, icon: `data:${type};base64,${bytes.toString('base64')}` } }
  const file = `icons/${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}${posix.extname(path).toLowerCase()}`
  return { display: { ...display, icon: file }, iconFile: { path: file, bytes } }
}
