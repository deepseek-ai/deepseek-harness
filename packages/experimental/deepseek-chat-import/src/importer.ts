/**
 * Import of a complete DeepSeek chat export held in memory into a
 * caller-chosen Workspace, one conversation at a time.
 *
 * `chat_session_index.json` selects the conversations to import. One streaming
 * pass then stores the images of every chosen conversation and a second
 * converts and writes each chosen conversation as its entry arrives. Nothing
 * is inflated for a conversation the index did not choose.
 */

import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import type { ImageAttachmentRef, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { Session, SESSION_FORMAT_VERSION, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { convertConversation, selectBranch } from './conversation.ts'
import type { ConvertConversationOptions, ConvertedConversation } from './conversation.ts'
import {
  exportManifest, exportSessionFile, exportSessionIndex, parseKnownFragment, SUPPORTED_EXPORT_FORMAT_VERSION,
} from './format.ts'
import type { ExportSessionFile } from './format.ts'
import { ExportEntryError, ExportSourceError, openExportArchive } from './archive.ts'
import type { ExportArchive, ExportEntryInfo, ExportStreamHandler } from './archive.ts'
import type { DeepseekChatImportFailureReason, DeepseekChatImportResult, DeepseekChatImportSkip } from './types.ts'

/** The archive entry naming the export format version. */
const MANIFEST_ENTRY = 'manifest.json'
/** The archive entry listing every conversation with its order. */
const INDEX_ENTRY = 'chat_session_index.json'
/** A conversation file; the id is the entry name. */
const CONVERSATION_ENTRY = /^chat_sessions\/([^/]+)\.json$/u
/** An image file; the first path segment is the id of the conversation it belongs to. */
const IMAGE_ENTRY = /^chat_sessions\/([^/]+)_files\/[^/]+$/u

/** Services and inputs one import uses. */
export interface DeepseekChatImportDependencies {
  /** Durable store receiving each imported Session; a `SessionPersistence` satisfies it. */
  readonly persistence: {
    create(header: SessionHeader, options: { signal: AbortSignal }): Promise<Pick<SessionHandle, 'append' | 'flush' | 'close'>>
  }
  /** Optional Session-list projection cache refreshed after each write. */
  readonly projectionCache?: {
    coldSnapshot(header: SessionHeader, inheritedEventCount: SessionLogOffset, events: readonly SessionEvent[]): unknown
  } | undefined
  /** Optional image store; without it, exported images become synthetic file cards. */
  readonly attachments?: { saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> } | undefined
  /**
   * Whether the target Workspace is still registered; checked before each write.
   * @param workspaceId - id of the target Workspace.
   * @returns false once the Workspace was removed.
   */
  readonly workspaceRegistered: (workspaceId: string) => boolean
  /** Mint unique Session, message, and tool-call ids. */
  readonly createId: () => string
  /** Diagnostic for each conversation that was not imported and each image left as a synthetic file card. */
  readonly warn: (message: string) => void
}

/** The Workspace receiving the imported Sessions; a registry `Workspace` satisfies it. */
export interface DeepseekChatImportWorkspace {
  /** Workspace id reported in the result. */
  readonly id: string
  /** Canonical existing directory, used as every imported Session's working directory. */
  readonly path: string
  /**
   * Record one stored Session as a member.
   * @param sessionId - Session whose header cwd is {@link path}.
   */
  attachSession(sessionId: SessionId): Promise<void>
}

/** Deployment limits of one import. */
export interface DeepseekChatImportLimits {
  /** Maximum number of Sessions to write. */
  readonly maxSessions: number
  /** Largest declared uncompressed size of one archive entry. */
  readonly maxEntryBytes: number
  /** Largest UTF-8 size of an imported title. */
  readonly maxTitleBytes: number
}

/** One import request. */
export interface DeepseekChatImportRequest {
  /** Complete export ZIP bytes. */
  readonly archive: Uint8Array
  /** Workspace receiving the Sessions. */
  readonly workspace: DeepseekChatImportWorkspace
  /** Session count and size limits. */
  readonly limits: DeepseekChatImportLimits
  /**
   * Progress after the selection and after each imported Session.
   * @param done - Sessions imported so far.
   * @param total - Sessions the import tries to write.
   */
  readonly onProgress: (done: number, total: number) => void
}

const IMAGE_MEDIA_TYPES: ReadonlyMap<string, ImageMediaType> = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
])

/** One `chat_session_index.json` row, ordered by its index. */
interface RankedRow {
  readonly id: string
  readonly insertedAt: number
  readonly updatedAt: number
}

/** One image of the imported branch, named by its `export_path`. */
interface PlannedImage {
  /** The `FILE` entry id the converted `image` block refers to. */
  readonly fileId: string
}

/** What the image pass holds for one archive entry. */
type StoredImage =
  | { readonly stored: true; readonly ref: ImageAttachmentRef }
  | { readonly stored: false; readonly reason: string }

/** The `reason` of each metadata entry that cannot be read, by whether it is absent or damaged. */
interface MetadataReasons {
  readonly missing: DeepseekChatImportFailureReason
  readonly damaged: DeepseekChatImportFailureReason
}

/**
 * Import the conversations selected by the export index into a Workspace.
 *
 * Failures detected before the passes (an unreadable archive, a missing or
 * unreadable manifest or index, an oversized manifest or index entry, no
 * conversation) write nothing; an archive whose structure breaks during a pass
 * fails with `unreadable-archive` after the Sessions delivered before the break
 * were written. One streaming pass stores the images of every chosen
 * conversation before any conversation is parsed; a second converts each chosen
 * conversation as its entry arrives and looks the stored references up. Each
 * converted conversation is seed-validated with `Session.create` before it is
 * written; a conversation that fails is reported in `skipped`, the next older
 * conversation the index lists takes its place, and the others continue. That
 * replacement is read by name, so `ExportArchive.read` re-parses the central
 * directory once for it and a further image pass collects its images; neither
 * cost grows with the number of images.
 * @param deps - storage, Workspace, and id services.
 * @param request - archive bytes, target Workspace, limits, and progress callback.
 * @param signal - cancellation, checked between steps; written Sessions remain.
 * @returns the import summary.
 * @throws {ExportSourceError} for an archive-level failure, or `workspace-not-found` when the Workspace is removed during the import.
 */
export async function importDeepseekChatExport(
  deps: DeepseekChatImportDependencies,
  request: DeepseekChatImportRequest,
  signal: AbortSignal,
): Promise<DeepseekChatImportResult> {
  const { limits, workspace } = request
  const archive = await openExportArchive(request.archive, limits.maxEntryBytes, signal)
  const skipped: DeepseekChatImportSkip[] = []
  const report = (item: DeepseekChatImportSkip): void => {
    skipped.push(item)
    deps.warn(`deepseek-chat-import: conversation ${item.conversationId} was not imported: ${item.reason}`)
  }

  const manifest = await readMetadata(archive, MANIFEST_ENTRY, { missing: 'missing-manifest', damaged: 'unreadable-archive' }, signal)
  // The version gates every later conversion, so it is checked before the index is read.
  const version = exportManifest.safeParse(parseJson(manifest))
  if (!version.success || version.data.export_format_version !== SUPPORTED_EXPORT_FORMAT_VERSION) {
    throw new ExportSourceError('unsupported-version', `manifest.json must declare export_format_version ${SUPPORTED_EXPORT_FORMAT_VERSION}`)
  }
  const index = await readMetadata(archive, INDEX_ENTRY, { missing: 'missing-index', damaged: 'missing-index' }, signal)
  const ranked = parseIndex(index)
  const total = Math.min(limits.maxSessions, ranked.length)
  const chosen = new Map(ranked.slice(0, total).map((row, rank) => [row.id, rank]))
  request.onProgress(0, total)

  const options = { createId: deps.createId, maxTitleBytes: limits.maxTitleBytes }
  const imported: Array<{ id: SessionId; rank: number }> = []
  /** Chosen conversations whose archive entry was handled, successfully or not. */
  const handled = new Set<string>()
  /** Chosen conversations still owed a written Session because an attempt failed. */
  let outstanding = 0
  /** Rank of the next older conversation a failure may replace. */
  let next = total

  /** A Workspace removed at any point stops the import before the next write. */
  const assertWorkspace = async (): Promise<void> => {
    if (!deps.workspaceRegistered(workspace.id) || !await isDirectory(workspace.path)) {
      throw new ExportSourceError('workspace-not-found', `workspace ${workspace.id} was removed during the import`)
    }
  }

  // The image pass runs before any conversation is parsed, so archive entry
  // order does not matter and the conversation pass only looks the references
  // up. An image whose conversation later fails stays stored without a
  // referencing event; attachment storage offers no removal. Checking the
  // Workspace first avoids storing images for a target that is already gone.
  await assertWorkspace()
  const storedImages = await storeImages(deps, archive, new Set(chosen.keys()), signal)
  signal.throwIfAborted()

  /** Write one converted conversation; false when it was reported as skipped. */
  const write = async (conversion: ConvertedConversation, rank: number, conversationId: string, title: string | null): Promise<boolean> => {
    let id: SessionId
    try {
      id = await writeSession(deps, conversion, workspace.path, signal)
      await attachSession(workspace, id)
    } catch (error) {
      signal.throwIfAborted()
      report({ conversationId, title, reason: errorText(error) })
      return false
    }
    imported.push({ id, rank })
    request.onProgress(imported.length, total)
    return true
  }

  const importConversation = async (conversationId: string, data: Uint8Array): Promise<void> => {
    await assertWorkspace()
    // oxlint-disable-next-line typescript/no-non-null-assertion -- select asks only for chosen conversations
    const rank = chosen.get(conversationId)!
    handled.add(conversationId)
    let file: ExportSessionFile | undefined
    let conversion: ConvertedConversation
    try {
      file = parseConversation(data)
      conversion = convertWithStoredImages(deps, file, storedImages, options)
    } catch (error) {
      signal.throwIfAborted()
      outstanding += 1
      report({ conversationId, title: file?.title ?? null, reason: errorText(error) })
      return
    }
    if (!await write(conversion, rank, conversationId, file.title)) outstanding += 1
  }

  const handler: ExportStreamHandler = {
    select: (entry: ExportEntryInfo) => {
      const conversation = conversationIdOf(entry.name)
      return conversation !== undefined && chosen.has(conversation)
    },
    reject: (entry, error) => {
      const conversation = conversationIdOf(entry.name)
      if (conversation === undefined) return
      const rank = chosen.get(conversation)
      if (rank === undefined) return
      handled.add(conversation)
      outstanding += 1
      report({ conversationId: conversation, title: null, reason: error.message })
    },
    entry: async (entry, data) => {
      // select admits only chosen conversation entries, whose names carry the id.
      // oxlint-disable-next-line typescript/no-non-null-assertion -- select matched CONVERSATION_ENTRY
      await importConversation(conversationIdOf(entry.name)!, data)
    },
  }
  await archive.stream(handler, signal)
  signal.throwIfAborted()

  // A chosen conversation the archive never carried: report it and let an older
  // conversation the index lists take its place.
  for (const [conversationId] of chosen) {
    if (handled.has(conversationId)) continue
    outstanding += 1
    report({ conversationId, title: null, reason: 'the export has no file for this conversation' })
  }
  while (outstanding > 0 && next < ranked.length) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- while condition: next < ranked.length
    const row = ranked[next]!
    next += 1
    if (await attemptRow(row, next - 1)) outstanding -= 1
  }
  imported.sort((left, right) => left.rank - right.rank)
  return {
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    sessionIds: imported.map(item => item.id),
    conversationCount: ranked.length,
    omittedByLimit: ranked.length - next,
    skipped,
  }

  /**
   * Read one ranked conversation by name, collect the images it references
   * with one image pass, and write it. This path serves the conversations a
   * failure pulled in after the conversation pass; `read` re-parses the central
   * directory once for the conversation file.
   */
  async function attemptRow(row: RankedRow, rank: number): Promise<boolean> {
    await assertWorkspace()
    const entry = conversationEntry(row.id)
    let file: ExportSessionFile | undefined
    let conversion: ConvertedConversation
    try {
      const data = await archive.read(entry, signal)
      if (data === undefined) throw new ExportEntryError(`${entry} is not in the export`, false)
      file = parseConversation(data)
      // The image pass shares this try, so a missing parent or a malformed
      // fragment skips this conversation instead of the whole import.
      const images = imagePlan(file).size === 0
        ? new Map<string, StoredImage>()
        : await storeImages(deps, archive, new Set([row.id]), signal)
      conversion = convertWithStoredImages(deps, file, images, options)
    } catch (error) {
      signal.throwIfAborted()
      report({ conversationId: row.id, title: file?.title ?? null, reason: errorText(error) })
      return false
    }
    return write(conversion, rank, row.id, file.title)
  }
}

/**
 * Store the images of the chosen conversations in one streaming pass, keyed by
 * entry name. Only `chat_sessions/{id}_files/…` entries whose id is one of
 * `conversations` are inflated, one at a time; a conversation entry is skipped.
 * Each handled entry records either the stored reference or why it was not
 * stored, so the conversation pass can warn with that reason.
 * @param deps - services, for the attachment store.
 * @param archive - open archive.
 * @param conversations - ids of the conversations whose images to store.
 * @param signal - cancellation.
 * @returns the outcome for each image entry name.
 */
async function storeImages(
  deps: DeepseekChatImportDependencies,
  archive: ExportArchive,
  conversations: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<Map<string, StoredImage>> {
  const stored = new Map<string, StoredImage>()
  const attachments = deps.attachments
  if (attachments === undefined) return stored
  const handler: ExportStreamHandler = {
    select: (entry) => {
      const conversation = imageConversationIdOf(entry.name)
      if (conversation === undefined || !conversations.has(conversation)) return false
      if (imageMediaTypeOf(entry.name) !== undefined) return true
      // The entry is never inflated; the conversation pass reports the type
      // only if the selected branch references it.
      stored.set(entry.name, { stored: false, reason: 'unsupported image type' })
      return false
    },
    reject: (entry, error) => {
      const conversation = imageConversationIdOf(entry.name)
      if (conversation === undefined || !conversations.has(conversation)) return
      stored.set(entry.name, { stored: false, reason: error.message })
    },
    entry: async (entry, data) => {
      // select admitted only an image entry whose extension it recognized.
      // oxlint-disable-next-line typescript/no-non-null-assertion -- select checked the extension
      const mediaType = imageMediaTypeOf(entry.name)!
      try {
        const ref = await attachments.saveImage({ data, mediaType, name: imageNameOf(entry.name) })
        stored.set(entry.name, { stored: true, ref })
      } catch (error) {
        signal.throwIfAborted()
        stored.set(entry.name, { stored: false, reason: errorText(error) })
      }
    },
  }
  await archive.stream(handler, signal)
  return stored
}

/**
 * Convert one conversation with the references the image pass stored. That pass
 * runs before this conversion, so an image whose conversation later fails
 * conversion or `Session.create` seed validation is already stored without a
 * referencing event; neither `SessionPersistence` nor the attachment store
 * offers a removal.
 * @param deps - services, for the attachment service and diagnostics.
 * @param file - one validated conversation file.
 * @param stored - image outcomes of the pass, keyed by entry name.
 * @param options - id source and title limit.
 * @returns the conversion, with an `image` block for every stored image.
 * @throws {ExportConversationError} when the tree or a mapped fragment is invalid.
 */
function convertWithStoredImages(
  deps: DeepseekChatImportDependencies,
  file: ExportSessionFile,
  stored: ReadonlyMap<string, StoredImage>,
  options: ConvertConversationOptions,
): ConvertedConversation {
  if (deps.attachments === undefined) return convertConversation(file, options)
  const images = referencedImages(deps.warn, imagePlan(file), stored)
  return convertConversation(file, images.size === 0 ? options : { ...options, images })
}

/**
 * Read one metadata entry the import needs before the streaming pass.
 * @param archive - open archive.
 * @param name - entry name to read.
 * @param reasons - failure category when the entry is absent or unreadable.
 * @param signal - cancellation.
 * @returns the entry bytes.
 * @throws {ExportSourceError} with `too-large` for an oversized entry, and the given reason otherwise.
 */
async function readMetadata(
  archive: ExportArchive, name: string, reasons: MetadataReasons, signal: AbortSignal,
): Promise<Uint8Array> {
  let bytes: Uint8Array | undefined
  try {
    bytes = await archive.read(name, signal)
  } catch (error) {
    signal.throwIfAborted()
    // Apart from cancellation, `read` fails only with an ExportEntryError.
    const entryError = error as ExportEntryError
    throw new ExportSourceError(entryError.oversized ? 'too-large' : reasons.damaged, entryError.message, { cause: error })
  }
  if (bytes === undefined) throw new ExportSourceError(reasons.missing, `the archive has no ${name}`)
  return bytes
}

/**
 * Rank the conversations the index lists, most recently updated first.
 * @param bytes - `chat_session_index.json` bytes.
 * @returns the distinct conversations, most recent first.
 * @throws {ExportSourceError} `missing-index` when the entry is not a conversation index, `no-conversations` when it lists none.
 */
function parseIndex(bytes: Uint8Array): RankedRow[] {
  const parsed = exportSessionIndex.safeParse(parseJson(bytes))
  if (!parsed.success) throw new ExportSourceError('missing-index', 'the archive has no readable chat_session_index.json')
  const rows = new Map<string, RankedRow>()
  for (const row of parsed.data) {
    if (rows.has(row.id)) continue
    rows.set(row.id, { id: row.id, insertedAt: row.inserted_at, updatedAt: row.updated_at })
  }
  if (rows.size === 0) throw new ExportSourceError('no-conversations', 'the export contains no importable conversation')
  return [...rows.values()].sort(compareRanks)
}

/** Order two index rows: most recently updated first, then most recently inserted, then by id. */
function compareRanks(left: RankedRow, right: RankedRow): number {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
  if (left.insertedAt !== right.insertedAt) return right.insertedAt - left.insertedAt
  return left.id < right.id ? -1 : 1
}

/** The conversation id one archive entry name carries, or undefined for another entry. */
function conversationIdOf(name: string): string | undefined {
  return CONVERSATION_ENTRY.exec(name)?.[1]
}

/** The conversation id one image entry name carries, or undefined for another entry. */
function imageConversationIdOf(name: string): string | undefined {
  return IMAGE_ENTRY.exec(name)?.[1]
}

/** The media type of one image entry, or undefined when its extension is not supported. */
function imageMediaTypeOf(name: string): ImageMediaType | undefined {
  return IMAGE_MEDIA_TYPES.get(extname(name).toLowerCase())
}

/**
 * A UUID file id starts every export image entry name, followed by `_`; older
 * archives use `-` instead.
 */
const IMAGE_FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[_-]/iu

/**
 * The display name of one image entry: its leaf name without the leading file
 * id. The export names the entry `{file_id}_{file_name}`, so the rest is the
 * original file name even when it contains underscores.
 * @param name - image entry name, such as `chat_sessions/{id}_files/{file_id}_{file_name}`.
 * @returns the file name without the file id.
 */
function imageNameOf(name: string): string {
  const leaf = name.slice(name.lastIndexOf('/') + 1)
  return leaf.replace(IMAGE_FILE_ID, '')
}

/** The archive entry name of one conversation. */
function conversationEntry(id: string): string {
  return `chat_sessions/${id}.json`
}

/**
 * Decompress and validate one conversation file's bytes.
 * @param data - complete uncompressed entry bytes.
 * @returns the validated conversation.
 * @throws {Error} naming the JSON or schema defect.
 */
function parseConversation(data: Uint8Array): ExportSessionFile {
  const json = parseJson(data)
  if (json === undefined) throw new Error('invalid conversation file: not valid JSON')
  const parsed = exportSessionFile.safeParse(json)
  if (!parsed.success) throw new Error(`invalid conversation file: ${parsed.error.issues.map(issue => issue.message).join('; ')}`)
  return parsed.data
}

/**
 * Plan the images of the imported branch by `export_path`.
 * @param file - one validated conversation file.
 * @returns each image's `FILE` id by `export_path`.
 */
function imagePlan(file: ExportSessionFile): Map<string, PlannedImage> {
  const plan = new Map<string, PlannedImage>()
  for (const message of selectBranch(file)) {
    if (message.role !== 'USER') continue
    for (const envelope of message.fragments) {
      // Conversion already validated every mapped fragment of this branch.
      const fragment = parseKnownFragment(envelope)
      if (fragment?.type !== 'FILE') continue
      for (const entry of fragment.files) {
        if (!entry.is_image || entry.export_path === null) continue
        plan.set(entry.export_path, { fileId: entry.id })
      }
    }
  }
  return plan
}

/**
 * Map the images of one conversation to the references the image pass stored.
 * An entry the pass did not handle or could not store becomes a synthetic file
 * card with one warning naming the reason.
 * @param warn - diagnostic for an image that was not stored.
 * @param plan - images of the selected branch, keyed by `export_path`.
 * @param stored - image outcomes of the pass, keyed by entry name.
 * @returns the stored references keyed by export file id.
 */
function referencedImages(
  warn: (message: string) => void,
  plan: ReadonlyMap<string, PlannedImage>,
  stored: ReadonlyMap<string, StoredImage>,
): Map<string, ImageAttachmentRef> {
  const images = new Map<string, ImageAttachmentRef>()
  for (const [path, planned] of plan) {
    const outcome = stored.get(path)
    if (outcome === undefined) {
      warn(`deepseek-chat-import: image ${path} is not stored: not in the export`)
      continue
    }
    if (!outcome.stored) {
      warn(`deepseek-chat-import: image ${path} is not stored: ${outcome.reason}`)
      continue
    }
    images.set(planned.fileId, outcome.ref)
  }
  return images
}

/** Record one stored Session as a Workspace member, naming the stored id when that fails. */
async function attachSession(workspace: DeepseekChatImportWorkspace, id: SessionId): Promise<void> {
  try {
    await workspace.attachSession(id)
  } catch (error) {
    // SessionPersistence offers no removal, so the stored Session stays outside the Workspace.
    throw new Error(`stored as Session ${id} but not added to the workspace: ${errorText(error)}`, { cause: error })
  }
}

async function writeSession(
  deps: DeepseekChatImportDependencies,
  conversion: ConvertedConversation,
  cwd: string,
  signal: AbortSignal,
): Promise<SessionId> {
  const id = SessionId(deps.createId())
  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id, createdAt: conversion.createdAt, cwd, isSeeded: false }
  // Construction runs the same seed validation as a live Session; the detached instance is discarded.
  Session.create(id, conversion.events, header)
  signal.throwIfAborted()
  const handle = await deps.persistence.create(header, { signal })
  try {
    await handle.append(conversion.events)
    await handle.flush()
  } finally {
    await handle.close()
  }
  deps.projectionCache?.coldSnapshot(header, SessionLogOffset(0), conversion.events)
  return id
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (_missing) {
    // A path that cannot be read is treated like a removed directory.
    return false
  }
}

/** Decode one JSON file; undefined marks text that is not JSON, since JSON cannot encode undefined. */
function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch (_invalidJson) {
    // The caller reports the file as invalid.
    return undefined
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
