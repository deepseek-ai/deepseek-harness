/** Exercise the downloaded sidecar's Kit through the Host Office kit and directly from a shipped profile. */
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { createConverter } from '@deepseek-ai/libreoffice-kit'

export const name = 'python-sdk-office-smoke'

export async function apply(ctx, config) {
  const bytes = await readFile(config.input)
  const converted = await ctx.officeKit.convertTo({
    extension: 'docx', format: 'pdf', priority: 'foreground',
    source: { key: 'python-sdk-office-smoke', version: 'fixture', bytes: bytes.length, async read() { return { bytes, version: 'fixture' } } },
    output: { owner: 'python-sdk-office-smoke', name: 'service.pdf' },
  })
  await copyFile(converted.path, config.output + '.service.pdf')
  const pdf = await readFile(config.output + '.service.pdf')
  if (pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error('Office kit service did not create a PDF')
  const converter = await createConverter({ timeoutMs: 120_000 })
  try {
    const result = await converter.render({ inputPath: config.input, outputPath: config.output })
    const images = await converter.renderImages({ inputPath: config.imageInput, outputDir: config.imageOutput, pages: [1], dpi: 72 })
    await writeFile(config.result, JSON.stringify({ ...result, images, moduleUrl: import.meta.resolve('@deepseek-ai/libreoffice-kit') }))
  } finally {
    await converter.dispose()
  }
}
