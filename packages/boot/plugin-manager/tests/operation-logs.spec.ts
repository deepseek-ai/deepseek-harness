/** Pnpm diagnostics release their real file descriptor when preparation rejects. */
import { fstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { initProfile } from '@deepseek-ai/dsh-app-boot'
import { runProfilePnpm } from '../src/operations.ts'

const observed = vi.hoisted(() => {
  const logs: Array<{ handle: FileHandle; fd: number }> = []
  return { logs }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (typeof args[0] === 'string' && args[0].endsWith('pnpm.log')) {
        observed.logs.push({ handle, fd: handle.fd })
      }
      return handle
    },
  }
})

it('closes the pnpm log when the profile manifest cannot be parsed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'manager-log-lifetime-'))
  onTestFinished(async () => {
    for (const { handle } of observed.logs.splice(0)) await handle.close()
    rmSync(home, { recursive: true, force: true })
  })
  const dir = join(home, 'profiles', 'test')
  const installAnchor = join(home, 'package.json')
  writeFileSync(installAnchor, '{}\n')
  initProfile(dir, [])
  writeFileSync(join(dir, 'package.json'), '{')

  await expect(runProfilePnpm({ home, profile: 'test', installAnchor, cwd: home }, ['install'], {
    execution: 'service', outputBytes: 100, activateNewBundles: false,
  })).rejects.toThrow(SyntaxError)

  expect(observed.logs).toHaveLength(1)
  const { fd } = observed.logs[0]!
  expect(() => fstatSync(fd)).toThrow(expect.objectContaining({ code: 'EBADF' }))
})
