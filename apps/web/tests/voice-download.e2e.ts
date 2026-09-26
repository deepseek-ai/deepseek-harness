/** The real local provider publishes actionable download failures through the speech Remote to bundle details. */
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const bundle = fileURLToPath(new URL('../../../packages/experimental/voice-input-bundle', import.meta.url))
const expected = fileURLToPath(new URL('./expected/voice-download.expected.md', import.meta.url))

it('shows the failed asset, actual download source and recovery advice, then retries on request', async () => {
  const resources: { scaffold?: WebScaffold; browser?: Browser } = {}
  const root = await mkdtemp(join(tmpdir(), 'dsh-voice-download-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  let status = 503
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url!)
    response.writeHead(status); response.end()
  })
  onTestFinished(async () => {
    try { await resources.browser?.close() } finally {
      try { await resources.scaffold?.close() } finally {
        const closed = new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
        server.closeAllConnections(); await closed
      }
    }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a loopback listener')
  const origin = `http://127.0.0.1:${address.port}`, overlay = join(root, 'voice.patch.yml')
  await writeFile(overlay, `- id: speech-to-text-sensevoice\n  config:\n    dataRoot: ${JSON.stringify(join(root, 'models'))}\n    modelOrigin: ${origin}\n`)
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: bundle, enabled: true }] }, extraOverlayPath: overlay })
  resources.scaffold = scaffold
  const browser = await chromium.launch()
  resources.browser = browser
  const page = await newEnglishPage(browser), tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  await page.locator('[data-plugin-package="@deepseek-ai/dsh-experimental-voice-input-bundle"]').getByRole('button').click()
  await page.getByRole('button', { name: 'Download and prepare', exact: true }).click()
  const alert = page.getByRole('alert')
  await alert.waitFor()
  expect(await alert.textContent()).toContain('HTTP 503')
  expect(await alert.textContent()).toContain(`Download source: ${origin}`)
  expect(requests).toHaveLength(1)
  expect(requests[0]).toContain('/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.int8.onnx')
  await compareOrRefreshGolden(expected,
    (await captureStableAria(page, '[role="alert"]', scaffold.workspaceCwd)).replaceAll(origin, 'https://model-mirror.example'), webSnapshotMode())
  status = 404
  await page.getByRole('button', { name: 'Retry preparation', exact: true }).click()
  await expect.poll(() => alert.textContent()).toContain('HTTP 404')
  expect(requests).toHaveLength(2)
  expect(tripwire.pageErrors).toEqual([])
})

it.each([{ winner: 0, manual: false }, { winner: 1, manual: false }, { winner: 0, manual: true }, { winner: 1, manual: true }])(
  'uses source $winner with manual selection $manual through the real preparation UI', async ({ winner, manual }) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-voice-mirrors-'))
    onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
    const resources: { scaffold?: WebScaffold; browser?: Browser } = {}
    const probes = new Map<number, ServerResponse>(), downloads: number[] = [], requestedPaths: string[] = []
    const servers = [0, 1].map(index => createServer((request, response) => {
      requestedPaths.push(request.url!)
      if (request.method === 'HEAD') {
        probes.set(index, response)
        // Release the winner only after both real Host requests overlap.
        if (probes.size === 2) { const selected = probes.get(winner)!; selected.writeHead(200); selected.end() }
      } else {
        downloads.push(index)
        response.writeHead(index === winner ? 503 : 502); response.end()
      }
    }))
    onTestFinished(async () => {
      try { await resources.browser?.close() } finally {
        try { await resources.scaffold?.close() } finally {
          await Promise.all(servers.map(async (server) => {
            const closed = new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
            server.closeAllConnections(); await closed
          }))
        }
      }
    })
    const origins = await Promise.all(servers.map(async (server) => {
      server.listen(0, '127.0.0.1'); await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Expected a loopback listener')
      return `http://127.0.0.1:${address.port}`
    }))
    const overlay = join(root, 'voice.patch.yml')
    await writeFile(overlay, `- id: speech-to-text-sensevoice\n  config: ${JSON.stringify({
      dataRoot: join(root, 'models'), modelOrigins: origins, modelProbeTimeoutMs: 10_000,
    })}\n`)
    const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: bundle, enabled: true }] }, extraOverlayPath: overlay })
    resources.scaffold = scaffold
    const browser = await chromium.launch(); resources.browser = browser
    const page = await newEnglishPage(browser), tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await page.getByRole('button', { name: 'Plugins', exact: true }).click()
    await page.locator('[data-plugin-package="@deepseek-ai/dsh-experimental-voice-input-bundle"]').getByRole('button').click()
    const picker = page.getByLabel('Model download source', { exact: true })
    await picker.waitFor()
    if (manual) await picker.selectOption(origins[winner]!)
    await page.getByRole('button', { name: 'Download and prepare', exact: true }).click()
    const alert = page.getByRole('alert')
    await alert.waitFor()
    expect(downloads).toEqual(manual ? [winner] : [winner, 1 - winner])
    expect(requestedPaths).toHaveLength(manual ? 1 : 4)
    expect(requestedPaths.every(path => path === '/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.int8.onnx')).toBe(true)
    const failedOrigin = origins[manual ? winner : 1 - winner]!
    expect(await picker.inputValue()).toBe(manual ? origins[winner] : '')
    expect(await alert.textContent()).toContain(manual ? 'HTTP 503' : 'HTTP 502')
    expect(await alert.textContent()).toContain(`Download source: ${failedOrigin}`)
    await compareOrRefreshGolden(manual ? expected : fileURLToPath(new URL('./expected/voice-download-fallback.expected.md', import.meta.url)),
      (await captureStableAria(page, '[role="alert"]', scaffold.workspaceCwd)).replaceAll(failedOrigin, manual ? 'https://model-mirror.example' : 'https://fallback-model-source.example'),
      webSnapshotMode())
    expect(tripwire.pageErrors).toEqual([])
  })
