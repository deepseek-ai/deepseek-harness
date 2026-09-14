/** Durable DeepSeek attachment-to-file-id index. @module dsh-llm-deepseek/upload-index */

import { createHash } from 'node:crypto'
import { readFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentId, ImageVariantId as ImageVariantIdType } from '@deepseek-ai/dsh-attachment'
import { DeepSeekFileId, DeepSeekFileScope } from './file-id.ts'
import type { DeepSeekFileId as DeepSeekFileIdType, DeepSeekFileScope as DeepSeekFileScopeType } from './file-id.ts'

/** One durable remote upload mapping. Unix times are milliseconds. */
export interface DeepSeekUploadRecord {
  scope: DeepSeekFileScopeType
  /** Provider-independent normalized attachment from which the uploaded request version was derived. */
  attachmentId: AttachmentId
  /** Complete request transformation identity, including route budgets and encoder parameters. */
  variantId: ImageVariantIdType
  fileId: DeepSeekFileIdType
  bytes: number
  createdAt: number
  expiresAt: number
}

interface StoredIndex {
  formatVersion: 3
  records: DeepSeekUploadRecord[]
}

class InvalidUploadIndexError extends Error {}

/** Candidate commit outcome when another process already published a reusable upload. */
export interface UploadIndexCommit {
  record: DeepSeekUploadRecord
  accepted: boolean
}

/**
 * Derive a non-secret stable index namespace without persisting or logging the API key.
 * @param baseURL - normalized provider endpoint namespace.
 * @param apiKey - resolved credential used only as hash input.
 * @returns branded SHA-256 namespace digest.
 */
export function deepSeekFileScope(baseURL: string, apiKey: string): DeepSeekFileScopeType {
  const digest = createHash('sha256')
    .update(baseURL.replace(/\/+$/u, ''))
    .update('\0')
    .update(apiKey)
    .digest('hex')
  return DeepSeekFileScope(digest)
}

function absent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function parseRecord(value: unknown): DeepSeekUploadRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidUploadIndexError('llm-deepseek: upload index contains a non-object record')
  }
  const record = value as Record<string, unknown>
  if (typeof record.scope !== 'string' || !/^[0-9a-f]{64}$/u.test(record.scope)
    || typeof record.attachmentId !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(record.attachmentId)
    || typeof record.variantId !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(record.variantId)
    || typeof record.fileId !== 'string' || record.fileId.length === 0
    || !Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0
    || !Number.isSafeInteger(record.createdAt) || (record.createdAt as number) < 0
    || !Number.isSafeInteger(record.expiresAt) || (record.expiresAt as number) < 0) {
    throw new InvalidUploadIndexError('llm-deepseek: upload index contains an invalid record')
  }
  return {
    scope: DeepSeekFileScope(record.scope),
    attachmentId: record.attachmentId as AttachmentId,
    variantId: ImageVariantId(record.variantId),
    fileId: DeepSeekFileId(record.fileId),
    bytes: record.bytes as number,
    createdAt: record.createdAt as number,
    expiresAt: record.expiresAt as number,
  }
}

function parseIndex(text: string): StoredIndex {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error: unknown) {
    throw new InvalidUploadIndexError('llm-deepseek: upload index is not valid JSON', { cause: error })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidUploadIndexError('llm-deepseek: upload index is not an object')
  }
  const index = value as { formatVersion?: unknown; records?: unknown }
  if (index.formatVersion !== 3 || !Array.isArray(index.records)) {
    throw new InvalidUploadIndexError('llm-deepseek: unsupported upload index format')
  }
  const records = index.records.map(parseRecord)
  const keys = new Set<string>()
  for (const record of records) {
    const key = `${record.scope}\0${record.variantId}`
    if (keys.has(key)) throw new InvalidUploadIndexError('llm-deepseek: upload index contains duplicate mappings')
    keys.add(key)
  }
  return { formatVersion: 3, records }
}

function reusable(record: DeepSeekUploadRecord, now: number, refreshMarginMs: number): boolean {
  return record.expiresAt - now > refreshMarginMs
}

/** Atomic local index shared by every DeepSeek session in this DSH home. */
export class DeepSeekUploadIndex {
  /** Absolute owner-private JSON index path. */
  readonly path: string

  /**
   * @param path - explicit test path; omission uses `DSH_HOME/llm-deepseek/files-v3.json`.
   */
  constructor(path = join(resolveDshHome(), 'llm-deepseek', 'files-v3.json')) {
    this.path = path
  }

  private async load(): Promise<StoredIndex> {
    try {
      return parseIndex(await readFile(this.path, 'utf8'))
    } catch (error: unknown) {
      if (absent(error) || error instanceof InvalidUploadIndexError) {
        return { formatVersion: 3, records: [] }
      }
      throw error
    }
  }

  private async save(index: StoredIndex): Promise<void> {
    await writeFileAtomic(this.path, `${JSON.stringify(index, undefined, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  }

  /**
   * Read one reusable mapping.
   * @param scope - endpoint/API-key namespace.
   * @param variantId - complete request-image transformation identity.
   * @param now - current Unix time in milliseconds.
   * @param refreshMarginMs - remaining lifetime below which a mapping is not reused.
   * @returns the mapping when it has enough lifetime remaining.
   */
  async get(
    scope: DeepSeekFileScopeType,
    variantId: ImageVariantIdType,
    now: number,
    refreshMarginMs: number,
  ): Promise<DeepSeekUploadRecord | undefined> {
    const record = (await this.load()).records.find(candidate => (
      candidate.scope === scope && candidate.variantId === variantId
    ))
    return record !== undefined && reusable(record, now, refreshMarginMs) ? record : undefined
  }

  /**
   * Publish a completed upload unless another process already published a reusable mapping.
   * @param candidate - completed remote upload.
   * @param now - current Unix time in milliseconds.
   * @param refreshMarginMs - minimum reusable remaining lifetime.
   * @returns the winning record and whether the candidate entered the index.
   */
  async commit(
    candidate: DeepSeekUploadRecord,
    now: number,
    refreshMarginMs: number,
  ): Promise<UploadIndexCommit> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    return withFileLock(this.path, async () => {
      const index = await this.load()
      const existing = index.records.find(record => (
        record.scope === candidate.scope
        && record.variantId === candidate.variantId
        && reusable(record, now, refreshMarginMs)
      ))
      if (existing !== undefined) return { record: existing, accepted: false }
      const records = index.records.filter(record => (
        reusable(record, now, refreshMarginMs)
        && !(record.scope === candidate.scope && record.variantId === candidate.variantId)
      ))
      records.push(candidate)
      await this.save({ formatVersion: 3, records })
      return { record: candidate, accepted: true }
    })
  }

  /**
   * Remove one exact mapping without deleting a concurrently installed successor.
   * @param scope - endpoint/API-key namespace.
   * @param variantId - complete request-image transformation identity.
   * @param fileId - exact remote generation being invalidated.
   */
  async remove(
    scope: DeepSeekFileScopeType,
    variantId: ImageVariantIdType,
    fileId: DeepSeekFileIdType,
  ): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await withFileLock(this.path, async () => {
      const index = await this.load()
      const records = index.records.filter(record => !(
        record.scope === scope && record.variantId === variantId && record.fileId === fileId
      ))
      if (records.length !== index.records.length) await this.save({ formatVersion: 3, records })
    })
  }

  /**
   * Remove every local mapping for one remote namespace.
   * @param scope - endpoint/API-key namespace.
   */
  async clear(scope: DeepSeekFileScopeType): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await withFileLock(this.path, async () => {
      const index = await this.load()
      const records = index.records.filter(record => record.scope !== scope)
      if (records.length !== index.records.length) await this.save({ formatVersion: 3, records })
    })
  }
}
