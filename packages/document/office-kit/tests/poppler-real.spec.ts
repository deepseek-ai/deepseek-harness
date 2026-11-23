/** Real Poppler executables render a generated PDF through stdin and stdout; skipped when pdftoppm or pdfinfo is not on PATH. */
import { spawn as spawnChild } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, expect, it, onTestFinished } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  SubprocessExecutableNotFoundError, SubprocessRuntime, type SubprocessHandle, type SubprocessOutcome,
  type SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import OfficeKit, { type OfficeImagesRequest, type OfficeSourceKey } from '../src/index.ts'

/** First executable named `command` on PATH, honoring PATHEXT on Windows. */
function onPath(command: string): string | undefined {
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE').split(';') : ['']
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(directory, command + extension)
      if (directory !== '' && existsSync(candidate) && statSync(candidate).isFile()) return candidate
    }
  }
  return undefined
}
const available = onPath('pdftoppm') !== undefined && onPath('pdfinfo') !== undefined

/**
 * Host subprocess provider over `node:child_process` with the piped and collected stdio Poppler rendering requests; the
 * product provider's sandboxing and process-range management are outside this test's scope.
 */
class ChildProcessRuntime extends SubprocessRuntime {
  async terminalEnvironment() { return { platform: process.platform === 'win32' ? 'windows' as const : 'posix' as const } }
  override spawnTerminal(): Promise<never> { throw new Error('Poppler never spawns terminals') }
  override async resolveExecutable(command: string): Promise<string> {
    const path = onPath(command)
    if (path === undefined) throw new SubprocessExecutableNotFoundError(`${command} is not on PATH`)
    return path
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const child = spawnChild(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, stdio: 'pipe', signal: spec.signal })
    const pipedStdout = spec.stdio.stdout === 'pipe'
    const text = { stdout: '', stderr: '' }
    if (!pipedStdout) child.stdout.on('data', (chunk: Buffer) => { text.stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { text.stderr += chunk.toString('utf8') })
    const done = new Promise<SubprocessOutcome>((resolve) => {
      child.on('error', (_aborted: unknown) => undefined)
      child.on('close', (exitCode, signal) => { resolve({ exitCode, signal }) })
    })
    const reader = (stream: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: text[stream], nextOffset: 0, lossy: false }) })
    return {
      stdin: child.stdin, stdout: pipedStdout ? child.stdout : undefined, stderr: undefined, control: undefined,
      collected: { ...pipedStdout ? {} : { stdout: reader('stdout') }, stderr: reader('stderr') },
      done,
      terminate: () => { child.kill() },
      waitForExit: async () => { await done; return true },
    }
  }
}

/** A two-page PDF: a 200x100 pt page and the same page rotated by 90 degrees. */
function twoPagePdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << >> >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Rotate 90 /Resources << >> >>',
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
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

let ctx: Context
beforeEach(() => { ctx = new Context() })
afterEach(async () => { await ctx.fiber.dispose() })

async function mount(): Promise<OfficeKit> {
  await ctx.plugin(ChildProcessRuntime)
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

it.skipIf(!available)('reports a file Poppler cannot open as an invalid document', async () => {
  const provider = await mount()
  await expect(provider.renderImages(request(Buffer.from('not a pdf at all'))))
    .rejects.toMatchObject({ name: 'OfficeKitError', code: 'invalid-document' })
})
