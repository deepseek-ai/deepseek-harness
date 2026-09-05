import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import LocalAttachmentStore, {
  DEFAULT_NORMALIZED_IMAGE_MAX_BYTES,
  DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION,
  DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS,
  DEFAULT_IMAGE_COMPRESSION_CONCURRENCY,
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_IMAGE_DIMENSION,
  DEFAULT_MAX_IMAGE_PIXELS,
  DEFAULT_MAX_IMAGES_PER_MESSAGE,
  DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
} from '../src/index.ts'

describe('local attachment service', () => {
  it('resolves every omitted admission limit explicitly', () => {
    const service = new LocalAttachmentStore(new Context(), {})
    expect(DEFAULT_MAX_IMAGE_BYTES).toBe(20 * 1024 * 1024)
    expect(DEFAULT_MAX_IMAGES_PER_MESSAGE).toBe(20)
    expect(DEFAULT_MAX_MESSAGE_IMAGE_BYTES).toBe(200 * 1024 * 1024)
    expect(DEFAULT_MAX_IMAGE_PIXELS).toBe(64_000_000)
    expect(DEFAULT_MAX_IMAGE_DIMENSION).toBe(8192)
    expect(service.imageLimits).toEqual({
      maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
      maxImagesPerMessage: DEFAULT_MAX_IMAGES_PER_MESSAGE,
      maxMessageImageBytes: DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
      maxImagePixels: DEFAULT_MAX_IMAGE_PIXELS,
      maxImageDimension: DEFAULT_MAX_IMAGE_DIMENSION,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    })
    expect(service.normalizationPolicy).toEqual({
      maxPixels: DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS,
      maxDimension: DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION,
      maxBytes: DEFAULT_NORMALIZED_IMAGE_MAX_BYTES,
    })
    expect(service.imageCompressionConcurrency).toBe(DEFAULT_IMAGE_COMPRESSION_CONCURRENCY)
    const ref = {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png' as const,
      bytes: 1,
      width: 1,
      height: 1,
    }
    expect(service.imageHostPath(ref)).toBe(join(
      service.root,
      'objects',
      'aa',
      'a'.repeat(64),
    ))
    expect(() => service.imageHostPath({ ...ref, attachmentId: AttachmentId('invalid') }))
      .toThrow(expect.objectContaining({ code: 'INVALID_ATTACHMENT_REF' }))
  })

  it('resolves and validates the instance image-compression concurrency', () => {
    expect(new LocalAttachmentStore(new Context(), { imageCompressionConcurrency: 1 }).imageCompressionConcurrency).toBe(1)
    for (const imageCompressionConcurrency of [0, 1.5, 9]) {
      expect(() => new LocalAttachmentStore(new Context(), { imageCompressionConcurrency }))
        .toThrow(/imageCompressionConcurrency must be an integer from 1 through 8/)
    }
  })

  it('saves and reads through the service boundary', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-attachment-service-'))
    try {
      const service = new LocalAttachmentStore(new Context(), { dshHome })
      const data = Uint8Array.from(Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC',
        'base64',
      ))
      const ref = await service.saveImage({ data, mediaType: 'image/png' })
      await expect(service.readImage(ref)).resolves.toEqual({ ref, data })
      const hostPath = service.imageHostPath(ref)
      expect(hostPath).toBe(join(
        dshHome,
        'attachments',
        'v1',
        'objects',
        String(ref.attachmentId).slice('sha256:'.length, 'sha256:'.length + 2),
        String(ref.attachmentId).slice('sha256:'.length),
      ))
      await expect(readFile(hostPath)).resolves.toEqual(Buffer.from(data))
      const request = await service.readImageRequest(ref, { maxPixels: 1, maxBytes: 1024 })
      expect(request).not.toHaveProperty('access')

      const fileData = Uint8Array.of(0, 1, 2, 255)
      const fileRef = await service.saveFile({ data: fileData, name: 'notes.bin' })
      const filePath = service.fileHostPath(fileRef)
      expect(filePath).toContain(join('files', String(fileRef.attachmentId).slice(7, 9)))
      await expect(readFile(filePath)).resolves.toEqual(Buffer.from(fileData))

      const streamRef = await service.saveFileStream({
        data: (async function* (): AsyncIterable<Uint8Array> { yield fileData })(),
        name: 'stream.bin',
      })
      await expect(readFile(service.fileHostPath(streamRef))).resolves.toEqual(Buffer.from(fileData))
      const streamed: Uint8Array[] = []
      for await (const chunk of service.readFileStream(streamRef)) streamed.push(chunk)
      expect(Buffer.concat(streamed)).toEqual(Buffer.from(fileData))
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it('commits a fully prepared image batch in input order', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-attachment-batch-success-'))
    try {
      const service = new LocalAttachmentStore(new Context(), { dshHome })
      const first = new Uint8Array(await sharp({
        create: { width: 2, height: 1, channels: 3, background: { r: 1, g: 2, b: 3 } },
      }).png().toBuffer())
      const second = new Uint8Array(await sharp({
        create: { width: 1, height: 2, channels: 3, background: { r: 4, g: 5, b: 6 } },
      }).png().toBuffer())

      const refs = await service.saveImages([
        { data: first, mediaType: 'image/png', name: 'first.png' },
        { data: second, mediaType: 'image/png', name: 'second.png' },
      ])

      expect(refs.map(ref => ref.name)).toEqual(['first.png', 'second.png'])
      await expect(Promise.all(refs.map(ref => service.readImage(ref))))
        .resolves.toHaveLength(2)
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it.each([3, 4] as const)('admits a 16-bit %s-channel PNG as an 8-bit normalized object', async (channels) => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-attachment-16-bit-'))
    try {
      const service = new LocalAttachmentStore(new Context(), { dshHome })
      const source = new Uint8Array(await sharp({
        create: { width: 7, height: 5, channels, background: { r: 12, g: 34, b: 56, alpha: 0.5 } },
      }).toColourspace('rgb16').png().toBuffer())

      const saved = await service.saveImage({ data: source, mediaType: 'image/png' })
      const stored = await service.readImage(saved)
      const metadata = await sharp(stored.data).metadata()

      expect(stored.data).not.toEqual(source)
      expect(metadata).toMatchObject({ depth: 'uchar', space: 'srgb', hasAlpha: channels === 4 })
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it('prepares every batch member before any write', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-attachment-batch-'))
    try {
      const service = new LocalAttachmentStore(new Context(), { dshHome })
      const valid = Uint8Array.from(Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC',
        'base64',
      ))
      await expect(service.saveImages([
        { data: valid, mediaType: 'image/png' },
        { data: Uint8Array.of(1, 2, 3), mediaType: 'image/png' },
      ])).rejects.toThrow(/Unsupported or malformed image data/)
      expect(existsSync(service.root)).toBe(false)
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it('validates without persisting: a rejected image leaves no storage root behind', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-attachment-validate-'))
    try {
      const service = new LocalAttachmentStore(new Context(), { dshHome })
      await expect(service.validateImage({ data: Uint8Array.of(1, 2, 3), mediaType: 'image/png' }))
        .rejects.toThrow(/Unsupported or malformed image data/)
      const valid = Uint8Array.from(Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC',
        'base64',
      ))
      const limited = new LocalAttachmentStore(new Context(), { dshHome, maxImageBytes: 1 })
      await expect(limited.validateImage({ data: valid, mediaType: 'image/png' }))
        .rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })
      await expect(service.validateImage({ data: valid, mediaType: 'image/png' })).resolves.toBeUndefined()
      expect(existsSync(service.root)).toBe(false)
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })
})
