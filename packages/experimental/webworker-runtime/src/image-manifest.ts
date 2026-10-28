/**
 * The base image's manifest: what the packer records about one image and what
 * the worker host requires before it wraps a module or boots the tree. Both
 * sides use these types; the worker validates the fetched file with
 * {@link parseImageManifest}.
 */
import { LOWERING_VERSION } from './image-layout.ts'

/** One file a lazy archive supplies. */
export interface ImageLazyFile {
  /** Path relative to the image root, as the archive names it. */
  readonly path: string
  /** Byte length of the archived file. */
  readonly size: number
}

/** One archive beside the base image whose files arrive on first asynchronous read. */
export interface ImageLazyArchive {
  /** Archive path relative to the base image URL. */
  readonly archive: string
  /** Every file the archive carries. */
  readonly files: readonly ImageLazyFile[]
}

/** Fields recorded in the base image's manifest. */
export interface ImageManifest {
  /** Virtual root the image was packed for. */
  readonly root: string
  /** Shipped profile template the worker host initializes and boots. */
  readonly profile: string
  /** Package whose manifest alone anchors bundle resolution; absent in images that boot no tree. */
  readonly installation?: string
  /** Wrapper contract every packed body was lowered against. */
  readonly lowered: string
  /** JavaScript entries the image carries, lazy archives excluded. */
  readonly javascriptEntries: number
  /** Entries the pack-time transform visited. */
  readonly visitedEntries: number
  /** Visited entries the transform rewrote. */
  readonly rewrittenEntries: number
  /** Page chunks requested only through `require.async`, one archive each. */
  readonly lazy: readonly ImageLazyArchive[]
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** A relative path made of non-empty segments without traversal. */
function isRelativePath(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !value.startsWith('/')
    && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Validate a fetched base-image manifest.
 * @param value - Parsed manifest JSON.
 * @param path - Manifest path inside the image, named in refusals.
 * @returns The detached manifest.
 * @throws When the manifest is malformed, or its bodies were lowered against another wrapper contract.
 */
export function parseImageManifest(value: unknown, path: string): ImageManifest {
  const record = recordOf(value)
  if (record === undefined) throw new Error(`webworker host: ${path} does not hold an object`)
  if (record.lowered !== LOWERING_VERSION) {
    throw new Error(`webworker host: image was lowered by ${String(record.lowered)}, this build runs ${LOWERING_VERSION}; rebuild the image`)
  }
  const { root, profile, installation, javascriptEntries, visitedEntries, rewrittenEntries, lazy } = record
  if (typeof root !== 'string' || typeof profile !== 'string' || profile === ''
    || (installation !== undefined && (typeof installation !== 'string' || installation === ''))
    || !isCount(javascriptEntries) || !isCount(visitedEntries) || !isCount(rewrittenEntries) || !Array.isArray(lazy)) {
    throw new Error(`webworker host: ${path} lacks a valid root, profile, installation, entry count, or lazy archive list`)
  }
  const archives: ImageLazyArchive[] = []
  const archiveNames = new Set<string>()
  const filePaths = new Set<string>()
  for (const entry of lazy) {
    const archive = recordOf(entry)
    const name = archive?.archive
    const files = archive?.files
    if (!isRelativePath(name) || archiveNames.has(name) || !Array.isArray(files) || files.length === 0) {
      throw new Error(`webworker host: ${path} lists an invalid or repeated lazy archive`)
    }
    archiveNames.add(name)
    const parsed: ImageLazyFile[] = []
    for (const candidate of files) {
      const file = recordOf(candidate)
      if (file === undefined || !isRelativePath(file.path) || !isCount(file.size) || filePaths.has(file.path)) {
        throw new Error(`webworker host: ${path} lists an invalid or repeated file in lazy archive ${name}`)
      }
      filePaths.add(file.path)
      parsed.push({ path: file.path, size: file.size })
    }
    archives.push({ archive: name, files: parsed })
  }
  return {
    root, profile, ...installation === undefined ? {} : { installation }, lowered: LOWERING_VERSION,
    javascriptEntries, visitedEntries, rewrittenEntries, lazy: archives,
  }
}
