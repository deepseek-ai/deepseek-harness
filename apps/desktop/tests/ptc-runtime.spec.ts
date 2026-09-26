/** Desktop owns the Electron devDependency; the PTC helper supplies its real runtime providers. */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { mountRuntime } from '../../../packages/ptc-runtime/ptc-runtime-node/tests/setup.ts'

const require = createRequire(import.meta.url)
const electronInstalled = existsSync(join(dirname(require.resolve('electron')), 'path.txt'))

// Both fixture-owned and shared-provider teardown await native process cleanup.
vi.setConfig({ hookTimeout: 30_000 })

// Desktop's downloaded Electron binary is not installed by ordinary workspace dependency setup.
it.skipIf(process.platform !== 'darwin' || !electronInstalled).each(['workspace-write', 'danger-full-access'] as const)('runs PTC writes under Electron with %s', { timeout: 120_000 }, async (mode) => {
  const electron = require('electron') as string
  const root = await mkdtemp(join(homedir(), '.dsh-electron-ptc-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
  vi.stubEnv('DSH_TEST_RUNTIME_SECRET', 'must-not-inherit')
  const runtime = await mountRuntime(ctx, { nodeExecutable: electron }, { mode, workspaceRoot: cwd })
  const result = await runtime.run(runtime.resolve({
    // Bound startup failure before the outer test deadline, leaving time for managed cleanup.
    timeoutMs: 30_000,
    program: `await tools.write({});
      const fs = await import('node:fs/promises');
      await fs.writeFile('direct.txt', 'direct');
      let outside;
      try { await fs.writeFile('../outside.txt', 'outside'); outside = true } catch (error) { if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error; outside = false }
      return { electron: Boolean(process.versions.electron), env: { ...process.env }, outside };`,
    bindings: [{ global: 'tools', functions: { write: async () => { await writeFile(join(cwd, 'note.txt'), 'hello'); return null } } }],
  }))
  expect(result.error).toBeUndefined()
  expect(result.value).toEqual({ electron: true, env: {}, outside: mode === 'danger-full-access' })
  expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('hello')
  expect(await readFile(join(cwd, 'direct.txt'), 'utf8')).toBe('direct')
  expect(existsSync(join(root, 'outside.txt'))).toBe(mode === 'danger-full-access')
})
