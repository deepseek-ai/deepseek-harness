/** Exercise the wheel's external Office package from a shipped dsh profile. */
import { readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createConverter } from '@deepseek-ai/libreoffice-kit'

export const name = 'python-sdk-office-smoke'

export async function apply(ctx, config) {
  const converter = await createConverter({ timeoutMs: 120_000 })
  try {
    const result = await converter.render({ inputPath: config.input, outputPath: config.output })
    const skill = await ctx.skills.get('office-docx')
    const json = skill?.content.match(/\n(\{\n[\s\S]+)$/u)?.[1]
    if (json === undefined) throw new Error('Office skill did not supply CLI paths')
    const { libreofficeKit: { node, cli } } = JSON.parse(json)
    const options = { env: { ...process.env, PATH: '' }, timeout: 120_000 }
    const capabilities = await promisify(execFile)(node, [cli, 'capabilities'], options)
    await promisify(execFile)(node, [cli, 'convert', '--input', config.input, '--output', config.output + '.cli.pdf'], options)
    const pdf = await readFile(config.output + '.cli.pdf')
    if (pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error('Skill CLI did not create a PDF')
    await writeFile(config.result, JSON.stringify({ ...result, capabilities: JSON.parse(capabilities.stdout), moduleUrl: import.meta.resolve('@deepseek-ai/libreoffice-kit') }))
  } finally {
    await converter.dispose()
  }
}
