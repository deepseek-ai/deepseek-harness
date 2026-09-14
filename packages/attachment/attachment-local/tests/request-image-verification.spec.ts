import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'

const control = vi.hoisted(() => ({ mismatch: false }))

vi.mock('../src/image.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/image.ts')>()
  return {
    ...actual,
    async detectImage(data: Uint8Array): Promise<Awaited<ReturnType<typeof actual.detectImage>>> {
      const detected = await actual.detectImage(data)
      return control.mismatch ? { ...detected, width: detected.width + 1 } : detected
    },
  }
})

import LocalAttachmentStore from '../src/index.ts'

const homes: string[] = []

afterEach(async () => {
  control.mismatch = false
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

describe('request image verification', () => {
  it('rejects an encoded request whose decoded facts disagree with the encoder result', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-request-verification-'))
    homes.push(dshHome)
    const attachments = new LocalAttachmentStore(new Context(), { dshHome })
    const source = new Uint8Array(await sharp({
      create: { width: 64, height: 32, channels: 3, background: { r: 12, g: 34, b: 56 } },
    }).png().toBuffer())
    const attachment = await attachments.saveImage({ data: source, mediaType: 'image/png' })
    control.mismatch = true

    await expect(attachments.readImageRequest(attachment, { width: 22, height: 11, maxBytes: 1024 * 1024 }))
      .rejects.toMatchObject({
        code: 'ATTACHMENT_WRITE_FAILED',
        message: 'Encoded model-request image does not match its verified 8-bit sRGB metadata.',
      })
  })
})
