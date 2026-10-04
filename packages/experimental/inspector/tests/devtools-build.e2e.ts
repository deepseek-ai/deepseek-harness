/** Offline source compilation preserves npm inputs and includes the browser's graph-external resources. */
import { createHash } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { buildFrontend } from '../scripts/devtools/vite.ts'
import { frontendSourceRoot } from '../scripts/devtools/inputs.ts'

async function sourceHash(root: string): Promise<string> {
  const hash = createHash('sha256')
  const visit = async (path: string): Promise<void> => {
    const entries = await readdir(join(root, path), { withFileTypes: true })
    for (const item of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const name = path ? `${path}/${item.name}` : item.name
      hash.update(name)
      if (item.isDirectory()) await visit(name)
      else if (item.isFile()) hash.update(await readFile(join(root, name)))
    }
  }
  await visit('')
  return hash.digest('hex')
}

it('builds from fixed installed sources with network APIs blocked and includes Memory and injected entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-devtools-build-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const source = await frontendSourceRoot()
  const before = await sourceHash(source)
  const deny = (): never => { throw new Error('DevTools build attempted network access') }
  const guards = [
    vi.spyOn(globalThis, 'fetch').mockImplementation(deny),
    vi.spyOn(http, 'request').mockImplementation(deny),
    vi.spyOn(http, 'get').mockImplementation(deny),
    vi.spyOn(https, 'request').mockImplementation(deny),
    vi.spyOn(https, 'get').mockImplementation(deny),
  ]
  onTestFinished(() => { for (const guard of guards) guard.mockRestore() })
  await buildFrontend(root)
  for (const guard of guards) expect(guard).not.toHaveBeenCalled()
  expect(await sourceHash(source)).toBe(before)
  for (const path of [
    'devtools_app.html', 'connect.js', 'entrypoints/devtools_app/devtools_app.js',
    'entrypoints/heap_snapshot_worker/heap_snapshot_worker-entrypoint.js',
    'entrypoints/formatter_worker/formatter_worker-entrypoint.js',
    'entrypoints/wasmparser_worker/wasmparser_worker-entrypoint.js',
    'entrypoints/lighthouse_worker/lighthouse_worker.js',
    'panels/recorder/injected/injected.generated.js',
    'models/live-metrics/web-vitals-injected/web-vitals-injected.generated.js',
    'Images/chromeLeft.avif', 'Images/lighthouse_logo.svg',
    'LICENSE', 'third_party/codemirror/package/LICENSE', 'third_party/wasmparser/package/LICENSE',
  ]) expect((await readFile(join(root, path))).length, path).toBeGreaterThan(0)
  const html = await readFile(join(root, 'devtools_app.html'), 'utf8')
  expect(html).not.toContain('chrome-devtools-frontend.appspot.com')
  expect(html).not.toContain('importmap')
  expect(html.indexOf('./connect.js')).toBeLessThan(html.indexOf('./entrypoints/devtools_app/devtools_app.js'))
  await expect(readdir(join(root, 'core/i18n/locales'))).rejects.toMatchObject({ code: 'ENOENT' })
})
