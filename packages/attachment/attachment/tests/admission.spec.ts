import { describe, expect, it, vi } from 'vitest'
import AttachmentStore, { admitEncodedFile, admitEncodedImages } from '@deepseek-ai/dsh-attachment'
import type {
  FileAttachmentRef, ImageAttachmentRef, SaveImageAttachment,
} from '@deepseek-ai/dsh-attachment/types'

const PNG = 'AAAA' // canonical base64, 3 bytes
const FILE_REF: FileAttachmentRef = {
  attachmentId: 'file-1' as FileAttachmentRef['attachmentId'],
  name: 'notes.md',
  bytes: 12,
}

/** Delegation double: records the exact saveImages batch and answers ordered refs. */
function storeOf() {
  const mocks = {
    saveImages: vi.fn((inputs: readonly SaveImageAttachment[]) => Promise.resolve(inputs.map((input, index): ImageAttachmentRef => ({
      attachmentId: `att-${index + 1}` as ImageAttachmentRef['attachmentId'],
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      ...input.name === undefined ? {} : { name: input.name },
    })))),
  }
  const store = Object.setPrototypeOf(mocks, AttachmentStore.prototype) as AttachmentStore
  return { store, mocks }
}

describe('admitEncodedImages', () => {
  it('decodes every member and delegates one ordered batch to saveImages', async () => {
    const { store, mocks } = storeOf()
    const refs = await admitEncodedImages(store, [
      { mediaType: 'image/png', data: PNG, name: 'first.png' },
      { mediaType: 'image/jpeg', data: PNG, name: 'second.jpg' },
    ])
    expect(mocks.saveImages).toHaveBeenCalledTimes(1)
    const batch = mocks.saveImages.mock.calls[0]?.[0] as readonly SaveImageAttachment[]
    expect(batch.map(input => [input.name, input.mediaType, input.data.byteLength]))
      .toEqual([['first.png', 'image/png', 3], ['second.jpg', 'image/jpeg', 3]])
    expect(refs.map(ref => ref.attachmentId)).toEqual(['att-1', 'att-2'])
  })

  it('omits the name from store inputs when the upload has none', async () => {
    const { store, mocks } = storeOf()
    const refs = await admitEncodedImages(store, [{ mediaType: 'image/webp', data: PNG }])
    const batch = mocks.saveImages.mock.calls[0]?.[0] as readonly SaveImageAttachment[]
    expect('name' in (batch[0] as object)).toBe(false)
    expect(refs[0]?.name).toBeUndefined()
  })

  it('delegates an empty batch unchanged', async () => {
    const { store, mocks } = storeOf()
    await expect(admitEncodedImages(store, [])).resolves.toEqual([])
    expect(mocks.saveImages).toHaveBeenCalledWith([])
  })

  it('rejects non-canonical and empty base64 payloads before any store call', async () => {
    const { store, mocks } = storeOf()
    for (const data of ['', 'AAA', '!!!!']) {
      await expect(admitEncodedImages(store, [{ mediaType: 'image/png', data }]))
        .rejects.toMatchObject({ name: 'AttachmentError', code: 'INVALID_IMAGE_BASE64' })
    }
    expect(mocks.saveImages).not.toHaveBeenCalled()
  })

  it('propagates the store batch rejection unchanged', async () => {
    const { store, mocks } = storeOf()
    const refused = Object.assign(new Error('Image batch exceeds the configured image-count limit.'), { code: 'TOO_MANY_IMAGES' })
    mocks.saveImages.mockRejectedValueOnce(refused)
    await expect(admitEncodedImages(store, [{ mediaType: 'image/png', data: PNG }])).rejects.toBe(refused)
  })
})

describe('admitEncodedFile', () => {
  /** Delegation double: records the exact saveFile input and answers a fixed ref. */
  function fileStoreOf() {
    const store = {
      saveFile: vi.fn((input: { data: Uint8Array; name?: string }) => Promise.resolve({
        attachmentId: 'file-1' as never,
        name: input.name ?? 'file',
        bytes: input.data.byteLength,
      })),
    }
    return { store: store as unknown as AttachmentStore, mocks: store }
  }

  it('decodes canonical base64 and delegates verbatim commit to saveFile', async () => {
    const { store, mocks } = fileStoreOf()
    const ref = await admitEncodedFile(store, { data: 'AAAA', name: 'blob.bin' })
    expect(mocks.saveFile).toHaveBeenCalledTimes(1)
    const input = mocks.saveFile.mock.calls[0]?.[0] as { data: Uint8Array; name?: string }
    expect([input.name, input.data.byteLength]).toEqual(['blob.bin', 3])
    expect(ref.bytes).toBe(3)
  })

  it('accepts an empty payload as a zero-byte file and omits an absent name', async () => {
    const { store, mocks } = fileStoreOf()
    const ref = await admitEncodedFile(store, { data: '' })
    const input = mocks.saveFile.mock.calls[0]?.[0] as object
    expect('name' in input).toBe(false)
    expect(ref.bytes).toBe(0)
  })

  it('rejects non-canonical base64 without touching the store', async () => {
    const { store, mocks } = fileStoreOf()
    await expect(admitEncodedFile(store, { data: 'not base64!!' }))
      .rejects.toMatchObject({ code: 'INVALID_FILE_BASE64' })
    expect(mocks.saveFile).not.toHaveBeenCalled()
  })
})

describe('AttachmentStore.admitPromptContent', () => {
  it('passes through text and durable files without touching image storage', async () => {
    const store = Object.setPrototypeOf({
      saveImages: () => { throw new Error('prompts without image uploads must not reach the store') },
    }, AttachmentStore.prototype) as AttachmentStore
    await expect(store.admitPromptContent([
      { type: 'text', text: 'hello' },
      { type: 'file', attachment: FILE_REF },
    ])).resolves.toEqual([
      { type: 'text', text: 'hello' },
      { type: 'file', attachment: FILE_REF },
    ])
  })

  it('replaces images and passes through files in part order', async () => {
    const { store } = storeOf()
    await expect(store.admitPromptContent([
      { type: 'image', mediaType: 'image/png', data: 'AQ==' },
      { type: 'file', attachment: FILE_REF },
      { type: 'text', text: 'between' },
      { type: 'image', mediaType: 'image/png', data: 'Ag==' },
    ])).resolves.toEqual([
      { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
      { type: 'file', attachment: FILE_REF },
      { type: 'text', text: 'between' },
      { type: 'image', attachment: { attachmentId: 'att-2', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
    ])
  })
})
