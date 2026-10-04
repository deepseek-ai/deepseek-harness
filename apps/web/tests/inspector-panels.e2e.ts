/** Real packaged DevTools panels against an isolated Web Host. */
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

let browser: Browser | undefined
let scaffold: WebScaffold | undefined

beforeAll(async () => {
  scaffold = await launchWebScaffold({
    profile: { packages: [{
      dir: fileURLToPath(new URL('../../../packages/experimental/inspector-profile', import.meta.url)), enabled: true,
    }], hmr: false },
    extraOverlayPath: [
      fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
      fileURLToPath(new URL('./fixtures/shared-inspector.patch.yml', import.meta.url)),
    ],
  })
  browser = await chromium.launch()
})

afterAll(async () => {
  try { await browser?.close() } finally { await scaffold?.close() }
})

it.each(['Elements', 'Memory', 'Performance'] as const)('uses the %s panel against the Host', async (panel) => {
  const page = await browser!.newPage({ locale: 'en-US', viewport: { width: 1440, height: 1000 } })
  onTestFinished(() => page.close())
  const errors: string[] = []
  const requests = new Map<number, string>()
  const methods: string[] = []
  const completed = new Set<string>()
  let heapChunks = 0
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`)
  })
  page.on('websocket', (socket) => {
    if (!socket.url().includes('/inspector/devtools/cdp')) return
    socket.on('framesent', ({ payload }) => {
      const message = JSON.parse(String(payload)) as { id: number; method: string }
      requests.set(message.id, message.method)
      methods.push(message.method)
    })
    socket.on('framereceived', ({ payload }) => {
      const message = JSON.parse(String(payload)) as { id?: number; method?: string; error?: { message: string } }
      if (message.method === 'HeapProfiler.addHeapSnapshotChunk') heapChunks++
      if (message.error !== undefined) errors.push(`${requests.get(message.id!)}: ${message.error.message}`)
      else if (message.id !== undefined && requests.has(message.id)) completed.add(requests.get(message.id)!)
    })
  })
  await page.goto(scaffold!.authenticatedUrl, { waitUntil: 'load' })
  const frontend = new URL('inspector/devtools/devtools_app.html?disableLocaleInfoBar=true', scaffold!.baseUrl)
  await page.goto(frontend.href, { waitUntil: 'load' })
  try {
    await page.getByRole('tab', { name: panel, exact: true }).click()
    if (panel === 'Elements') {
      const host = page.locator('.webkit-html-tag-name').filter({ hasText: /^host$/u }).first()
      await host.waitFor({ state: 'visible' })
      await host.dblclick()
      await page.locator('.webkit-html-tag-name').filter({ hasText: /^context$/iu }).first().waitFor({ state: 'visible' })
    } else if (panel === 'Memory') {
      await page.getByRole('button', { name: 'Take snapshot', exact: true }).click()
      await page.getByRole('columnheader', { name: /^Constructor/u }).waitFor({ state: 'visible' })
      await expect.poll(() => page.getByRole('table').first().getByRole('row').count(), { timeout: 30_000 }).toBeGreaterThan(1)
      expect(heapChunks).toBeGreaterThan(0)
      expect(completed.has('HeapProfiler.takeHeapSnapshot')).toBe(true)
    } else {
      await page.getByRole('button', { name: /^Record(?:$| )/u }).first().click()
      await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'visible' })
      await expect.poll(() => completed.has('Profiler.start')).toBe(true)
      let value = 0
      for (let index = 0; index < 5_000_000; index++) value += Math.sqrt(index)
      expect(value).toBeGreaterThan(0)
      await page.getByRole('button', { name: 'Stop', exact: true }).click()
      await page.getByRole('tab', { name: 'Bottom-up', exact: true }).waitFor({ state: 'visible' })
      expect(completed.has('Profiler.stop')).toBe(true)
    }
  } catch (error) {
    throw new Error(JSON.stringify({ panel, errors, methods, heapChunks, page: await page.locator('body').ariaSnapshot() }), { cause: error })
  }
})
