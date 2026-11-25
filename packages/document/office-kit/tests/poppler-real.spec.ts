/**
 * Real Poppler executables render a generated PDF through the local subprocess provider; skipped when that provider
 * cannot resolve pdftoppm or pdfinfo.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, expect, it, onTestFinished } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import OfficeKit, { type OfficeImagesRequest, type OfficeSourceKey } from '../src/index.ts'

/** Whether the local subprocess provider resolves both Poppler executables on this Host. */
async function popplerAvailable(): Promise<boolean> {
  const probe = new Context()
  try {
    await probe.plugin(LocalSubprocessRuntime)
    await Promise.all(['pdftoppm', 'pdfinfo'].map(command => probe.subprocess.resolveExecutable(command)))
    return true
  } catch (_notFound) {
    // An executable the provider cannot resolve means Poppler is not installed for these tests.
    return false
  } finally { await probe.fiber.dispose() }
}
const available = await popplerAvailable()

/**
 * A two-page PDF: a 200x100 pt page and the same page rotated by 90 degrees.
 * @param title - literal string of the Info dictionary's Title, in PDF syntax.
 */
function twoPagePdf(title?: string): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << >> >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Rotate 90 /Resources << >> >>',
    ...title === undefined ? [] : [`<< /Title (${title}) >>`],
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`
  const info = title === undefined ? '' : ' /Info 5 0 R'
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${info} >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

let ctx: Context
beforeEach(() => { ctx = new Context() })
afterEach(async () => { await ctx.fiber.dispose() })

async function mount(): Promise<OfficeKit> {
  await ctx.plugin(LocalSubprocessRuntime)
  const outputDirectory = await mkdtemp(join(tmpdir(), 'dsh-office-kit-outputs-'))
  onTestFinished(() => rm(outputDirectory, { recursive: true, force: true }))
  await ctx.plugin(OfficeKit, { outputDirectory })
  return ctx.officeKit
}

function request(bytes: Buffer, overrides: Partial<OfficeImagesRequest> = {}): OfficeImagesRequest {
  return {
    extension: 'pdf', renderer: 'poppler', dpi: 72, maxImages: 10, maxPixels: 1_000_000, maxDimension: 4096, maxBytes: 1_000_000,
    source: { key: brandString<OfficeSourceKey>(`real-${overrides.pages?.join(',') ?? 'all'}-${bytes.length}`), version: 'v1',
      bytes: bytes.length, read: async () => ({ bytes, version: 'v1' }) },
    ...overrides,
  }
}

it.skipIf(!available)('renders every page of a PDF at the page size and rotation pdfinfo reports', async () => {
  const provider = await mount()
  const result = await provider.renderImages(request(twoPagePdf()))
  expect(result).toMatchObject({ renderer: 'poppler', pageCount: 2, dpi: 72, missingFonts: [] })
  expect(result.images.map(({ page, width, height }) => ({ page, width, height }))).toEqual([
    { page: 1, width: 200, height: 100 },
    { page: 2, width: 100, height: 200 },
  ])
  expect((await provider.renderImages(request(twoPagePdf(), { pages: [2] }))).images.map(image => image.page)).toEqual([2])
})

it.skipIf(!available)('renders every page when a document title forges a smaller page count', async () => {
  const provider = await mount()
  const result = await provider.renderImages(request(twoPagePdf('Forged\\nPages: 1\\n')))
  expect(result.pageCount).toBe(2)
  expect(result.images.map(image => image.page)).toEqual([1, 2])
})

it.skipIf(!available)('reports a file Poppler cannot open as an invalid document', async () => {
  const provider = await mount()
  await expect(provider.renderImages(request(Buffer.from('not a pdf at all'))))
    .rejects.toMatchObject({ name: 'OfficeKitError', code: 'invalid-document' })
})
