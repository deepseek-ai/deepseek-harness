/**
 * Plugin market entry detail documents: the package document {@link readPackageDocument} selects from the entry
 * version's source, otherwise the README of the repository directory the entry or its package declares; cached reads
 * and the images beside a read document.
 */
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { DetailFailure, detailImage, joinPath, markdownOf, readPackageDocument, type DetailFiles } from '@deepseek-ai/dsh-plugin-detail'
import hostedGitInfo from 'hosted-git-info'
import { repositoryFiles, type RepositoryFileOptions, type RepositoryRef } from './detail-files.ts'
import type { PluginDetail, PluginDetailDocumentId, PluginDetailOrigin } from './types.ts'

/** A repository directory whose README is the last detail source. */
export interface RepositoryLocation extends RepositoryRef {
  /** Package directory inside the repository, `''` for its root. */
  readonly directory: string
}

/** Where one package's detail sources are. */
export interface DetailLocation {
  /** The package's files, when they can be read; `locale/<language>.json` and the README are read from them. */
  readonly files?: DetailFiles
  /** Package directory inside `files`, `''` for its root. */
  readonly dir: string
  /**
   * The repository read last, at its default branch; `manifest` reads `repository` from the package's `package.json`
   * in `files`.
   */
  readonly repository: RepositoryLocation | 'manifest' | undefined
}

/** Limits of detail documents and their images. */
export interface DetailLimits {
  readonly maxDocumentBytes: number
  readonly maxImageBytes: number
  /** Lifetime of a read result, including a failure that a retry would repeat. */
  readonly ttlMs: number
}

/** Failures that reading again within `ttlMs` would repeat. */
const LASTING_FAILURES = new Set<DetailFailure['reason']>(['too-large', 'denied', 'invalid'])

/**
 * The repository a URL or shorthand names: hosts npm knows by their owner and project, so a GitHub page such as
 * `/o/r/tree/main/pkg` names `o/r`; other http(s) URLs by their path, without a GitLab `/-/` page suffix.
 * @param url - a manifest `repository` URL or shorthand, or a market index's `repository.url`.
 * @returns the repository, or undefined for a gist, another protocol, or fewer than two path segments.
 */
export function repositoryOf(url: string): RepositoryRef | undefined {
  // A committish such as `#semver:^1` names a revision, not the repository.
  const declared = url.replace(/#.*$/u, '')
  const hosted = hostedGitInfo.fromUrl(declared)
  if (hosted !== undefined) {
    if (hosted.type === 'gist') return undefined
    const project = `${hosted.user}/${hosted.project}`
    return { host: hosted.domain.toLowerCase(), project, url: `https://${hosted.domain}/${project}.git` }
  }
  const address = declared.replace(/^git\+/u, '')
  if (!URL.canParse(address)) return undefined
  const parsed = new URL(address)
  const project = parsed.pathname.replace(/\/-\/.*$/u, '').replace(/^\/+|\/+$/gu, '').replace(/\.git$/u, '')
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username !== '' || parsed.password !== '' || project.split('/').length < 2) {
    return undefined
  }
  return { host: parsed.hostname.toLowerCase(), project, url: `${parsed.protocol}//${parsed.host}/${project}.git` }
}

/**
 * Parse a manifest `repository` into the repository and directory its README is read from.
 * @param value - a manifest `repository` string or object.
 * @returns the location, or undefined when it names no repository {@link repositoryOf} accepts; a `directory` that
 *   leaves the repository is dropped.
 */
export function manifestRepository(value: unknown): RepositoryLocation | undefined {
  const object = typeof value === 'object' && value !== null ? value as { url?: unknown; directory?: unknown } : undefined
  const declared = object === undefined ? value : object.url
  if (typeof declared !== 'string') return undefined
  const repository = repositoryOf(declared)
  if (repository === undefined) return undefined
  return { ...repository, directory: typeof object?.directory === 'string' ? normalizedDirectory(object.directory) ?? '' : '' }
}

/** A `/`-separated directory without empty, `.`, or `..` segments; undefined for one that leaves its root. */
function normalizedDirectory(directory: string): string | undefined {
  const normalized = posix.normalize(directory.replace(/\\/gu, '/')).replace(/\/+$/u, '')
  if (normalized === '.' || normalized === '') return ''
  return normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized) ? undefined : normalized
}

/** A read document and the files its images resolve against. */
interface DetailDocument {
  readonly files: DetailFiles
  /** Path of the document inside `files`. */
  readonly path: string
  /** When a read returned the document or an image beside it was served last. */
  usedAt: number
}

/** A cached read: the document, or a failure that reading again would repeat. */
type CachedRead =
  | { readonly value: PluginDetail; readonly expiresAt: number }
  | { readonly failure: DetailFailure; readonly expiresAt: number }

/** Reads and caches detail documents for one service. */
export class DetailReader {
  private readonly results = new Map<string, CachedRead>()
  private readonly pending = new Map<string, Promise<PluginDetail>>()
  private readonly documents = new Map<PluginDetailDocumentId, DetailDocument>()

  /**
   * @param limits - document and image sizes and the result lifetime.
   * @param repositories - single-file API, clone, and request settings of repository reads.
   */
  constructor(private readonly limits: DetailLimits, private readonly repositories: RepositoryFileOptions) {}

  /**
   * Read a package's detail document, sharing concurrent reads and reusing a result, or a failure that reading again
   * would repeat, for `ttlMs`.
   * @param location - the package's sources.
   * @param languages - the chain from `languageChain` of `dsh-plugin-detail`.
   * @param refresh - read again instead of reusing a cached result.
   * @returns the first document the sources provide, or `none`.
   * @throws {DetailFailure} when a source that should provide a document cannot be read.
   */
  read(location: DetailLocation, languages: readonly string[], refresh = false): Promise<PluginDetail> {
    const { repository } = location
    const repositoryKey = typeof repository === 'string' ? repository : repository === undefined ? '' : `${repository.url}:${repository.directory}`
    const key = JSON.stringify([location.files?.key ?? '', location.dir, repositoryKey, languages])
    const now = Date.now()
    const cached = this.results.get(key)
    if (!refresh && cached !== undefined && cached.expiresAt > now) {
      if ('failure' in cached) return Promise.reject(cached.failure)
      if (cached.value.status === 'found') this.use(cached.value.document)
      return Promise.resolve(cached.value)
    }
    let pending = this.pending.get(key)
    if (pending === undefined) {
      pending = this.resolve(location, languages, this.repositories.lifetime).then((value) => {
        this.remember(key, { value, expiresAt: Date.now() + this.limits.ttlMs })
        return value
      }, (error: unknown) => {
        if (error instanceof DetailFailure && LASTING_FAILURES.has(error.reason)) {
          this.remember(key, { failure: error, expiresAt: Date.now() + this.limits.ttlMs })
        }
        throw error
      }).finally(() => { this.pending.delete(key) })
      this.pending.set(key, pending)
    }
    return pending
  }

  /**
   * Read an image beside a document.
   * @param id - the document id a detail read returned.
   * @param authored - the image destination as the document writes it: relative to the document, or to the package or
   *   repository root when it starts with `/`; a query or fragment is ignored.
   * @returns the bytes and media type, or undefined for an unknown document, a path outside its root, an unsupported
   *   image type, or a missing file.
   * @throws {DetailFailure} when the source fails or the image exceeds `maxImageBytes`.
   */
  async image(id: string, authored: string): Promise<{ bytes: Uint8Array; mediaType: string } | undefined> {
    const document = this.use(brandString<PluginDetailDocumentId>(id))
    const image = document === undefined ? undefined : detailImage(document.path, authored)
    if (document === undefined || image === undefined) return undefined
    // A request the browser abandons still completes, so a cancelled image never interrupts a shared clone.
    const bytes = await document.files.read(image.path, this.limits.maxImageBytes, this.repositories.lifetime)
    return bytes === undefined ? undefined : { bytes, mediaType: image.mediaType }
  }

  /**
   * Mark a document used and forget documents unused for `ttlMs`, so ids live as long as a read or an image request
   * returns them. A cached read is younger than `ttlMs` and marks its document, so no cached read names a forgotten id.
   */
  private use(id: PluginDetailDocumentId): DetailDocument | undefined {
    const now = Date.now()
    for (const [known, document] of this.documents) if (now - document.usedAt > this.limits.ttlMs) this.documents.delete(known)
    const document = this.documents.get(id)
    if (document !== undefined) document.usedAt = now
    return document
  }

  /** Cache a read and drop expired ones, so the cache holds only reads younger than `ttlMs`. */
  private remember(key: string, read: CachedRead): void {
    const now = Date.now()
    for (const [cachedKey, cached] of this.results) if (cached.expiresAt <= now) this.results.delete(cachedKey)
    this.results.set(key, read)
  }

  private async resolve(location: DetailLocation, languages: readonly string[], signal: AbortSignal): Promise<PluginDetail> {
    const { files, dir } = location
    let repository = location.repository === 'manifest' ? undefined : location.repository
    if (files !== undefined) {
      const document = await readPackageDocument(files, dir, languages, this.limits.maxDocumentBytes, signal)
      if (document !== undefined) return this.found(document.origin, files, document.path, document.markdown)
      if (location.repository === 'manifest') repository = await this.manifestRepositoryOf(files, dir, signal)
    }
    if (repository === undefined) return { status: 'none' }
    const source = repositoryFiles(repository, undefined, this.repositories)
    const readme = await source.readme(repository.directory, this.limits.maxDocumentBytes, signal)
    return readme === undefined ? { status: 'none' } : this.found('repository', source, readme.path, markdownOf(readme.bytes))
  }

  private async manifestRepositoryOf(files: DetailFiles, dir: string, signal: AbortSignal): Promise<RepositoryLocation | undefined> {
    const bytes = await files.read(joinPath(dir, 'package.json'), this.limits.maxDocumentBytes, signal)
    if (bytes === undefined) return undefined
    try {
      return manifestRepository((JSON.parse(new TextDecoder().decode(bytes)) as { repository?: unknown } | null)?.repository)
    } catch (_malformed) {
      // A manifest the package manager accepted parses; an unreadable one names no repository to read.
      return undefined
    }
  }

  private found(origin: PluginDetailOrigin, files: DetailFiles, path: string, markdown: string): PluginDetail {
    const document = brandString<PluginDetailDocumentId>(createHash('sha256').update(`${files.key}\0${path}`).digest('hex').slice(0, 32))
    this.documents.set(document, { files, path, usedAt: Date.now() })
    this.use(document)
    return { status: 'found', origin, markdown, document }
  }
}
