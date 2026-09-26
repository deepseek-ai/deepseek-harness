/** The Web bundle's Office rows retain independent configuration and Session file authorization. */
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include, { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import WorkspaceFiles, { type WorkspaceFileScope } from '@deepseek-ai/dsh-api-workspace-files'
import OfficeToPdf from '@deepseek-ai/dsh-office-to-pdf'
import * as DocumentPreview from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { FsError } from '@deepseek-ai/dsh-fs'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { Converter, ConverterOptions } from '@deepseek-ai/libreoffice-kit'
import { expect, it, onTestFinished, vi } from 'vitest'

const kit = vi.hoisted(() => ({ create: vi.fn<(options?: ConverterOptions) => Promise<Converter>>() }))
vi.mock('@deepseek-ai/libreoffice-kit', () => ({ createConverter: kit.create }))

it('loads the shipped Office rows with separately patched settings and authorized PDF output', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-web-office-')))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() }
    finally { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }) }
  })
  const configPath = join(directory, 'cordis.yml')
  const expectedRows = {
    'office-to-pdf': '@deepseek-ai/dsh-office-to-pdf',
    'ui-sidebar-documentpreview': '@deepseek-ai/dsh-client-ui-sidebar-documentpreview',
  }
  const rows = loadOverlayPatches('web-office-test', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
    .flatMap(patch => patch.insert ?? []).filter(row => row.id !== undefined && Object.hasOwn(expectedRows, row.id))
  expect(rows.map(row => [row.id, row.name])).toEqual(Object.entries(expectedRows))
  const providerConfig = { maxInputBytes: 4096, maxConcurrentConversions: 1, fontFallbacks: [['Missing Serif', 'Available Serif']] }
  const clientConfig = DocumentPreview.Config({ office: { maxCachedEntries: 3, maxCachedBytes: 8192 } })
  const configured = applyEntryPatches(rows, [
    { id: 'office-to-pdf', config: providerConfig },
    { id: 'ui-sidebar-documentpreview', config: clientConfig },
  ], (message) => { throw new Error(message) })
  expect(configured.find(row => row.id === 'ui-sidebar-documentpreview')!.config).toEqual(clientConfig)
  await writeFile(configPath, JSON.stringify([
    { name: '@deepseek-ai/dsh-session' },
    { name: '@deepseek-ai/dsh-session-projection' },
    { name: '@deepseek-ai/dsh-sandbox-policy', config: { workspaceRoot: directory } },
    { name: '@deepseek-ai/dsh-fs-local', config: { cwd: directory } },
    { name: '@deepseek-ai/dsh-typert-registry' },
    { name: '@deepseek-ai/dsh-api-workspace-files', config: { maxFileBytes: 1 } },
    ...configured,
  ]))
  const pdf = Buffer.from('%PDF-1.7\nLoader preview\n%%EOF\n')
  const render = vi.fn<Converter['render']>().mockImplementation(async ({ inputPath, outputPath }) => {
    expect(await readFile(inputPath)).toEqual(Buffer.from('authorized OOXML'))
    await writeFile(outputPath, pdf)
    return { backend: 'native', missingFonts: ['Missing Serif'] }
  })
  kit.create.mockReset().mockResolvedValue({
    backend: 'native', render, dispose: async () => {},
    renderImages: vi.fn<Converter['renderImages']>().mockRejectedValue(new Error('Unexpected Converter.renderImages call')),
    convert: vi.fn<Converter['convert']>().mockRejectedValue(new Error('Unexpected Converter.convert call')),
    recalculate: vi.fn<Converter['recalculate']>().mockRejectedValue(new Error('Unexpected Converter.recalculate call')),
  })
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  // Loader's native imports must share the test's source-plane Service classes.
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-sandbox-policy', SandboxPolicyService],
    ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
    ['@deepseek-ai/dsh-typert-registry', TypertRegistry],
    ['@deepseek-ai/dsh-api-workspace-files', WorkspaceFiles],
    ['@deepseek-ai/dsh-office-to-pdf', OfficeToPdf],
    ['@deepseek-ai/dsh-client-ui-sidebar-documentpreview', DocumentPreview],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const entries = new Map([...ctx.loader.entries()].map(entry => [entry.options.id, entry]))
  for (const row of configured) await entries.get(row.id)!.fiber!.await()
  const injections: IndexInjection[] = []
  ctx.emit('webserver/index-inject', injections)
  expect(injections).toEqual([
    { kind: 'global', name: '__DSH_DOCUMENT_PREVIEW_CONFIG__', value: clientConfig },
  ])

  const id = SessionId('office-loader')
  const session = ctx.sessions.create(id, { meta: { cwd: directory } })
  const lookup = ctx.typert.lookups.get('workspaceFileScope')!
  const scope = await lookup.resolve(id) as WorkspaceFileScope | undefined
  if (scope === undefined) throw new Error('Expected the Session workspace scope')
  expect(await lookup.resolve(SessionId('missing'))).toBeUndefined()
  const sourcePath = join(directory, 'report.docx')
  await writeFile(sourcePath, 'authorized OOXML')
  const signal = new AbortController().signal
  const version = (await ctx.workspaceFiles.stat(scope, 'report.docx', signal)).version
  const before = session.seq
  const result = await ctx.officeToPdf.render(scope, 'report.docx', 'foreground', signal)
  expect(result).toEqual({ absolutePath: sourcePath, version, offset: 0, eof: true, bytes: pdf.length,
    data: Uint8Array.from(pdf), missingFonts: ['Missing Serif'], generation: ctx.officeToPdf.generation })
  const readAgain = vi.spyOn(ctx.fs, 'readBytes')
  expect(await ctx.officeToPdf.render(scope, 'report.docx', 'foreground', signal)).toEqual(result)
  expect(readAgain).not.toHaveBeenCalled()
  expect(await readFile(sourcePath, 'utf8')).toBe('authorized OOXML')
  expect(session.seq).toBe(before)
  expect(ctx.get('agents')).toBeUndefined()
  const { maxConcurrentConversions: _count, ...kitOptions } = providerConfig
  expect(kit.create).toHaveBeenCalledWith(expect.objectContaining(kitOptions))
  await expect(ctx.officeToPdf.render(scope, 'missing.docx', 'foreground', signal))
    .rejects.toMatchObject({ code: 'workspace-file/not-found' })
  const refusal = new FsError('read refused', 'FS_SANDBOX_DENIED')
  vi.spyOn(ctx.fs, 'stat').mockRejectedValueOnce(refusal)
  await expect(ctx.officeToPdf.render(scope, 'report.docx', 'foreground', signal)).rejects.toBe(refusal)
  if (process.platform !== 'win32') {
    await symlink(sourcePath, join(directory, 'link.docx'))
    await expect(ctx.officeToPdf.render(scope, 'link.docx', 'foreground', signal))
      .rejects.toMatchObject({ code: 'workspace-file/not-regular-file' })
  }
  expect(render).toHaveBeenCalledOnce()
})
