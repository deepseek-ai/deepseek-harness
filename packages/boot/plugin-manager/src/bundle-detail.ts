/**
 * Detail documents of profile bundles: an installed bundle's `meta.detail` file or README from its directory, and an
 * official bundle the installation offers, before it is installed, from the npm file CDNs at its offered version. Reads
 * keep no state; an image request resolves its bundle and document again.
 */
import semver from 'semver'
import { resolveBundleDir } from '@deepseek-ai/dsh-app-boot'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import {
  DetailFailure, detailImage, languageChain, localFiles, npmFileSourceOrder, npmFiles, readPackageDocument,
  type DetailFiles, type NpmFileSource,
} from '@deepseek-ai/dsh-plugin-detail'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { BundleDetail, BundleInfo } from './types.ts'

/** Limits and sources of bundle detail reads. */
export interface BundleDetailOptions {
  readonly profile: ProfileContext
  readonly maxDocumentBytes: number
  readonly maxImageBytes: number
  readonly npmFileSources: readonly NpmFileSource[]
  /** Deadline of one CDN request. */
  readonly timeoutMs: number
  /** The plugin manager's disposal. */
  readonly lifetime: AbortSignal
}

/**
 * The files of a listed bundle: its directory when its files can be read, otherwise its offered npm version.
 * @param bundle - the bundle as `listBundles()` reports it.
 * @param preferred - npm file CDNs to ask first for an offered version; see `npmFileSourceOrder`.
 * @param options - profile, sources, and limits.
 * @returns the files, or undefined for a bundle offered at no published version.
 * @throws {RemoteError} `plugin-manager/unknown-bundle` when the bundle's directory cannot be resolved.
 */
function filesOf(bundle: BundleInfo, preferred: readonly string[], options: BundleDetailOptions): DetailFiles | undefined {
  if (bundle.availability !== 'missing') {
    let dir: string
    try {
      dir = resolveBundleDir('dsh', bundle.name, options.profile.installAnchor, options.profile.dir)
    } catch (error) {
      throw new RemoteError('plugin-manager/unknown-bundle', (error as Error).message, { name: bundle.name }, { cause: error })
    }
    // `listBundles()` reports the version of every bundle whose manifest it read; one without is read as unversioned.
    return localFiles(dir, String(bundle.version))
  }
  const version = bundle.installTarget?.version
  if (version === undefined || semver.valid(version) !== version) return undefined
  const sources = npmFileSourceOrder(options.npmFileSources, preferred)
  return npmFiles(bundle.name, version, sources, { timeoutMs: options.timeoutMs, lifetime: options.lifetime })
}

/** Rethrow a detail failure as the Remote error clients read. */
function remoteFailure(error: unknown): never {
  if (error instanceof DetailFailure) {
    throw new RemoteError('plugin-manager/detail-unavailable', error.message, { reason: error.reason }, { cause: error })
  }
  throw error
}

/**
 * Read a bundle's detail document in a display language.
 * @param bundle - the bundle as `listBundles()` reports it.
 * @param language - a BCP 47 language id.
 * @param preferred - npm file CDNs to ask first for an offered version; see `npmFileSourceOrder`.
 * @param options - profile, sources, and limits.
 * @returns the document, or `none` when the bundle has neither a `meta.detail` file nor a README.
 * @throws {RemoteError} `plugin-manager/invalid-language`, `plugin-manager/unknown-bundle`, or
 *   `plugin-manager/detail-unavailable`.
 */
export async function readBundleDocument(
  bundle: BundleInfo, language: string, preferred: readonly string[], options: BundleDetailOptions,
): Promise<BundleDetail> {
  let languages: string[]
  try {
    languages = languageChain(language)
  } catch (error) {
    throw new RemoteError('plugin-manager/invalid-language', (error as Error).message, { language }, { cause: error })
  }
  const files = filesOf(bundle, preferred, options)
  if (files === undefined) return { status: 'none' }
  const document = await readPackageDocument(files, '', languages, options.maxDocumentBytes, options.lifetime).catch(remoteFailure)
  return document === undefined ? { status: 'none' } : { status: 'found', ...document }
}

/**
 * Read an image beside a bundle's detail document.
 * @param bundle - the bundle as `listBundles()` reports it.
 * @param document - the document's path inside the bundle, as {@link readBundleDocument} returned it.
 * @param destination - the image destination as the document writes it.
 * @param preferred - npm file CDNs to ask first for an offered version; see `npmFileSourceOrder`.
 * @param options - profile, sources, and limits.
 * @returns the bytes and media type, or undefined for a path outside the bundle, an unsupported type, or a missing file.
 * @throws {RemoteError} `plugin-manager/unknown-bundle` or `plugin-manager/detail-unavailable`.
 */
export async function readBundleImage(
  bundle: BundleInfo, document: string, destination: string, preferred: readonly string[], options: BundleDetailOptions,
): Promise<{ bytes: Uint8Array; mediaType: string } | undefined> {
  const image = detailImage(document, destination)
  const files = image === undefined ? undefined : filesOf(bundle, preferred, options)
  if (image === undefined || files === undefined) return undefined
  const bytes = await files.read(image.path, options.maxImageBytes, options.lifetime).catch(remoteFailure)
  return bytes === undefined ? undefined : { bytes, mediaType: image.mediaType }
}
