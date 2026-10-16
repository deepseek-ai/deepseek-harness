/**
 * Plugin market index format 1: JSON validation, relative icon resolution, and install arguments.
 * The format is defined by the plugin market index format Agent Note; readers and generators share this validator.
 * @module @deepseek-ai/dsh-plugin-market-index
 */

import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import semver from 'semver'
import type {
  MarketDeclaration, MarketEngines, MarketIndex, MarketIndexMetadata, MarketInstallTarget, MarketPlugin, MarketPluginMetadata,
  MarketRepository, MarketSortKeyDeclaration, MarketSource, MarketVersion,
} from './types.ts'

export type * from './types.ts'

/** An index that violates format 1; `path` is the JSON path of the offending value, such as `$.plugins[0].versions[1].version`. */
export class MarketIndexError extends Error {
  /**
   * @param path - JSON path of the offending value.
   * @param reason - the violated rule.
   */
  constructor(readonly path: string, readonly reason: string) {
    super(`${path} ${reason}`)
    this.name = 'MarketIndexError'
  }
}

const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const PACKAGE_NAME_MAX_LENGTH = 214
/** The SemVer 2.0.0 grammar for one exact version. */
const NUMERIC = '(?:0|[1-9]\\d*)'
const PRERELEASE_PART = `(?:${NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`
const SEMVER = new RegExp(
  `^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}(?:-${PRERELEASE_PART}(?:\\.${PRERELEASE_PART})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`, 'u',
)
const COMMIT = /^[0-9a-f]{40}$/u
const PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/u
const DATA_ICON = /^data:(?:image\/svg\+xml|image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/]*={0,2})$/u
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
/** Largest decoded payload of an inline `data:` icon, in bytes. */
export const MAX_INLINE_ICON_BYTES = 32 * 1024
const MAX_PUBLISH_TIMESTAMP = 1e11

type Json = Record<string, unknown>

function fail(path: string, reason: string): never {
  throw new MarketIndexError(path, reason)
}

function objectAt(value: unknown, path: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'must be an object')
  return value as Json
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(path, 'must be a string with a non-whitespace character')
  return value
}

function optional<T>(object: Json, key: string, path: string, read: (value: unknown, path: string) => T): T | undefined {
  return Object.hasOwn(object, key) ? read(object[key], `${path}.${key}`) : undefined
}

function localizedText(value: unknown, path: string): LocalizedText {
  if (typeof value === 'string') return stringAt(value, path)
  const object = objectAt(value, path)
  const text: Record<string, string> = {}
  for (const [language, member] of Object.entries(object)) {
    if (!LANGUAGE_ID.test(language)) fail(`${path}.${language}`, 'must be keyed by a lowercase language id')
    own(text, language, stringAt(member, `${path}.${language}`))
  }
  if (!Object.hasOwn(text, 'en')) fail(path, 'must contain en')
  return text as LocalizedText
}

/** Define an own enumerable member, so an id such as `__proto__` stays an ordinary key. */
function own<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true })
}

function declarations<T>(value: unknown, path: string, read: (object: Json, path: string) => T): Record<string, T> {
  const result: Record<string, T> = {}
  for (const [id, member] of Object.entries(objectAt(value, path))) {
    if (id === '') fail(path, 'must not declare an empty id')
    own(result, id, read(objectAt(member, `${path}.${id}`), `${path}.${id}`))
  }
  return result
}

function declaration(object: Json, path: string): MarketDeclaration {
  return { title: localizedText(object.title, `${path}.title`) }
}

function sortKeyDeclaration(object: Json, path: string): MarketSortKeyDeclaration {
  if (object.order !== 'asc' && object.order !== 'desc') fail(`${path}.order`, 'must be "asc" or "desc"')
  return { title: localizedText(object.title, `${path}.title`), order: object.order }
}

function indexMetadata(value: unknown, path: string): MarketIndexMetadata {
  const object = value === undefined ? {} : objectAt(value, path)
  return {
    categories: optional(object, 'categories', path, (member, at) => declarations(member, at, declaration)) ?? {},
    labels: optional(object, 'labels', path, (member, at) => declarations(member, at, declaration)) ?? {},
    sortKeys: optional(object, 'sortKeys', path, (member, at) => declarations(member, at, sortKeyDeclaration)) ?? {},
  }
}

function declaredId(value: unknown, path: string, declared: Readonly<Record<string, unknown>>): string {
  const id = stringAt(value, path)
  if (!Object.hasOwn(declared, id)) fail(path, `references undeclared id ${JSON.stringify(id)}`)
  return id
}

function pluginMetadata(value: unknown, path: string, index: MarketIndexMetadata): MarketPluginMetadata {
  const object = value === undefined ? {} : objectAt(value, path)
  const category = optional(object, 'category', path, (member, at) => declaredId(member, at, index.categories))
  const keywords = optional(object, 'keywords', path, (member, at) => {
    if (!Array.isArray(member)) fail(at, 'must be an array')
    return member.map((keyword, position) => {
      if (typeof keyword !== 'string') fail(`${at}[${String(position)}]`, 'must be a string')
      return keyword
    })
  }) ?? []
  const labels = optional(object, 'labels', path, (member, at) => {
    if (!Array.isArray(member)) fail(at, 'must be an array')
    const ids = member.map((label, position) => declaredId(label, `${at}[${String(position)}]`, index.labels))
    if (new Set(ids).size !== ids.length) fail(at, 'must not repeat a label')
    return ids
  }) ?? []
  const sortKeys = optional(object, 'sortKeys', path, (member, at) => {
    const values: Record<string, number> = {}
    for (const [id, sortValue] of Object.entries(objectAt(member, at))) {
      declaredId(id, `${at}.${id}`, index.sortKeys)
      if (typeof sortValue !== 'number' || !Number.isFinite(sortValue)) fail(`${at}.${id}`, 'must be a finite number')
      own(values, id, sortValue)
    }
    return values
  }) ?? {}
  return { ...category === undefined ? {} : { category }, keywords, labels, sortKeys }
}

function httpUrl(value: unknown, path: string, protocols: readonly string[]): URL {
  const text = stringAt(value, path)
  let url: URL
  try {
    url = new URL(text)
  } catch {
    // Unparseable text: report the rule instead of the parser message.
    fail(path, 'must be an absolute URL')
  }
  if (!protocols.includes(url.protocol)) fail(path, `must use ${protocols.join(' or ')}`)
  if (url.username !== '' || url.password !== '') fail(path, 'must not contain credentials')
  if (url.href.includes('?') || url.href.includes('#')) fail(path, 'must not contain a query or fragment')
  return url
}

/** An absolute http(s) URL; npm `homepage` values often carry a `#readme` fragment, so fragments and queries are kept. */
function homepageUrl(value: unknown, path: string): string {
  const text = stringAt(value, path)
  if (!URL.canParse(text)) fail(path, 'must be an absolute URL')
  const url = new URL(text)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail(path, 'must use https: or http:')
  return url.href
}

function gitUrl(value: unknown, path: string): string {
  const url = httpUrl(value, path, ['https:'])
  if (url.href !== value) fail(path, 'must be a canonical URL')
  if (!/^(?:\/[^/]+){2,}$/u.test(url.pathname)) fail(path, 'must name a repository with at least two path segments')
  if (/\.(?:tgz|tar\.gz)$/iu.test(url.pathname)) fail(path, 'must name a repository, not a tarball')
  return url.href
}

function packagePath(value: unknown, path: string): string {
  const text = stringAt(value, path)
  const segments = text.split('/')
  if (segments.some(segment => segment === '.' || segment === '..' || !PATH_SEGMENT.test(segment))) {
    fail(path, 'must be a relative directory of letters, digits, and ._@+- segments without . or ..')
  }
  return text
}

function repository(value: unknown, path: string): MarketRepository {
  const object = objectAt(value, path)
  const url = httpUrl(object.url, `${path}.url`, ['https:', 'http:']).href
  const directory = optional(object, 'directory', path, packagePath)
  return { url, ...directory === undefined ? {} : { directory } }
}

function source(value: unknown, path: string): MarketSource {
  const object = objectAt(value, path)
  switch (object.type) {
    case 'npm': {
      const registry = optional(object, 'registry', path, (member, at) => httpUrl(member, at, ['https:', 'http:']).href)
      return { type: 'npm', ...registry === undefined ? {} : { registry } }
    }
    case 'git': {
      const commit = stringAt(object.commit, `${path}.commit`)
      if (!COMMIT.test(commit)) fail(`${path}.commit`, 'must be a lowercase 40-hex-digit commit SHA')
      const packageDir = optional(object, 'path', path, packagePath)
      return { type: 'git', url: gitUrl(object.url, `${path}.url`), commit, ...packageDir === undefined ? {} : { path: packageDir } }
    }
    default: return fail(`${path}.type`, 'must be "npm" or "git"')
  }
}

function engines(value: unknown, path: string): MarketEngines {
  const object = objectAt(value, path)
  const dsh = optional(object, 'dsh', path, (member, at) => {
    const range = stringAt(member, at)
    if (range.startsWith('workspace:')) fail(at, 'must not be a workspace: range')
    if (semver.validRange(range) === null) fail(at, 'must be a SemVer range')
    return range
  })
  return dsh === undefined ? {} : { dsh }
}

function icon(value: unknown, path: string, indexUrl: URL): string {
  const text = stringAt(value, path)
  if (text.startsWith('data:')) {
    const match = DATA_ICON.exec(text)
    const payload = match?.[1]
    if (payload === undefined || payload === '' || !BASE64.test(payload)) fail(path, 'must be a base64 SVG, PNG, JPEG, or WebP data URL')
    const bytes = payload.length / 4 * 3 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0)
    if (bytes > MAX_INLINE_ICON_BYTES) fail(path, `must not exceed ${String(MAX_INLINE_ICON_BYTES / 1024)} KiB of decoded bytes`)
    return text
  }
  let resolved: URL
  try {
    resolved = new URL(text, indexUrl)
  } catch {
    // Unresolvable reference: report the rule instead of the parser message.
    fail(path, 'must be a URL reference')
  }
  if (resolved.protocol !== 'https:' && (resolved.origin === 'null' || resolved.origin !== indexUrl.origin)) fail(path, 'must resolve to https or the index origin')
  return resolved.href
}

function marketVersion(value: unknown, path: string): MarketVersion {
  const object = objectAt(value, path)
  const version = stringAt(object.version, `${path}.version`)
  if (!SEMVER.test(version)) fail(`${path}.version`, 'must be an exact SemVer version')
  const publishTimestamp = object.publishTimestamp
  if (typeof publishTimestamp !== 'number' || !Number.isInteger(publishTimestamp) || publishTimestamp < 0 || publishTimestamp >= MAX_PUBLISH_TIMESTAMP) {
    fail(`${path}.publishTimestamp`, 'must be an integer number of Unix seconds in [0, 10^11)')
  }
  return {
    version, publishTimestamp,
    source: source(object.source, `${path}.source`),
    engines: optional(object, 'engines', path, engines) ?? {},
  }
}

function versions(value: unknown, path: string): MarketVersion[] {
  if (!Array.isArray(value) || value.length === 0) fail(path, 'must be a non-empty array')
  const seen = new Set<string>()
  const parsed = value.map((member, position) => {
    const at = `${path}[${String(position)}]`
    const entry = marketVersion(member, at)
    if (seen.has(entry.version)) fail(`${at}.version`, `duplicates ${entry.version}`)
    seen.add(entry.version)
    return entry
  })
  return parsed.sort((left, right) => semver.rcompare(left.version, right.version))
}

function plugin(value: unknown, path: string, index: MarketIndexMetadata, indexUrl: URL): MarketPlugin {
  const object = objectAt(value, path)
  const name = stringAt(object.name, `${path}.name`)
  if (name.length > PACKAGE_NAME_MAX_LENGTH || !PACKAGE_NAME.test(name)) fail(`${path}.name`, 'must be a valid npm package name')
  const title = optional(object, 'title', path, localizedText)
  const description = optional(object, 'description', path, localizedText)
  const iconUrl = optional(object, 'icon', path, (member, at) => icon(member, at, indexUrl))
  const author = optional(object, 'author', path, stringAt)
  const homepage = optional(object, 'homepage', path, homepageUrl)
  const repo = optional(object, 'repository', path, repository)
  return {
    name,
    ...title === undefined ? {} : { title },
    ...description === undefined ? {} : { description },
    ...iconUrl === undefined ? {} : { icon: iconUrl },
    ...author === undefined ? {} : { author },
    ...homepage === undefined ? {} : { homepage },
    ...repo === undefined ? {} : { repository: repo },
    metadata: pluginMetadata(object.metadata, `${path}.metadata`, index),
    versions: versions(object.versions, `${path}.versions`),
  }
}

/**
 * Validate a parsed format-1 index. Members the format does not define are ignored and dropped.
 * @param value - the parsed JSON document.
 * @param indexUrl - absolute URL the index was read from; relative icon references resolve against it.
 * @returns the validated index with absent metadata groups and lists filled with empty values, and each plugin's
 *   versions in descending SemVer precedence.
 * @throws {MarketIndexError} for the first violated rule.
 */
export function parseMarketIndex(value: unknown, indexUrl: string): MarketIndex {
  if (!URL.canParse(indexUrl)) fail('$', `index URL ${JSON.stringify(indexUrl)} must be an absolute URL`)
  const base = new URL(indexUrl)
  const object = objectAt(value, '$')
  if (object.format !== 1) fail('$.format', 'must be 1')
  const metadata = indexMetadata(object.metadata, '$.metadata')
  if (!Array.isArray(object.plugins)) fail('$.plugins', 'must be an array')
  const names = new Set<string>()
  const plugins = object.plugins.map((entry, position) => {
    const parsed = plugin(entry, `$.plugins[${String(position)}]`, metadata, base)
    if (names.has(parsed.name)) fail(`$.plugins[${String(position)}].name`, `duplicates ${parsed.name}`)
    names.add(parsed.name)
    return parsed
  })
  const title = localizedText(object.title, '$.title')
  const description = optional(object, 'description', '$', localizedText)
  return { format: 1, title, ...description === undefined ? {} : { description }, metadata, plugins }
}

/**
 * Build the arguments that install one exact version: `name@version` for npm, and a `git+https` URL pinned to the
 * commit, with pnpm's `path:` parameter for a package directory, for Git.
 * @param name - the plugin's package name.
 * @param version - a validated version of that plugin.
 * @returns the install spec and the registry to ask first, when the version names one.
 */
export function marketInstallTarget(name: string, version: Pick<MarketVersion, 'version' | 'source'>): MarketInstallTarget {
  const { source: from } = version
  if (from.type === 'npm') return { spec: `${name}@${version.version}`, ...from.registry === undefined ? {} : { registry: from.registry } }
  const repository = from.url.endsWith('.git') ? from.url : `${from.url}.git`
  return { spec: `git+${repository}#${from.commit}${from.path === undefined ? '' : `&path:/${from.path}`}` }
}
