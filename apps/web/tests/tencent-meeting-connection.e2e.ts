// Tencent Meeting sign-in, failure, and sign-out through the real Host/Remote/browser composition.
// A stand-in CLI waits for each authorization page visit and keeps the sign-in on disk.
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const TENCENT_MEETING_DIR = fileURLToPath(new URL('../../../packages/connector/tencent-meeting', import.meta.url))
const AUTH_PAGE = 'https://meeting.tencent.com/marketplace/tencentmeeting-cli-auth.html'
const authUrl = (attempt: number) => `${AUTH_PAGE}?e2e=${String(attempt)}&code=fixture-code`

// The stand-in keeps its sign-in in state.json beside itself; auth login prints
// a new authorization link on its `authorize url:` line for each attempt and
// waits until the test marks the page visited.
const TMEET = `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const dir = __dirname
const statePath = join(dir, 'state.json')
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { signedIn: false, attempts: 0 }
const save = () => { writeFileSync(statePath, JSON.stringify(state)) }
switch (process.argv.slice(2).join(' ')) {
  case 'auth status':
    process.stdout.write(state.signedIn
      ? 'Logged in\\n  OpenId:  ou_e2e\\n  UserName:  测试用户\\n'
      : "Not logged in. Please use 'tmeet auth login' to authenticate.\\n")
    break
  case 'auth login --no-browser': {
    state.attempts += 1
    save()
    process.stdout.write('\\nPlease open the following URL in your browser to authorize\\n\\nauthorize url: ${AUTH_PAGE}?e2e=' + state.attempts + '&code=fixture-code\\n\\nwaiting for authorization...\\n')
    const poll = setInterval(() => {
      if (!existsSync(join(dir, 'auth-visited'))) return
      clearInterval(poll)
      if (existsSync(join(dir, 'login-fails'))) {
        process.stderr.write('Error: authorization failed; code=fixture-code\\n')
        process.exitCode = 1
      } else {
        state.signedIn = true
        save()
        process.stdout.write('Login successful. Start managing your meetings using tmeet.\\n')
      }
    }, 50)
    break
  }
  case 'auth logout': state.signedIn = false; save(); process.stdout.write('Logout success, welcome to use it again.\\n'); break
  default:
    process.stderr.write('unexpected tmeet arguments: ' + process.argv.slice(2).join(' ') + '\\n')
    process.exitCode = 1
}
`

// The stand-in runs through its shebang, which Windows cannot execute.
describe.skipIf(process.platform === 'win32')('web e2e: Tencent Meeting plugin account', () => {
  let binDir: string
  let scaffold: WebScaffold
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    binDir = await mkdtemp(join(tmpdir(), 'dsh-tencent-meeting-e2e-'))
    await writeFile(join(binDir, 'tmeet'), TMEET)
    await chmod(join(binDir, 'tmeet'), 0o755)
    await mkdir(join(binDir, 'skills'))
    const overlay = join(binDir, 'tencent-meeting.overlay.yml')
    await writeFile(overlay, `- id: tencent-meeting\n  config:\n    binDir: ${JSON.stringify(binDir)}\n    skillsDir: ${JSON.stringify(join(binDir, 'skills'))}\n`)
    scaffold = await launchWebScaffold({
      extraOverlayPath: [fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)), overlay],
      profile: { packages: [{ dir: TENCENT_MEETING_DIR, enabled: true }] },
    })
    browser = await chromium.launch()
    context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    await context.route(url => url.href.startsWith(AUTH_PAGE), async (route) => {
      await writeFile(join(binDir, 'auth-visited'), '')
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>Tencent Meeting</title><p>Tencent Meeting stand-in page</p>' })
    })
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

  it('reports a failed sign-in without its output, signs in, and signs out after confirmation', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-tencent-meeting-connection'))
    await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
    const panel = page.locator('[data-plugin-panel]')
    await panel.getByRole('button', { name: '查看 腾讯会议插件', exact: true }).click({ timeout: 20_000 })
    const section = panel.locator('[data-connector-account-key="@deepseek-ai/dsh-tencent-meeting"]')
    await expect.poll(() => section.getAttribute('data-connector-account'), { timeout: 20_000 }).toBe('disconnected')
    expect(await panel.locator('[data-plugin-detail]').getByText('未连接', { exact: true }).count()).toBe(2)

    const opened: Page[] = []
    context.on('page', (popup) => { opened.push(popup) })
    await writeFile(join(binDir, 'login-fails'), '')
    await section.getByRole('button', { name: '连接腾讯会议', exact: true }).click()
    await section.getByRole('alert').waitFor({ timeout: 20_000 })
    expect(await section.getAttribute('data-connector-account')).toBe('disconnected')
    expect(await section.getByRole('alert').innerText()).toContain('auth-login · exit 1')
    expect(await section.innerText()).not.toContain('fixture-code')

    await rm(join(binDir, 'login-fails'))
    await rm(join(binDir, 'auth-visited'))
    await section.getByRole('button', { name: '连接腾讯会议', exact: true }).click()
    await expect.poll(() => section.getAttribute('data-connector-account'), { timeout: 20_000 }).toBe('connected')
    expect(opened.map(popup => popup.url())).toEqual([authUrl(1), authUrl(2)])
    await section.getByText('已登录为 测试用户。可以在对话中直接请 Agent 使用腾讯会议。', { exact: true }).waitFor({ timeout: 10_000 })
    await page.getByText('腾讯会议已连接', { exact: true }).waitFor({ timeout: 10_000 })

    await section.getByRole('button', { name: '退出登录', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '退出登录', exact: true }).click()
    await expect.poll(() => section.getAttribute('data-connector-account'), { timeout: 20_000 }).toBe('disconnected')
    await page.getByText('已退出腾讯会议登录', { exact: true }).waitFor({ timeout: 10_000 })
    expect(tripwire.pageErrors).toEqual([])
  })
})
