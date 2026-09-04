import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import { DeepSeekFileId } from '../src/file-id.ts'
import { deepSeekFileScope, DeepSeekUploadIndex } from '../src/upload-index.ts'

const ATTACHMENT = AttachmentId(`sha256:${'a'.repeat(64)}`)
const VARIANT = ImageVariantId(`sha256:${'b'.repeat(64)}`)

/** Every temp index root created by this file, removed after each test. */
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('DeepSeekUploadIndex', () => {
  it('normalizes trailing endpoint slashes in the credential scope', () => {
    expect(deepSeekFileScope('https://api.deepseek.com///', 'key'))
      .toBe(deepSeekFileScope('https://api.deepseek.com', 'key'))
  })

  it('isolates API-key namespaces and reuses only records above the refresh margin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-upload-index-'))
    roots.push(dir)
    const index = new DeepSeekUploadIndex(join(dir, 'index.json'))
    const first = deepSeekFileScope('https://api.deepseek.com', 'first-key')
    const second = deepSeekFileScope('https://api.deepseek.com', 'second-key')
    const record = {
      scope: first,
      attachmentId: ATTACHMENT,
      variantId: VARIANT,
      fileId: DeepSeekFileId('file-api-one'),
      bytes: 3,
      createdAt: 1_000,
      expiresAt: 10_000,
    }

    await expect(index.commit(record, 1_000, 1_000)).resolves.toMatchObject({ accepted: true })
    await expect(index.get(first, VARIANT, 1_000, 1_000)).resolves.toEqual(record)
    await expect(index.get(second, VARIANT, 1_000, 1_000)).resolves.toBeUndefined()
    await expect(index.get(first, VARIANT, 9_000, 1_000)).resolves.toBeUndefined()
  })

  it('keeps a reusable cross-process winner and removes only an exact generation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-upload-index-'))
    roots.push(dir)
    const index = new DeepSeekUploadIndex(join(dir, 'index.json'))
    const scope = deepSeekFileScope('https://api.deepseek.com', 'key')
    const first = {
      scope, attachmentId: ATTACHMENT, variantId: VARIANT,
      fileId: DeepSeekFileId('file-api-first'), bytes: 3, createdAt: 1, expiresAt: 10_000,
    }
    const duplicate = { ...first, fileId: DeepSeekFileId('file-api-duplicate') }
    await index.commit(first, 1, 1)

    await expect(index.commit(duplicate, 2, 1)).resolves.toEqual({ record: first, accepted: false })
    await index.remove(scope, VARIANT, duplicate.fileId)
    await expect(index.get(scope, VARIANT, 2, 1)).resolves.toEqual(first)
    await index.remove(scope, VARIANT, first.fileId)
    await expect(index.get(scope, VARIANT, 2, 1)).resolves.toBeUndefined()
  })

  it('treats a corrupt upload cache as empty and repairs it on the next commit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-upload-index-'))
    roots.push(dir)
    const path = join(dir, 'index.json')
    await writeFile(path, '{bad', 'utf8')
    const index = new DeepSeekUploadIndex(path)
    const scope = deepSeekFileScope('https://api.deepseek.com', 'key')
    const record = {
      scope,
      attachmentId: ATTACHMENT,
      variantId: VARIANT,
      fileId: DeepSeekFileId('file-api-repaired'),
      bytes: 3,
      createdAt: 1,
      expiresAt: 10_000,
    }

    await expect(index.get(scope, VARIANT, 1, 1)).resolves.toBeUndefined()
    await expect(index.commit(record, 1, 1)).resolves.toEqual({ record, accepted: true })
    await expect(index.get(scope, VARIANT, 1, 1)).resolves.toEqual(record)
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ formatVersion: 3 })
  })

  it.each([
    'null',
    '[]',
    '{}',
    '{"formatVersion":1,"records":[]}',
    '{"formatVersion":2,"records":[]}',
    '{"formatVersion":3,"records":null}',
    '{"formatVersion":3,"records":[null]}',
    '{"formatVersion":3,"records":[[]]}',
    '{"formatVersion":3,"records":[{}]}',
    `{"formatVersion":3,"records":[${JSON.stringify({
      scope: 'x'.repeat(64), attachmentId: ATTACHMENT, variantId: VARIANT,
      fileId: 'file-api-one', bytes: 3, createdAt: 1, expiresAt: 10_000,
    })}]}`,
    `{"formatVersion":3,"records":[${JSON.stringify({
      scope: 'a'.repeat(64), attachmentId: 'wrong', variantId: VARIANT,
      fileId: 'file-api-one', bytes: 3, createdAt: 1, expiresAt: 10_000,
    })}]}`,
    `{"formatVersion":3,"records":[${JSON.stringify({
      scope: 'a'.repeat(64), attachmentId: ATTACHMENT, variantId: 'wrong',
      fileId: 'file-api-one', bytes: 3, createdAt: 1, expiresAt: 10_000,
    })}]}`,
    `{"formatVersion":3,"records":[${JSON.stringify({
      scope: 'a'.repeat(64), attachmentId: ATTACHMENT, variantId: VARIANT,
      fileId: '', bytes: 3, createdAt: 1, expiresAt: 10_000,
    })}]}`,
    `{"formatVersion":3,"records":[${JSON.stringify({
      scope: 'a'.repeat(64), attachmentId: ATTACHMENT, variantId: VARIANT,
      fileId: 'file-api-one', bytes: -1, createdAt: 1, expiresAt: 10_000,
    })}]}`,
    `{"formatVersion":3,"records":[${JSON.stringify({
      scope: 'a'.repeat(64), attachmentId: ATTACHMENT, variantId: VARIANT,
      fileId: 'file-api-one', bytes: 1.5, createdAt: 1, expiresAt: 10_000,
    })}]}`,
    `{"formatVersion":3,"records":[${JSON.stringify({
      scope: 'a'.repeat(64), attachmentId: ATTACHMENT, variantId: VARIANT,
      fileId: 'file-api-one', bytes: 3, createdAt: -1, expiresAt: 10_000,
    })}]}`,
    `{"formatVersion":3,"records":[${JSON.stringify({
      scope: 'a'.repeat(64), attachmentId: ATTACHMENT, variantId: VARIANT,
      fileId: 'file-api-one', bytes: 3, createdAt: 1.5, expiresAt: 10_000,
    })}]}`,
    `{"formatVersion":3,"records":[${JSON.stringify({
      scope: 'a'.repeat(64), attachmentId: ATTACHMENT, variantId: VARIANT,
      fileId: 'file-api-one', bytes: 3, createdAt: 1, expiresAt: -1,
    })}]}`,
    `{"formatVersion":3,"records":[${JSON.stringify({
      scope: 'a'.repeat(64), attachmentId: ATTACHMENT, variantId: VARIANT,
      fileId: 'file-api-one', bytes: 3, createdAt: 1, expiresAt: 1.5,
    })}]}`,
  ])('treats an invalid persisted index as empty %#', async (text) => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-upload-index-'))
    roots.push(dir)
    const path = join(dir, 'index.json')
    await writeFile(path, text, 'utf8')
    const index = new DeepSeekUploadIndex(path)
    await expect(index.get(
      deepSeekFileScope('https://api.deepseek.com', 'key'), VARIANT, 1, 1,
    )).resolves.toBeUndefined()
  })

  it('rejects duplicate persisted mappings as a corrupt cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-upload-index-'))
    roots.push(dir)
    const path = join(dir, 'index.json')
    const scope = deepSeekFileScope('https://api.deepseek.com', 'key')
    const record = {
      scope, attachmentId: ATTACHMENT, variantId: VARIANT,
      fileId: DeepSeekFileId('file-api-one'), bytes: 3, createdAt: 1, expiresAt: 10_000,
    }
    await writeFile(path, JSON.stringify({ formatVersion: 3, records: [record, record] }), 'utf8')
    const index = new DeepSeekUploadIndex(path)
    await expect(index.get(scope, VARIANT, 1, 1)).resolves.toBeUndefined()
  })

  it('drops expired records on commit and clears only the selected namespace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-upload-index-'))
    roots.push(dir)
    const index = new DeepSeekUploadIndex(join(dir, 'index.json'))
    const first = deepSeekFileScope('https://api.deepseek.com', 'first')
    const second = deepSeekFileScope('https://api.deepseek.com', 'second')
    const expired = {
      scope: first, attachmentId: ATTACHMENT, variantId: VARIANT,
      fileId: DeepSeekFileId('file-api-expired'), bytes: 3, createdAt: 1, expiresAt: 2,
    }
    const live = {
      ...expired, scope: second, fileId: DeepSeekFileId('file-api-live'), expiresAt: 10_000,
    }
    await index.commit(expired, 0, 0)
    await index.commit(live, 3, 1)
    await index.clear(first)
    await index.clear(second)
    await expect(index.get(second, VARIANT, 3, 1)).resolves.toBeUndefined()
    await index.clear(second)
  })

  it('propagates non-cache filesystem read failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-upload-index-'))
    roots.push(dir)
    const path = join(dir, 'directory')
    await mkdir(path)
    const index = new DeepSeekUploadIndex(path)
    await expect(index.get(
      deepSeekFileScope('https://api.deepseek.com', 'key'), VARIANT, 1, 1,
    )).rejects.toBeInstanceOf(Error)
  })
})
