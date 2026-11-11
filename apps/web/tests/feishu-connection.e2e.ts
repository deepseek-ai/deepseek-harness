// Feishu setup failures and recovery through the real Host/Remote/browser composition.
// A stand-in CLI waits for each authorization page visit and keeps account state on disk.
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const FEISHU_DIR = fileURLToPath(new URL('../../../packages/connector/feishu', import.meta.url))
const SETUP_URL = 'https://open.feishu.cn/page/cli?e2e=1'
const SETUP_RETRY_URL = `${SETUP_URL}&retry=1`
const SIGN_IN_URL = 'https://accounts.feishu.cn/oauth/device?e2e=1'

// The stand-in keeps its account in state.json beside itself; app setup and
// sign-in wait until the test marks their page visited.
const LARK_CLI = `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const dir = __dirname
const statePath = join(dir, 'state.json')
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { app: false, user: false }
const save = () => { writeFileSync(statePath, JSON.stringify(state)) }
const visited = (name, done) => {
  const poll = setInterval(() => {
    if (!existsSync(join(dir, name))) return
    clearInterval(poll)
    done()
  }, 50)
}
const line = (value) => { process.stdout.write(JSON.stringify(value) + '\\n') }
switch (process.argv.slice(2).join(' ')) {
  case 'auth status --verify --json':
    if (!state.app) {
      process.stderr.write(JSON.stringify({ ok: false, error: { type: 'config', subtype: 'not_configured' } }))
      process.exitCode = 3
    } else if (!state.user) line({ appId: 'cli_e2e', identities: { user: { status: 'missing', available: false } } })
    else line({ appId: 'cli_e2e', identities: { user: { status: 'ready', available: true, verified: true, userName: '测试用户', openId: 'ou_e2e' } } })
    break
  case 'config init --new':
    process.stderr.write('Open this link to create an app:\\n  ' + (existsSync(join(dir, 'setup-fails')) ? '${SETUP_URL}' : '${SETUP_RETRY_URL}') + '\\n')
    visited('setup-visited', () => {
      if (existsSync(join(dir, 'setup-fails'))) {
        process.stderr.write('OK: App configured!\\n' + JSON.stringify({ ok: false, error: {
          type: 'internal', subtype: 'sdk_error',
          message: 'keychain Set failed: /private/user/appsecret.enc.tmp: operation not permitted; token=fixture-secret',
          hint: 'https://open.feishu.cn/page/cli?user_code=fixture-code',
        } }, null, 2) + '\\n')
        process.exitCode = 5
      } else { state.app = true; save() }
    })
    break
  case 'auth login --json':
    line({ event: 'device_authorization', verification_uri_complete: '${SIGN_IN_URL}' })
    visited('sign-in-visited', () => { state.user = true; save(); line({ event: 'authorization_complete', user_open_id: 'ou_e2e', missing: [] }) })
    break
  case 'auth logout --json': state.user = false; save(); line({ ok: true }); break
  default:
    process.stderr.write('unexpected lark-cli arguments: ' + process.argv.slice(2).join(' ') + '\\n')
    process.exitCode = 1
}
`

// The stand-in runs through its shebang, which Windows cannot execute.
describe.skipIf(process.platform === 'win32')('web e2e: Feishu plugin connection', () => {
  let binDir: string
  let scaffold: WebScaffold
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    binDir = await mkdtemp(join(tmpdir(), 'dsh-feishu-e2e-'))
    await writeFile(join(binDir, 'lark-cli'), LARK_CLI)
    await chmod(join(binDir, 'lark-cli'), 0o755)
    const overlay = join(binDir, 'feishu.overlay.yml')
    await writeFile(overlay, `- id: feishu\n  config:\n    binDir: ${JSON.stringify(binDir)}\n`)
    scaffold = await launchWebScaffold({
      extraOverlayPath: [fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)), overlay],
      profile: { packages: [{ dir: FEISHU_DIR, enabled: true }] },
    })
    browser = await chromium.launch()
    context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    for (const [url, marker] of [[SETUP_URL, 'setup-visited'], [SETUP_RETRY_URL, 'setup-visited'], [SIGN_IN_URL, 'sign-in-visited']] as const) {
      await context.route(url, async (route) => {
        await writeFile(join(binDir, marker), '')
        await route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>Feishu</title><p>Feishu stand-in page</p>' })
      })
    }
    page = await context.newPage()
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (binDir !== undefined) await rm(binDir, { recursive: true, force: true })
  })

  it('reports failed local setup, then links an existing app, signs in, and signs out', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-feishu-connection'))
    await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
    const panel = page.locator('[data-plugin-panel]')
    await panel.getByRole('button', { name: '查看 飞书插件', exact: true }).click({ timeout: 20_000 })
    const section = panel.locator('[data-connector-account-key="@deepseek-ai/dsh-feishu"]')
    await expect.poll(() => section.getAttribute('data-connector-account'), { timeout: 20_000 }).toBe('disconnected')
    expect(await panel.locator('[data-plugin-detail]').getByText('未连接', { exact: true }).count()).toBe(2)

    const opened: Page[] = []
    context.on('page', (popup) => { opened.push(popup) })
    await writeFile(join(binDir, 'setup-fails'), '')
    await section.getByRole('button', { name: '关联飞书应用', exact: true }).click()
    await section.getByRole('alert').waitFor({ timeout: 20_000 })
    expect(await section.getAttribute('data-connector-account')).toBe('disconnected')
    expect(await section.getByRole('alert').innerText()).toContain('config-init · exit 5')
    expect(await section.getByRole('alert').innerText()).toContain('已有应用')
    expect(await section.innerText()).not.toContain('fixture-secret')
    expect(await section.innerText()).not.toContain('fixture-code')
    expect(await section.innerText()).not.toContain('/private/user')
    await expect(readFile(join(binDir, 'state.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(join(binDir, 'setup-fails'))
    await rm(join(binDir, 'setup-visited'))
    await section.getByRole('button', { name: '关联飞书应用', exact: true }).click()
    await page.getByText('飞书应用已关联，下一步登录飞书账号', { exact: true }).waitFor({ timeout: 20_000 })
    expect(opened.map(popup => popup.url())).toEqual([SETUP_URL, SETUP_RETRY_URL])
    await section.getByRole('button', { name: '登录飞书账号', exact: true }).click()
    await expect.poll(() => section.getAttribute('data-connector-account'), { timeout: 20_000 }).toBe('connected')
    expect(opened.map(popup => popup.url())).toEqual([SETUP_URL, SETUP_RETRY_URL, SIGN_IN_URL])
    await section.getByText('已登录为 测试用户。可以在对话中直接请 Agent 使用飞书。', { exact: true }).waitFor({ timeout: 10_000 })
    await page.getByText('飞书已连接', { exact: true }).waitFor({ timeout: 10_000 })

    await section.getByRole('button', { name: '退出登录', exact: true }).click()
    await page.getByRole('dialog', { name: '退出飞书登录？' }).getByRole('button', { name: '退出登录', exact: true }).click()
    await expect.poll(() => section.getAttribute('data-connector-account'), { timeout: 20_000 }).toBe('disconnected')
    await page.getByText('已退出飞书登录', { exact: true }).waitFor({ timeout: 10_000 })
    expect(tripwire.pageErrors).toEqual([])
  })
})
