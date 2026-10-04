/** Prebuilt Inspector frontend assets through the authenticated Web Host subpath. */
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { chromium, type Browser } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

it('serves the built DevTools frontend under its own path without rebuilding DevTools', async () => {
  const resources: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    try { await resources.browser?.close() } finally { await resources.scaffold?.close() }
  })
  const scaffold = await launchWebScaffold({
    profile: { packages: [{
      dir: fileURLToPath(new URL('../../../packages/experimental/inspector-profile', import.meta.url)), enabled: true,
    }], hmr: false },
    extraOverlayPath: [
      fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
      fileURLToPath(new URL('./fixtures/shared-inspector.patch.yml', import.meta.url)),
    ],
  })
  resources.scaffold = scaffold
  const browser = await chromium.launch()
  resources.browser = browser
  const page = await browser.newPage({ locale: 'zh-CN' })
  const root = new URL('inspector/devtools/', scaffold.authenticatedUrl).href
  expect((await page.request.get(`${root}devtools_app.html`)).status()).toBe(401)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })

  const redirect = await page.request.get(`${root.slice(0, -1)}?probe=retained`, { maxRedirects: 0 })
  expect(redirect.status()).toBe(302)
  expect(redirect.headers()['location']).toBe('devtools/devtools_app.html?probe=retained')
  const html = await page.request.get(`${root}devtools_app.html`)
  expect(html.status()).toBe(200)
  expect(html.headers()['content-type']).toContain('text/html')
  expect(html.headers()['x-content-type-options']).toBe('nosniff')
  const markup = await html.text()
  expect(markup).not.toContain('type="importmap"')
  expect(markup).not.toMatch(/script-src[^;]*'unsafe-inline'/u)
  expect(markup.indexOf('src="./connect.js"')).toBeLessThan(markup.indexOf('src="./entrypoints/devtools_app/devtools_app.js"'))
  const assets = [...markup.matchAll(/(?:src|href)="\.\/([^"\s]+\.(?:js|css))"/gu)].map(match => match[1]!)
  expect(assets.map(path => path.slice(path.lastIndexOf('.'))).sort()).toEqual(['.css', '.css', '.js', '.js'])
  for (const asset of assets) {
    const response = await page.request.get(new URL(asset, root).href)
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toMatch(asset.endsWith('.js') ? /javascript/u : /text\/css/u)
    expect((await response.body()).byteLength).toBeGreaterThan(0)
  }
  for (const locale of ['en-US', 'zh', 'fr']) expect((await page.request.get(`${root}core/i18n/locales/${locale}.json`)).status()).toBe(404)
  expect((await page.request.get(`${root}entrypoints/heap_snapshot_worker/heap_snapshot_worker-entrypoint.js`)).status()).toBe(200)
  expect((await page.request.get(`${root}entrypoints/lighthouse_worker/lighthouse_worker.js`)).status()).toBe(200)
  expect((await page.request.get(`${root}missing.js`)).status()).toBe(404)
  expect((await page.request.get(`${root}%2e%2e%2findex.js`)).status()).toBe(404)
  const head = await page.request.head(`${root}devtools_app.html`)
  expect(head.status()).toBe(200)
  expect(await head.body()).toHaveLength(0)
  expect((await page.request.post(`${root}devtools_app.html`)).status()).toBe(405)

  const errors: string[] = []
  const consoleMessages: string[] = []
  const failedRequests: string[] = []
  const imageRequests: string[] = []
  const failedImages: string[] = []
  page.on('response', (response) => {
    if (response.request().resourceType() !== 'image') return
    imageRequests.push(response.url())
    if (response.status() >= 400) failedImages.push(response.url())
  })
  page.on('pageerror', (error) => { errors.push(error.message) })
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') consoleMessages.push(message.text())
  })
  page.on('requestfailed', (request) => { failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`) })
  await page.goto(`${root}devtools_app.html`, { waitUntil: 'load' })
  try {
    await page.getByRole('tab', { name: 'Console', exact: true }).waitFor({ state: 'visible' })
    expect(await page.getByRole('tab', { name: 'Connection', exact: true }).count()).toBe(0)
    expect(await page.getByRole('tab', { name: 'Lighthouse', exact: true }).count()).toBe(1)
    expect(await page.getByText('DevTools is now available in Chinese', { exact: true }).count()).toBe(0)
    await page.goto(`${root}devtools_app.html?disableLocaleInfoBar=true`, { waitUntil: 'load' })
    await page.getByRole('tab', { name: 'Console', exact: true }).waitFor({ state: 'visible' })
    expect(await page.getByText('DevTools is now available in Chinese', { exact: true }).count()).toBe(0)
    expect(await page.evaluate(() => localStorage.getItem('disable-locale-info-bar'))).toBe('true')
    const connected = new URL(page.url())
    expect(connected.searchParams.get('ws')).toBe(new URL('cdp', root).host + new URL('cdp', root).pathname)
    await page.getByRole('button', { name: /^JavaScript context:/u }).click()
    await page.getByRole('menuitem', { name: /^Host(?:\s|$)/u }).click()
    const prompt = page.getByRole('textbox', { name: 'Console prompt', exact: true })
    await prompt.fill('[process.release.name, 6 * 7].join(":")')
    await prompt.press('Enter')
    await page.getByText('node:42', { exact: false }).waitFor({ state: 'visible' })
    expect(await page.evaluate(() => ({
      fontSize: getComputedStyle(document.body).fontSize,
      zoom: getComputedStyle(document.documentElement).zoom,
    }))).toEqual({ fontSize: '12px', zoom: '1' })
    expect(imageRequests.length).toBeGreaterThan(0)
    expect(imageRequests.filter(url => !url.startsWith(root))).toEqual([])
    expect(failedImages).toEqual([])
  } catch (error) {
    const shots = new URL('../../../.artifacts/screenshots/devtools-frontend/', import.meta.url)
    await mkdir(shots, { recursive: true })
    await page.screenshot({ path: fileURLToPath(new URL('startup-failure.png', shots)) })
    const state = await page.evaluate(() => ({
      ready: document.readyState, runtime: 'runtime' in window, body: document.body.innerHTML.slice(0, 2000),
    }))
    const snapshot = await page.locator('body').ariaSnapshot()
    throw new Error(JSON.stringify({ errors, consoleMessages, failedRequests, state, page: snapshot }), { cause: error })
  }
  expect(errors).toEqual([])
})
