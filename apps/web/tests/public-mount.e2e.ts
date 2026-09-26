// Real Chromium exercises plugin bundles, RPC, and bidirectional Gateway
// streams through a prefix-stripping HTTP proxy.
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  launchWebScaffold, watchConsole, webSnapshotMode, WELCOME_NOTICE_COPY,
  type WebConsoleTripwire, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

const MODE = webSnapshotMode()
const MOUNT = '/tools/dsh/'

describe.skipIf(MODE === 'record')('web e2e: public mount through a prefix-stripping proxy', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: WebConsoleTripwire
  const requestUrls: string[] = []
  const muxFrames: string[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      publicMount: { prefix: MOUNT },
      welcomeNoticePending: true,
    })
    browser = await chromium.launch()
    page = await browser.newPage({
      viewport: { width: 1440, height: 960 },
      locale: ZH_BROWSER_LOCALE,
    })
    tripwire = watchConsole(page)
    page.on('request', (request) => { requestUrls.push(request.url()) })
    page.on('websocket', (socket) => {
      if (new URL(socket.url()).pathname !== `${MOUNT}api/remote.mux`) return
      socket.on('framesent', (frame) => { muxFrames.push(`sent ${String(frame.payload)}`) })
      socket.on('framereceived', (frame) => { muxFrames.push(`received ${String(frame.payload)}`) })
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('#root', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  /** Requests outside the mount: the proxy strips no prefix from them, so nothing answers. */
  const offMountRequests = (): string[] => requestUrls.filter(url => !url.startsWith(scaffold.baseUrl))

  it('loads the shell, its plugin bundles, and the Gateway WebSocket under the mount', async () => {
    const welcome = page.getByRole('dialog', { name: WELCOME_NOTICE_COPY.zh.title })
    await welcome.waitFor({ timeout: 15_000 })
    expect(new URL(page.url()).pathname).toBe(MOUNT)

    // Every resource the page requested — bundles, manifest, icon, and whatever
    // a later change adds — stayed under the mount; the bundle check keeps the
    // empty off-mount list from passing vacuously.
    expect(requestUrls.some(url => new URL(url).pathname.startsWith(`${MOUNT}plugins/`))).toBe(true)
    expect(offMountRequests()).toEqual([])

    // The browser resolves manifest members against the manifest URL and the
    // start URL's origin, not the document base, so read its own resolution.
    const cdp = await page.context().newCDPSession(page)
    const { manifest } = await cdp.send('Page.getAppManifest') as {
      manifest?: { id?: string; scope?: string; startUrl?: string }
    }
    expect([manifest?.id, manifest?.scope, manifest?.startUrl]).toEqual([scaffold.baseUrl, scaffold.baseUrl, scaffold.baseUrl])

    await welcome.getByRole('button', { name: WELCOME_NOTICE_COPY.zh.continueLabel }).click()
    await welcome.waitFor({ state: 'detached', timeout: 15_000 })

    // The forward must be a live two-way pipe, not just a handshake: the page's
    // opens reach the Host and its items come back over the same mounted socket.
    await expect.poll(
      () => muxFrames.some(frame => frame.startsWith('sent ') && frame.includes('"type":"open"')),
      { timeout: 10_000 },
    ).toBe(true)
    await expect.poll(
      () => muxFrames.some(frame => frame.startsWith('received ') && frame.includes('"type":"item"')),
      { timeout: 10_000 },
    ).toBe(true)
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps relative fetches under the mount after in-page navigation', async () => {
    const observed = await page.evaluate(async (mount) => {
      const initialUrl = location.href
      history.pushState(null, '', `${mount}session/42`)
      try {
        const response = await fetch('api/session/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: 'public-mount-relative-session',
            method: 'session/create',
            payload: { args: { request: {} } },
          }),
        })
        return {
          baseURI: document.baseURI,
          body: await response.json() as { result?: { ok?: boolean } },
        }
      } finally {
        history.replaceState(null, '', initialUrl)
      }
    }, MOUNT)
    expect(observed.baseURI).toBe(scaffold.baseUrl)
    expect(observed.body.result?.ok).toBe(true)
    expect(offMountRequests()).toEqual([])
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
