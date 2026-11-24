import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('fetchFile abort handling', () => {
  const dirs: string[] = []

  afterEach(() => {
    vi.doUnmock('node:fs')
    vi.restoreAllMocks()
    vi.resetModules()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('rejects immediately when init.signal is already aborted', async () => {
    const { default: fetchFile } = await import('../src/node.ts')
    const controller = new AbortController()
    controller.abort(new Error('pre-aborted'))
    await expect(fetchFile(pathToFileURL(join(tmpdir(), 'nonexistent.txt')), { signal: controller.signal }))
      .rejects.toThrow('pre-aborted')
  })

  it('reads normal local files when signal is not aborted', async () => {
    const { default: fetchFile } = await import('../src/node.ts')
    const dir = mkdtempSync(join(tmpdir(), 'fetch-file-'))
    dirs.push(dir)
    const file = join(dir, 'hello.txt')
    writeFileSync(file, 'hello world')
    const response = await fetchFile(pathToFileURL(file), { signal: new AbortController().signal })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('hello world')
  })

  it('destroys the sniffing stream and rejects when init.signal aborts while sniffing', async () => {
    let destroyed = false
    vi.doMock('node:fs', async (importOriginal) => {
      const original = await importOriginal<typeof import('node:fs')>()
      return {
        ...original,
        createReadStream: () => {
          const stalled = new PassThrough()
          const origDestroy = stalled.destroy.bind(stalled)
          stalled.destroy = ((err?: Error) => {
            destroyed = true
            return origDestroy(err)
          }) as typeof stalled.destroy
          return stalled
        },
      }
    })
    const { default: fetchFile } = await import('../src/node.ts')
    const controller = new AbortController()
    const pending = fetchFile(pathToFileURL(join(tmpdir(), 'stalled.bin')), { signal: controller.signal })
    await Promise.resolve()
    controller.abort(new Error('deadline exceeded'))
    await expect(pending).rejects.toThrow('deadline exceeded')
    expect(destroyed).toBe(true)
  })
})
