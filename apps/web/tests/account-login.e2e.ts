// Real-composition acceptance for DeepSeek account sign-in from a plain browser. The
// scaffold boots the shipped Web Loader tree, so the real account provider drives
// auth_init, the loopback OAuth callback, and auth_exchange against a loopback Platform
// double, while a real Chromium follows the tab the Web UI preopens.
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const OVERLAY_TEMPLATE = fileURLToPath(new URL('./fixtures/account-login/cordis.patch.yml', import.meta.url))
const MODE = webSnapshotMode()
const TOKEN = 'dsh_web_login_test'
const CODE = 'web-login-code'

/** Loopback Platform double: authorization handoff, code exchange, and the signed-in profile reads. */
async function mockPlatform() {
  const inits: Record<string, unknown>[] = []
  const pages: string[] = []
  let state: string | undefined
  let redirectUri: string | undefined
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const reply = (payload: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: payload } }))
    }
    if (url.pathname === '/dsh/authorize') {
      pages.push(url.href)
      // The user approves at once: Platform returns the browser to the Host callback.
      const callback = new URL(redirectUri ?? '/')
      callback.searchParams.set('code', CODE)
      callback.searchParams.set('state', state ?? '')
      res.writeHead(302, { location: callback.href }).end()
      return
    }
    if (url.pathname === '/dsh/authorized') {
      pages.push(url.href)
      res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Authorized</title>')
      return
    }
    if (req.method === 'POST' && url.pathname.startsWith('/auth-api/v0/dsh/')) {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => { body += chunk })
      req.on('end', () => {
        const payload = JSON.parse(body) as Record<string, unknown>
        if (url.pathname === '/auth-api/v0/dsh/auth_init') {
          inits.push(payload)
          state = String(payload.state)
          redirectUri = String(payload.redirect_uri)
          reply({ authorize_url: `${origin}/dsh/authorize?authorize_id=web`, authorize_id: 'web', expires_in: 300 })
          return
        }
        if (url.pathname === '/auth-api/v0/dsh/auth_exchange' && payload.code === CODE) {
          reply({ token: TOKEN, authorized_url: `${origin}/dsh/authorized` })
          return
        }
        res.writeHead(404).end()
      })
      return
    }
    if (req.headers['x-dsh-auth-token'] !== TOKEN) { res.writeHead(401).end(); return }
    if (url.pathname === '/auth-api/v0/users/current') {
      // `email` is required by the provider's profile schema even when the account has none.
      reply({ id: 'web-user', email: '', id_profile: { name: 'Web User', picture: null } })
      return
    }
    if (url.pathname === '/api/v0/users/get_user_summary') {
      reply({ normal_wallets: [{ currency: 'CNY', balance: '1.00' }], bonus_wallets: [] })
      return
    }
    if (url.pathname === '/api/v0/users/get_unnotified_bonuses') { reply([]); return }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('account login: missing mock listener')
  const origin = `http://127.0.0.1:${String(address.port)}`
  return {
    origin, inits, pages,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }),
  }
}

describe.skipIf(MODE === 'record')('web e2e: DeepSeek account sign-in in a plain browser', () => {
  let root: string | undefined
  let scaffold: WebScaffold
  let browser: Browser
  let platform: Awaited<ReturnType<typeof mockPlatform>>

  beforeAll(async () => {
    platform = await mockPlatform()
    root = await mkdtemp(join(tmpdir(), 'dsh-web-account-login-'))
    const overlay = join(root, 'account-login.overlay.yml')
    await writeFile(overlay, (await readFile(OVERLAY_TEMPLATE, 'utf8')).replaceAll('{{origin}}', platform.origin))
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await platform?.close()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  })

  it('signs in through a preopened themed tab and reports the Web login source', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'en-US', colorScheme: 'dark' })
    const page = await context.newPage()
    const console = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-account-login'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const menu = page.getByRole('button', { name: 'Account menu', exact: true })
    await menu.click()
    const tab = context.waitForEvent('page')
    await page.getByRole('menuitem', { name: 'Sign in', exact: true }).click()
    const authorization = await tab
    await authorization.waitForURL(url => url.pathname === '/dsh/authorized', { timeout: 30_000 })
    expect(await authorization.evaluate(() => window.opener === null)).toBe(true)
    await expect.poll(() => menu.textContent(), { timeout: 30_000 }).toBe('Web User')

    const pageOrigin = new URL(scaffold.authenticatedUrl).origin
    expect(platform.inits).toHaveLength(1)
    expect(platform.inits[0]).toMatchObject({ login_source: 'web', redirect_uri: `${pageOrigin}/oauth/callback` })
    const [authorize, authorized] = platform.pages.map(href => new URL(href))
    expect(authorize?.searchParams.get('theme')).toBe('dark')
    expect(authorized?.searchParams.get('login_source')).toBe('web')
    expect(console.pageErrors).toEqual([])
    await context.close()
  }, 90_000)
})
