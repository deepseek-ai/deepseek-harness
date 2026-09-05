/** Content-addressed, owner-private local attachment storage. */

import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { chmod, link, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'
import {
  AttachmentError,
  AttachmentId,
} from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { normalizeImage } from './normalization.ts'
import type { NormalizationPolicy } from './normalization.ts'
import { detectImage, probeImage } from './image.ts'
import type { DetectedImage } from './image.ts'

const ID_PATTERN = /^sha256:([a-f0-9]{64})$/
const durableHomes = new Set<string>()

function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function displayName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  // Strip both separator styles by hand: a POSIX host treats `\` as an
  // ordinary character, so path.basename would keep a Windows client's full
  // local path and leak it into the reference and the session log.
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1)
  const clean = leaf.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255)
  return clean === '' ? undefined : clean
}

function ensureReference(ref: ImageAttachmentRef): string {
  const match = ID_PATTERN.exec(String(ref.attachmentId))
  if (match?.[1] === undefined) throw new AttachmentError('Attachment reference is invalid.', 'INVALID_ATTACHMENT_REF')
  return match[1]
}

/**
 * Derive the absolute immutable-object path for one normalized attachment.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param ref - durable normalized attachment reference.
 * @returns provider-local path without reading the object.
 */
export function normalizedImagePath(root: string, ref: ImageAttachmentRef): string {
  const sha256 = ensureReference(ref)
  return join(root, 'objects', sha256.slice(0, 2), sha256)
}

async function inspectMetadata(
  data: Uint8Array,
  declaredMediaType: ImageAttachmentRef['mediaType'],
  limits: ImageAttachmentLimits,
): Promise<DetectedImage> {
  if (data.byteLength === 0) throw new AttachmentError('Image is empty.', 'INVALID_IMAGE')
  const detected = await detectImage(data, { maxPixels: limits.maxImagePixels, maxDimension: limits.maxImageDimension })
  if (detected.mediaType !== declaredMediaType) throw new AttachmentError('Declared image type does not match its bytes.', 'IMAGE_TYPE_MISMATCH')
  return detected
}

/**
 * Run the full admission policy for one image without touching storage,
 * including normalization: a batch whose members all validate cannot later
 * be refused by the normalized image byte cap during publication.
 * @param input - encoded bytes and declared metadata.
 * @param limits - resolved source admission policy.
 * @param policy - resolved normalization policy.
 * @returns completion after the raster has been decoded and its normalized version proven to fit.
 */
export async function validateImageFile(
  input: SaveImageAttachment,
  limits: ImageAttachmentLimits,
  policy: NormalizationPolicy,
): Promise<void> {
  await prepareImageFile(input, limits, policy)
}

/** Fully prepared normalized object, verified before any batch member is persisted. */
export interface PreparedImageFile {
  /** Deterministic normalized bytes whose digest is {@link ref.attachmentId}. */
  data: Uint8Array
  /** Durable reference describing {@link data}. */
  ref: ImageAttachmentRef
}

/**
 * Decode, normalize, and verify one submitted image without touching storage.
 * @param input - submitted encoded bytes and declared media type.
 * @param limits - source admission policy.
 * @param policy - independent normalization policy.
 * @returns immutable reference facts beside bytes ready for atomic publication.
 */
export async function prepareImageFile(
  input: SaveImageAttachment,
  limits: ImageAttachmentLimits,
  policy: NormalizationPolicy,
): Promise<PreparedImageFile> {
  if (input.data.byteLength > limits.maxImageBytes) {
    throw new AttachmentError('Image exceeds the configured byte limit.', 'IMAGE_TOO_LARGE')
  }
  const detected = await inspectMetadata(input.data, input.mediaType, limits)
  const normalized = await normalizeImage(input.data, detected, policy)
  const sha256 = digest(normalized.data)
  const name = displayName(input.name)
  const downscaled = detected.width !== normalized.width || detected.height !== normalized.height
  return {
    data: normalized.data,
    ref: {
      attachmentId: AttachmentId(`sha256:${sha256}`),
      mediaType: normalized.mediaType,
      width: normalized.width,
      height: normalized.height,
      bytes: normalized.data.byteLength,
      ...(name !== undefined ? { name } : {}),
      ...downscaled ? { originalDimensions: { width: detected.width, height: detected.height } } : {},
    },
  }
}

/**
 * Make a directory's entries durable (fsync on a read-only directory handle).
 * A synced file alone does not survive a crash when its directory entry never
 * reached storage, so the publication directory is synced before a durable
 * reference is reported.
 */
async function syncDirectory(path: string): Promise<void> {
  /* v8 ignore next -- Windows cannot open directory handles; NTFS metadata journaling owns entry durability there. */
  if (process.platform === 'win32') return
  /* v8 ignore start -- Windows cannot exercise directory fsync; POSIX behavior tests enforce this peer. */
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  /* v8 ignore stop */
}

/**
 * Create one private directory tree and persist every ancestor entry up to a
 * caller-vouched durable boundary. The walk deliberately ignores what mkdir
 * reports as newly created: a concurrent first save can create a level this
 * process then merely observes, so "already existed" is not "already durable"
 * — the entry may still be unsynced in the creator, and a crash would drop a
 * directory the session checkpoint already references. Re-syncing a durable
 * entry is harmless; skipping an unsynced one is not.
 * @param path - absolute directory to create.
 * @param boundary - absolute ancestor the caller vouches is already durable.
 */
async function ensureDurableDirectory(path: string, boundary: string): Promise<void> {
  const target = resolve(path)
  const stop = resolve(boundary)
  await mkdir(target, { recursive: true, mode: 0o700 })
  await chmod(target, 0o700)
  let level = target
  while (level !== stop) {
    const parent = dirname(level)
    await syncDirectory(parent)
    /* v8 ignore next -- filesystem-root guard: callers pass a boundary that is an ancestor of path, so the walk reaches it first. */
    if (parent === level) return
    level = parent
  }
}

/**
 * Establish this process's proof that one DSH_HOME entry and every ancestor
 * below the filesystem root are durable. Mere existence is insufficient: a
 * concurrent process may have created the directory but not synced its parent.
 */
async function ensureDurableHome(path: string): Promise<string> {
  const home = resolve(path)
  if (!durableHomes.has(home)) {
    await ensureDurableDirectory(home, parse(home).root)
    durableHomes.add(home)
  }
  return home
}

/**
 * Publish one already verified normalized image below a versioned attachment root.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param prepared - deterministic normalized bytes and reference.
 * @returns durable content-addressed normalized image reference.
 */
export async function commitPreparedImageFile(
  root: string,
  prepared: PreparedImageFile,
): Promise<ImageAttachmentRef> {
  const normalized = prepared.data
  const sha256 = ensureReference(prepared.ref)
  if (digest(normalized) !== sha256 || normalized.byteLength !== prepared.ref.bytes) {
    throw new AttachmentError('Prepared attachment bytes do not match their reference.', 'ATTACHMENT_CORRUPT')
  }
  await publishImmutableObject(root, normalizedImagePath(root, prepared.ref), normalized, sha256)
  return prepared.ref
}

/**
 * Publish one immutable content-addressed object below a versioned attachment
 * root: staged write, fsync, hard-link into place, digest-verified EEXIST
 * deduplication, read-only mode, and durable directory entries from the
 * target's parent up to (excluding) `root`.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param target - absolute final object path below `root`.
 * @param data - exact object bytes whose digest is `sha256`.
 * @param sha256 - hex digest the stored bytes must match on deduplication.
 */
export async function publishImmutableObject(
  root: string,
  target: string,
  data: Uint8Array,
  sha256: string,
): Promise<void> {
  const staged = await stageImmutableObject(root, (function* (): Iterable<Uint8Array> {
    yield data
  })())
  if (staged.sha256 !== sha256) {
    await removeTemporary(staged.path)
    throw new AttachmentError('Attachment bytes do not match their publication digest.', 'ATTACHMENT_CORRUPT')
  }
  await publishStagedObject(root, target, staged)
}

/** Digest and byte count produced while streaming one immutable object to disk. */
export interface StreamedImmutableObject {
  readonly sha256: string
  readonly bytes: number
}

/**
 * Stream one immutable object from bounded chunks into a staging file, then
 * publish it at a digest-derived target without collecting the complete object in memory.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param data - exact object bytes in order.
 * @param targetFor - derive the final absolute target from the completed digest and byte count.
 * @param signal - optional cancellation for source reads and storage writes.
 * @returns digest and exact byte count of the published object.
 */
export async function publishImmutableObjectStream(
  root: string,
  data: AsyncIterable<Uint8Array>,
  targetFor: (sha256: string, bytes: number) => string,
  signal?: AbortSignal,
): Promise<StreamedImmutableObject> {
  const staged = await stageImmutableObject(root, data, signal)
  let target: string
  try {
    target = targetFor(staged.sha256, staged.bytes)
  } catch (error) {
    /* v8 ignore start -- The local target callback constructs a validated reference from this function's digest. */
    await removeTemporary(staged.path)
    throw error
    /* v8 ignore stop */
  }
  await publishStagedObject(root, target, staged)
  return { sha256: staged.sha256, bytes: staged.bytes }
}

/**
 * Publish another durable hard-link name for an existing immutable object.
 * @param root - absolute versioned attachment root.
 * @param source - existing content-addressed object below `root`.
 * @param target - new alias below `root`.
 * @param sha256 - expected object digest for an existing-target race.
 */
export async function publishImmutableAlias(
  root: string,
  source: string,
  target: string,
  sha256: string,
): Promise<void> {
  const parent = dirname(target)
  try {
    const boundary = await ensureDurableHome(dirname(dirname(resolve(root))))
    await ensureDurableDirectory(parent, boundary)
    try {
      await link(source, target)
    } catch (error) {
      /* v8 ignore next -- Private same-filesystem directories make EEXIST the only recoverable link race. */
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      if (await digestFile(target) !== sha256) {
        throw new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
      }
    }
    await chmod(target, 0o400)
    const stop = resolve(root)
    for (let level = parent; level !== stop; level = dirname(level)) {
      await syncDirectory(level)
      /* v8 ignore next -- filesystem-root guard: targets sit below root, so the walk reaches `stop` first. */
      if (dirname(level) === level) break
    }
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unable to persist attachment.', 'ATTACHMENT_WRITE_FAILED', { cause: error })
  }
}

interface StagedImmutableObject extends StreamedImmutableObject {
  readonly path: string
  readonly boundary: string
}

async function stageImmutableObject(
  root: string,
  data: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<StagedImmutableObject> {
  const staging = join(root, 'tmp')
  // Establish DSH_HOME itself against the filesystem root once per process.
  // Every process performs that proof independently, so observing a directory
  // another process created can never be mistaken for durable publication.
  const boundary = await ensureDurableHome(dirname(dirname(resolve(root))))
  await ensureDurableDirectory(staging, boundary)
  const temporary = join(staging, randomUUID())
  let handle
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of data) {
      signal?.throwIfAborted()
      await handle.writeFile(chunk)
      hash.update(chunk)
      bytes += chunk.byteLength
    }
    signal?.throwIfAborted()
    await handle.sync()
    signal?.throwIfAborted()
    await handle.close()
    handle = undefined
    return { path: temporary, boundary, sha256: hash.digest('hex'), bytes }
  } catch (error) {
    /* v8 ignore next -- A descriptor remains open only when write, sync, or close fails. */
    if (handle !== undefined) await handle.close().catch(
      /* v8 ignore next -- Close failure is superseded by the storage operation that entered cleanup. */
      () => {},
    )
    await removeTemporary(temporary)
    if (error instanceof AttachmentError || signal?.aborted === true) throw error
    throw new AttachmentError('Unable to persist attachment.', 'ATTACHMENT_WRITE_FAILED', { cause: error })
  }
}

async function publishStagedObject(
  root: string,
  target: string,
  staged: StagedImmutableObject,
): Promise<void> {
  const parent = dirname(target)
  try {
    await ensureDurableDirectory(parent, staged.boundary)
    try {
      await link(staged.path, target)
    } catch (error) {
      /* v8 ignore next -- Private same-filesystem directories make EEXIST the only recoverable link race. */
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      if (await digestFile(target) !== staged.sha256) {
        throw new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
      }
    }
    // Windows shares the read-only attribute across hard links and refuses to
    // unlink either name once it is set, so discard the staging name first.
    await unlink(staged.path)
    // The target remains the sole link for a new object; this also restores
    // read-only mode when the deduplication path observes an existing object.
    await chmod(target, 0o400)
    // Persist the target entry and close every concurrent parent-creation
    // window before the reference can reach a session checkpoint. The dedup
    // path repeats these syncs because it may observe another writer's link
    // before that writer reaches its own durability boundary.
    const stop = resolve(root)
    for (let level = parent; level !== stop; level = dirname(level)) {
      await syncDirectory(level)
      /* v8 ignore next -- filesystem-root guard: targets sit below root, so the walk reaches `stop` first. */
      if (dirname(level) === level) break
    }
  } catch (error) {
    await removeTemporary(staged.path)
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unable to persist attachment.', 'ATTACHMENT_WRITE_FAILED', { cause: error })
  }
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) hash.update(chunk)
  return hash.digest('hex')
}

async function removeTemporary(path: string): Promise<void> {
  await unlink(path).catch(
    /* v8 ignore next -- Cleanup can observe a staging name already removed after successful linking. */
    (cleanupError: unknown) => {
      /* v8 ignore next -- Any cleanup failure except an absent staging name must remain visible. */
      if (!(cleanupError instanceof Error && 'code' in cleanupError && cleanupError.code === 'ENOENT')) throw cleanupError
    },
  )
}

/**
 * Decode and normalize one image once, then publish the prepared object.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param input - submitted encoded bytes and declared media type.
 * @param limits - resolved source admission policy.
 * @param policy - resolved normalization policy.
 * @returns durable content-addressed normalized image reference.
 */
export async function saveImageFile(
  root: string,
  input: SaveImageAttachment,
  limits: ImageAttachmentLimits,
  policy: NormalizationPolicy,
): Promise<ImageAttachmentRef> {
  return commitPreparedImageFile(root, await prepareImageFile(input, limits, policy))
}

/**
 * Read and verify one content-addressed image.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param ref - reference recorded in the session log.
 * @param signal - optional cancellation for filesystem and verification work.
 * @returns verified bytes and reference.
 * @throws the signal reason when aborted, or an AttachmentError when verification fails.
 */
export async function readImageFile(
  root: string,
  ref: ImageAttachmentRef,
  signal?: AbortSignal,
): Promise<StoredImageAttachment> {
  signal?.throwIfAborted()
  const sha256 = ensureReference(ref)
  let data: Uint8Array
  try {
    data = new Uint8Array(await readFile(normalizedImagePath(root, ref), { signal }))
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new AttachmentError('Attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
    throw new AttachmentError('Unable to read image attachment.', 'ATTACHMENT_READ_FAILED', { cause: error })
  }
  signal?.throwIfAborted()
  if (digest(data) !== sha256) throw new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
  // The digest proves these are the exact bytes admission fully decoded, so
  // the read path only re-derives the header fields (no raster decode, no
  // per-request pixel amplification on history replay).
  const metadata = await probeImage(data)
  signal?.throwIfAborted()
  if (metadata.mediaType !== ref.mediaType || data.byteLength !== ref.bytes
    || metadata.width !== ref.width || metadata.height !== ref.height) {
    throw new AttachmentError('Stored attachment metadata does not match its reference.', 'ATTACHMENT_CORRUPT')
  }
  return { ref, data }
}
