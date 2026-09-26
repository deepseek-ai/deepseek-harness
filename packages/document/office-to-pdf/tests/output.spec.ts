/** PDF output checks use opened-file metadata and enforce byte bounds during reads. */
import { appendFile, mkdtemp, rm, stat, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { readPdf } from '../src/output.ts'

const io = vi.hoisted(() => ({ opened: undefined as ((file: FileHandle) => Promise<void>) | undefined }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>): ReturnType<typeof actual.open> {
      const file = await actual.open(...args)
      await io.opened?.(file)
      return file
    },
  }
})

afterEach(() => { io.opened = undefined; vi.restoreAllMocks() })

const pdf = Buffer.from('%PDF-1.7\npreview\n%%EOF\n')

async function output(): Promise<{ directory: string; path: string; handles: FileHandle[] }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-office-to-pdf-output-'))
  const handles: FileHandle[] = []
  onTestFinished(async () => {
    try { await Promise.all(handles.map(file => file.close())) }
    finally { await rm(directory, { recursive: true, force: true }) }
  })
  const path = join(directory, 'preview.pdf')
  await writeFile(path, pdf)
  return { directory, path, handles }
}

it('closes an opened output that is not a regular file despite earlier path metadata', async () => {
  const { directory, path, handles } = await output()
  const directoryInfo = await stat(directory)
  io.opened = async (file) => {
    handles.push(file)
    // Directory handles cannot be opened on Windows; fstat supplies the same rejection input.
    vi.spyOn(file, 'stat').mockResolvedValueOnce(directoryInfo)
  }
  await expect(readPdf(path, pdf.length, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-output' })
  expect(handles).toHaveLength(1)
  expect(handles[0]!.fd).toBe(-1)
})

it('rejects output that grows past the limit after opened-file metadata is read', async () => {
  const { path, handles } = await output()
  io.opened = async (file) => {
    handles.push(file)
    const inspect = file.stat.bind(file)
    vi.spyOn(file, 'stat').mockImplementationOnce(async () => {
      const info = await inspect()
      await appendFile(path, 'extra output')
      return info
    })
  }
  await expect(readPdf(path, pdf.length, new AbortController().signal)).rejects.toMatchObject({ code: 'output-too-large' })
  expect(handles).toHaveLength(1)
  expect(handles[0]!.fd).toBe(-1)
})
