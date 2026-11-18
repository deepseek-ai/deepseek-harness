/**
 * Plugin detail document selection: the Markdown file a package's locale `meta.detail` names in a display language,
 * otherwise the package's README; and the images beside a selected document.
 */
import { posix } from 'node:path'
import { DetailFailure, joinPath, type DetailFiles } from './files.ts'

const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u

/**
 * The languages a document is chosen in: the language, each shorter prefix, then English.
 * @param language - a BCP 47 language id such as `zh-CN`.
 * @returns lower-case language ids, most specific first.
 * @throws when `language` is not a language id.
 */
export function languageChain(language: string): string[] {
  const id = language.toLowerCase()
  if (!LANGUAGE_ID.test(id)) throw new Error(`Not a language id: ${language}`)
  const parts = id.split('-')
  const chain = parts.map((_part, index) => parts.slice(0, parts.length - index).join('-'))
  return [...new Set([...chain, 'en'])]
}

/**
 * A locale `meta.detail` value: a `/`-separated Markdown path relative to the package root that cannot leave it.
 * @param value - the declared `meta.detail` value, or `undefined` when the locale file omits it.
 * @param label - the locale file path used in a failure message.
 * @returns the validated path, or `undefined` when the value is absent.
 * @throws {DetailFailure} `invalid` for another value.
 */
export function detailPath(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  const invalid = (rule: string): DetailFailure => new DetailFailure('invalid', `${label} ${rule}`)
  if (typeof value !== 'string' || value.trim() === '') throw invalid('must be a non-empty string')
  if (value.includes('\\') || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(value) || value.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw invalid('must be a relative path inside the package')
  }
  if (!/\.(?:md|markdown)$/iu.test(value)) throw invalid('must name a Markdown file')
  return value
}

/** `meta.detail` of the first `locale/<language>.json` along the chain that declares one. */
async function localeDetail(
  files: DetailFiles, dir: string, languages: readonly string[], maxBytes: number, signal: AbortSignal,
): Promise<string | undefined> {
  for (const language of languages) {
    // Locale files are named by language id: lower case, and also with an upper-case two-letter region.
    const names = [...new Set([language, language.replace(/^([a-z]{2,3})-([a-z]{2})$/u, (_match, base: string, region: string) => `${base}-${region.toUpperCase()}`)])]
    for (const name of names) {
      const path = joinPath(dir, `locale/${name}.json`)
      const bytes = await files.read(path, maxBytes, signal)
      if (bytes === undefined) continue
      let meta: unknown
      try {
        meta = (JSON.parse(new TextDecoder().decode(bytes)) as { meta?: unknown } | null)?.meta
      } catch (error) {
        throw new DetailFailure('invalid', `${path}: ${(error as SyntaxError).message}`, { cause: error })
      }
      const detail = detailPath(typeof meta === 'object' && meta !== null ? (meta as { detail?: unknown }).detail : undefined, `${path}: meta.detail`)
      if (detail !== undefined) return detail
      break
    }
  }
  return undefined
}

/**
 * Decode a Markdown document: UTF-8 without a byte order mark, without a leading YAML front matter block, which is file
 * metadata rather than description text.
 * @param bytes - the file's bytes.
 * @returns the Markdown text.
 */
export function markdownOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(/^\uFEFF/u, '').replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u, '')
}

/** A package's detail document. */
export interface PackageDocument {
  /** `locale` for the file `meta.detail` names, `readme` for the package's README. */
  readonly origin: 'locale' | 'readme'
  /** `/`-separated path of the document inside the files. */
  readonly path: string
  /** The document, decoded by {@link markdownOf}. */
  readonly markdown: string
}

/**
 * Read a package's detail document: the Markdown file that `meta.detail` in its `locale/<language>.json` names for the
 * first language of the chain that declares one, otherwise its README.
 * @param files - the package's files.
 * @param dir - package directory inside `files`, `''` for its root.
 * @param languages - the chain from {@link languageChain}.
 * @param maxBytes - largest accepted locale file and document.
 * @param signal - cancellation of the reads.
 * @returns the document, or undefined when the package has neither.
 * @throws {DetailFailure} `invalid` for a malformed locale file or `meta.detail` or a named file that does not exist, and
 *   the failures of `files`.
 */
export async function readPackageDocument(
  files: DetailFiles, dir: string, languages: readonly string[], maxBytes: number, signal: AbortSignal,
): Promise<PackageDocument | undefined> {
  const detail = await localeDetail(files, dir, languages, maxBytes, signal)
  if (detail !== undefined) {
    const path = joinPath(dir, detail)
    const bytes = await files.read(path, maxBytes, signal)
    if (bytes === undefined) throw new DetailFailure('invalid', `${path}, named by meta.detail, does not exist`)
    return { origin: 'locale', path, markdown: markdownOf(bytes) }
  }
  const readme = await files.readme(dir, maxBytes, signal)
  return readme === undefined ? undefined : { origin: 'readme', path: readme.path, markdown: markdownOf(readme.bytes) }
}

/** Image file types served beside a document, by lower-case extension. */
const IMAGE_TYPES = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'],
  ['.webp', 'image/webp'], ['.avif', 'image/avif'], ['.svg', 'image/svg+xml'],
])

/**
 * Resolve an image destination a document writes.
 * @param document - `/`-separated path of the document inside its files.
 * @param authored - the destination as written: relative to the document, or to the root of its files when it starts
 *   with `/`; a query or fragment is ignored.
 * @returns the image's path inside the files and its media type, or undefined for a malformed destination, a path that
 *   leaves the root, or a type other than PNG, JPEG, GIF, WebP, AVIF, and SVG.
 */
export function detailImage(document: string, authored: string): { path: string; mediaType: string } | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(authored.replace(/[?#].*$/su, ''))
  } catch (_malformed) {
    // A destination with a malformed percent escape names no file.
    return undefined
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return undefined
  const path = posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : posix.join(posix.dirname(document), decoded))
  if (path === '.' || path.startsWith('../') || path === '..' || posix.isAbsolute(path)) return undefined
  const mediaType = IMAGE_TYPES.get(posix.extname(path).toLowerCase())
  return mediaType === undefined ? undefined : { path, mediaType }
}
