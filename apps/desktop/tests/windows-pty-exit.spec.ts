import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it.skipIf(process.platform !== 'win32').each(['natural', 'kill'])('releases the terminal worker after %s exit', async (mode) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    /^(?:path|systemroot|windir|comspec|temp|tmp)$/iu.test(name)
  )))
  const result = await promisify(execFile)(process.execPath, [resolve(import.meta.dirname, 'fixtures/windows-pty-exit.cjs'), mode], {
    env, timeout: 15_000, windowsHide: true,
  })
  expect(result.stderr).toBe('')
  expect(result.stdout.trim()).toBe('pty-cleanup-complete')
}, 20_000)
