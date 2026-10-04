import { beforeEach, expect, it, vi } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { setActiveVfs } from '../../src/storage/active.ts'
import { hostFileSystem } from '../../src/shell/fs-access.ts'
import { spawn } from '../../src/node/builtin_modules/implemented/child_process.ts'
import { setTextViewer, XDG_OPEN_EXECUTABLE } from '../../src/shell/process/xdg-open.ts'

const PROFILE = '/dsh/home/profiles/preview'

beforeEach(() => {
  const vfs = new MemoryVfs()
  vfs.mkdirSync(PROFILE, { recursive: true })
  vfs.writeFileSync(`${PROFILE}/cordis.patch.yml`, '- insert: []\n')
  setActiveVfs(vfs)
})

async function run(args: readonly string[]): Promise<{ code: number | null; stderr: string }> {
  const child = spawn('xdg-open', args, { cwd: PROFILE })
  let stderr = ''
  child.stderr?.on('data', (chunk: unknown) => { stderr += String(chunk) })
  const code = await new Promise<number | null>((settle) => { child.on('close', (value: unknown) => { settle(value as number | null) }) })
  return { code, stderr }
}

it('refuses with status 3 before a page viewer is attached', async () => {
  vi.resetModules()
  const fresh = await import('../../src/shell/process/xdg-open.ts')
  const result = await fresh.XDG_OPEN_EXECUTABLE.prepare([`${PROFILE}/cordis.patch.yml`], { cwd: PROFILE, filesystem: hostFileSystem() })
  expect(result).toEqual({ kind: 'exit', exitCode: 3, stdout: '', stderr: 'xdg-open: no page viewer is attached\n' })
})

it('hands a spawned relative path to the page viewer', async () => {
  const viewer = vi.fn()
  setTextViewer(viewer)
  expect(await run(['cordis.patch.yml'])).toEqual({ code: 0, stderr: '' })
  expect(viewer).toHaveBeenCalledWith(`${PROFILE}/cordis.patch.yml`, '- insert: []\n')
})

it('reports usage, missing files, directories, and viewer failures with xdg-open statuses', async () => {
  setTextViewer(() => { throw new Error('page closed') })
  expect(await run([])).toEqual({ code: 1, stderr: 'xdg-open: usage: xdg-open { file | URL }\n' })
  expect(await run(['missing.yml'])).toEqual({ code: 2, stderr: `xdg-open: file '${PROFILE}/missing.yml' does not exist\n` })
  expect(await run(['.'])).toEqual({ code: 3, stderr: `xdg-open: no viewer for directory '${PROFILE}'\n` })
  expect(await run(['cordis.patch.yml'])).toEqual({ code: 4, stderr: 'xdg-open: page closed\n' })
  expect(XDG_OPEN_EXECUTABLE.runSync(['cordis.patch.yml'])).toEqual({ kind: 'asynchronous' })
})
