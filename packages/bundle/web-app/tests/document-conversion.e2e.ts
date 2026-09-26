/** The shipped shared provider converts Office bytes without presentation plugins. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include, { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { OfficeSourceKey, type OfficeToPdfRequest } from '@deepseek-ai/dsh-office-to-pdf'
import * as LibreOfficeProvider from '@deepseek-ai/dsh-office-to-pdf'
import { expect, it, onTestFinished } from 'vitest'

it('loads one shared conversion row and retains caller-owned PDFs after disposal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-conversion-loader-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() }
    finally { await rm(directory, { recursive: true, force: true }) }
  })
  const rows = loadOverlayPatches('conversion-test', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
    .flatMap(patch => patch.insert ?? [])
    .filter(row => row.name === '@deepseek-ai/dsh-office-to-pdf')
  expect(rows.map(row => row.id)).toEqual(['office-to-pdf'])
  const configured = applyEntryPatches(rows, [{ id: 'office-to-pdf', config: { maxConcurrentConversions: 1 } }],
    (message) => { throw new Error(message) })
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, JSON.stringify(configured))
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  // The Loader resolves the same source-plane module namespace as the test.
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (specifier !== '@deepseek-ai/dsh-office-to-pdf') throw new Error(`Unexpected plugin: ${specifier}`)
      return LibreOfficeProvider
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'office-to-pdf')!
  await entry.fiber!.await()
  expect(ctx.get('workspaceFiles')).toBeUndefined()
  expect(ctx.get('skills')).toBeUndefined()
  const bytes = await readFile(new URL('./fixtures/document-conversion.docx', import.meta.url))
  let reads = 0
  const request = (key: string): OfficeToPdfRequest => ({
    extension: 'docx', priority: 'foreground',
    source: { key: OfficeSourceKey(key), version: 'fixture', bytes: bytes.length,
      async read(signal, maxBytes) {
        signal.throwIfAborted()
        expect(bytes.length).toBeLessThanOrEqual(maxBytes)
        reads++
        return { bytes: Uint8Array.from(bytes), version: 'fixture' }
      },
    },
  })
  const provider = ctx.officeToPdf
  const [first, second] = await Promise.all([provider.convert(request('first')), provider.convert(request('second'))])
  expect(reads).toBe(2)
  expect(Buffer.from(first.pdf).subarray(0, 5).toString()).toBe('%PDF-')
  expect(first.cacheKey).toBe(second.cacheKey)
  expect(first.pdf).toEqual(second.pdf)
  expect(first.pdf).not.toBe(second.pdf)
  expect(first.missingFonts).not.toBe(second.missingFonts)
  first.pdf.fill(0)
  first.missingFonts.push('caller-owned')
  const cached = await provider.convert(request('first'))
  expect(reads).toBe(2)
  expect(cached.pdf).toEqual(second.pdf)
  expect(cached.missingFonts).toEqual(second.missingFonts)
  await ctx.fiber.dispose()
  expect(Buffer.from(cached.pdf).subarray(0, 5).toString()).toBe('%PDF-')
  await expect(provider.convert(request('first'))).rejects.toMatchObject({ code: 'unavailable' })
})
