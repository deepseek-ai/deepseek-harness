/**
 * Real Chromium storage survives native view and Electron process lifetimes.
 * Built-artifact regression: run after `pnpm run build:lib:host`, which emits
 * apps/desktop/lib/types/platform-view.js; the fixture imports that artifact and resolves its
 * workspace dependencies from this checkout's node_modules.
 */
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execa } from 'execa'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const repository = fileURLToPath(new URL('../../../', import.meta.url))
const builtView = join(repository, 'apps/desktop/lib/types/platform-view.js')
const hasDisplay = process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)

// Linux Electron needs a display server; the test runs under xvfb in headless environments.
it.skipIf(!hasDisplay)('retains dismissed notices across view and process restarts without sharing accounts', { retry: 0 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-platform-storage-'))
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end(`<!doctype html><html><body><script>
      if (localStorage.getItem('notice-closed') !== 'true') {
        const notice = document.createElement('aside');
        notice.textContent = 'Notice ';
        const button = document.createElement('button');
        button.textContent = 'Got it';
        button.onclick = () => { localStorage.setItem('notice-closed', 'true'); notice.remove(); };
        notice.append(button); document.body.append(notice);
      }
    </script></body></html>`)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing Platform fixture listener')
    const origin = `http://127.0.0.1:${String(address.port)}`
    if (!existsSync(builtView)) throw new Error(`missing built Platform view ${builtView}; run pnpm run build:lib:host`)
    const userData = join(root, 'browser')
    await mkdir(userData)
    const electron: unknown = require('electron')
    if (typeof electron !== 'string') throw new Error('Electron executable is unavailable')
    const fixture = fileURLToPath(new URL('./fixtures/platform-storage-smoke.mjs', import.meta.url))
    const observed: string[] = []
    for (const phase of ['first', 'restart']) {
      const result = await execa(electron, [fixture, builtView, userData, origin, phase], {
        // The unbundled tsc artifact reads the client version from the environment; the packaged
        // build inlines the same value at bundle time.
        env: { ELECTRON_RUN_AS_NODE: undefined, DSH_CLIENT_VERSION: '1.2.3' },
        timeout: 45_000, forceKillAfterDelay: 5_000, reject: false,
      })
      expect(result.timedOut, result.stderr).toBe(false)
      expect(result.signal, result.stderr).toBeUndefined()
      expect(result.exitCode, result.stderr).toBe(0)
      const line = result.stdout.split('\n').find(value => value.startsWith('PLATFORM_STORAGE_RESULT '))
      if (line === undefined) throw new Error(`Missing Electron result: ${result.stdout}\n${result.stderr}`)
      const states: unknown = JSON.parse(line.slice('PLATFORM_STORAGE_RESULT '.length))
      if (!Array.isArray(states) || !states.every((value): value is string => typeof value === 'string')) {
        throw new Error('Invalid Electron storage result')
      }
      observed.push(...states)
    }
    expect(observed.join('\n') + '\n').toBe(await readFile(new URL('./expected/platform-storage.txt', import.meta.url), 'utf8'))
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
      server.closeAllConnections()
    })
    await rm(root, { recursive: true, force: true })
  }
})
