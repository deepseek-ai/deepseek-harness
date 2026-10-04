/** Built npm frontend assets work under a deployment prefix without remote resource requests. */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'

it.each([
  { locale: 'en-US', preference: 'en-US' },
  { locale: 'zh-CN', preference: 'zh' },
])('loads English DevTools under a prefix with browser locale $locale and saved preference $preference', async (copy) => {
  const scaffold = await launchWebScaffold({
    publicMount: { prefix: 'nested/devtools-test/' },
    profile: { packages: [{ dir: fileURLToPath(new URL('../../../packages/experimental/inspector-profile', import.meta.url)), enabled: true }], hmr: false },
    extraOverlayPath: [
      fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
      fileURLToPath(new URL('./fixtures/shared-inspector.patch.yml', import.meta.url)),
    ],
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ locale: copy.locale, viewport: { width: 1440, height: 1000 } })
  const login = new URL(scaffold.authenticatedUrl)
  login.hostname = '127.0.0.1'
  const remote: string[] = []
  const failed: string[] = []
  page.on('pageerror', (error) => { failed.push(error.message) })
  page.on('response', (response) => {
    if (response.url().includes('/inspector/devtools/') && response.status() >= 400) failed.push(`${response.status()} ${response.url()}`)
  })
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== login.origin) {
      remote.push(url.href)
      return route.abort()
    }
    return route.continue()
  })
  await page.goto(login.href, { waitUntil: 'load' })
  await page.evaluate((locale) => { localStorage.setItem('language', JSON.stringify(locale)) }, copy.preference)
  const base = new URL('./', page.url())
  const entry = new URL('inspector/devtools/devtools_app.html?disableLocaleInfoBar=true', base)
  await page.goto(entry.href, { waitUntil: 'load' })
  try { await page.getByRole('tab', { name: 'Console', exact: true }).waitFor() } catch (error) {
    throw new Error(JSON.stringify({ remote, failed, page: await page.locator('body').ariaSnapshot() }), { cause: error })
  }
  await page.getByRole('tab', { name: 'Sources', exact: true }).click()
  const formatted = await page.evaluate(async (url) => {
    return await new Promise<string>((resolve, reject) => {
      const worker = new Worker(url, { type: 'module' })
      const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Formatter worker did not settle')) }, 30000)
      worker.onerror = (event) => { clearTimeout(timeout); worker.terminate(); reject(new Error(event.message)) }
      worker.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data === 'workerReady') {
          worker.postMessage({ method: 'format', params: { mimeType: 'text/javascript', content: 'const value={answer:42};', indentString: '  ' } })
        } else {
          clearTimeout(timeout)
          worker.terminate()
          const data = event.data
          if (typeof data !== 'object' || data === null || !('content' in data) || typeof data.content !== 'string') {
            reject(new Error('Formatter worker returned no text'))
          } else resolve(data.content)
        }
      }
    })
  }, new URL('inspector/devtools/entrypoints/formatter_worker/formatter_worker-entrypoint.js', base).href)
  expect(formatted).toContain('answer: 42')
  await page.getByRole('tab', { name: 'Memory', exact: true }).click()
  await page.getByRole('button', { name: 'Take snapshot', exact: true }).click()
  await page.getByRole('columnheader', { name: /Constructor/u }).waitFor()
  await page.getByRole('table').first().getByRole('row').nth(1).waitFor()
  expect(remote).toEqual([])
  expect(failed).toEqual([])
})
