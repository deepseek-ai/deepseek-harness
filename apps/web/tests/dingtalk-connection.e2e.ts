// DingTalk sign-in failures, recovery, and sign-out through the real Host/Remote/browser composition.
// A stand-in dws waits for each authorization page visit and keeps its sign-in on disk.
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const DINGTALK_DIR = fileURLToPath(new URL('../../../packages/connector/dingtalk', import.meta.url))
const AUTH_PAGE = 'https://login.dingtalk.com/oauth2/auth'
const authUrl = (attempt: number) => `${AUTH_PAGE}?e2e=${String(attempt)}&state=fixture-state`

// The stand-in keeps its sign-in in state.json beside itself. auth login prints a
// new authorization link alone on an indented stderr line for each attempt and
// waits until the test marks the page visited; its second successful sign-in
// makes a second organization's account current, as the stand-in's own rule;
// auth logout accepts only the current account's profile.
const DWS = `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const dir = __dirname
const statePath = join(dir, 'state.json')
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { signedIn: false, attempts: 0, logins: 0 }
const ACCOUNTS = [
  { corp_id: 'corp-e2e', corp_name: 'E2E 组织', user_id: 'user-e2e', user_name: 'E2E 用户' },
  { corp_id: 'corp-e2e-2', corp_name: '第二个 E2E 组织', user_id: 'user-e2e-2', user_name: '第二个 E2E 用户' },
]
const current = () => ACCOUNTS[Math.min(state.logins, ACCOUNTS.length) - 1]
const save = () => { writeFileSync(statePath, JSON.stringify(state)) }
const json = (value) => JSON.stringify(value, null, 2) + '\\n'
switch (process.argv.slice(2).join(' ')) {
  case 'auth status --format json':
    process.stdout.write(json(state.signedIn
      ? { success: true, authenticated: true, ...current() }
      : { success: true, authenticated: false, message: '未登录' }))
    break
  case 'auth login --no-browser --format json': {
    state.attempts += 1
    save()
    process.stderr.write('\\n🔐 登录钉钉\\n\\n请在浏览器中完成扫码授权。\\n如果浏览器未自动打开，请手动访问:\\n  ${AUTH_PAGE}?e2e=' + state.attempts + '&state=fixture-state\\n\\n⏳ 等待授权中...\\n')
    const poll = setInterval(() => {
      if (!existsSync(join(dir, 'auth-visited'))) return
      clearInterval(poll)
      if (existsSync(join(dir, 'login-fails'))) {
        process.stderr.write(json({ error: { category: 'auth', message: 'dingtalk login failed; state=fixture-state' } }))
        process.exitCode = 2
      } else {
        state.signedIn = true
        state.logins += 1
        save()
        process.stdout.write(json({ success: true, message: '登录成功' }))
      }
    }, 50)
    break
  }
  case state.signedIn ? 'auth logout --profile ' + current().corp_id + ':' + current().user_id : 'auth logout':
    state.signedIn = false
    save()
    process.stdout.write('[OK] 已清除认证信息\\n')
    break
  default:
    process.stderr.write('unexpected dws arguments: ' + process.argv.slice(2).join(' ') + '\\n')
    process.exitCode = 1
}
`

// The stand-in runs through its shebang, which Windows cannot execute.
describe.skipIf(process.platform === 'win32')('web e2e: DingTalk plugin account', () => {
  let binDir: string
  let scaffold: WebScaffold
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    binDir = await mkdtemp(join(tmpdir(), 'dsh-dingtalk-e2e-'))
    await writeFile(join(binDir, 'dws'), DWS)
    await chmod(join(binDir, 'dws'), 0o755)
    // Stand-in skills keep the row from downloading the release's skills archive.
    const skillsDir = join(binDir, 'skills')
    await mkdir(join(skillsDir, 'dingtalk-shared'), { recursive: true })
    await writeFile(join(skillsDir, 'dingtalk-shared', 'SKILL.md'), '# DingTalk stand-in guide\n')
    const overlay = join(binDir, 'dingtalk.overlay.yml')
    await writeFile(overlay, `- id: dingtalk\n  config:\n    binDir: ${JSON.stringify(binDir)}\n    skillsDir: ${JSON.stringify(skillsDir)}\n`)
    scaffold = await launchWebScaffold({
      extraOverlayPath: [fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)), overlay],
      profile: { packages: [{ dir: DINGTALK_DIR, enabled: true }] },
    })
    browser = await chromium.launch()
    context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    await context.route(url => url.href.startsWith(AUTH_PAGE), async (route) => {
      await writeFile(join(binDir, 'auth-visited'), '')
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>DingTalk</title><p>DingTalk stand-in page</p>' })
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

  it('reports a failed sign-in without its output, connects on retry, signs in to another organization, and signs out after confirmation', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-dingtalk-connection'))
    await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
    const panel = page.locator('[data-plugin-panel]')
    await panel.getByRole('button', { name: '查看 钉钉插件', exact: true }).click({ timeout: 20_000 })
    const section = panel.locator('[data-connector-account-key="@deepseek-ai/dsh-dingtalk"]')
    await expect.poll(() => section.getAttribute('data-connector-account'), { timeout: 20_000 }).toBe('disconnected')
    expect(await panel.locator('[data-plugin-detail]').getByText('未连接', { exact: true }).count()).toBe(2)

    const opened: Page[] = []
    context.on('page', (popup) => { opened.push(popup) })
    await writeFile(join(binDir, 'login-fails'), '')
    await section.getByRole('button', { name: '连接钉钉', exact: true }).click()
    await section.getByRole('alert').waitFor({ timeout: 20_000 })
    expect(await section.getAttribute('data-connector-account')).toBe('disconnected')
    expect(await section.getByRole('alert').innerText()).toContain('auth-login · exit 2')
    expect(await section.innerText()).not.toContain('fixture-state')

    await rm(join(binDir, 'login-fails'))
    await rm(join(binDir, 'auth-visited'))
    await section.getByRole('button', { name: '连接钉钉', exact: true }).click()
    await expect.poll(() => section.getAttribute('data-connector-account'), { timeout: 20_000 }).toBe('connected')
    expect(opened.map(popup => popup.url())).toEqual([authUrl(1), authUrl(2)])
    await section.getByText('已登录为 E2E 组织 的 E2E 用户。可以在对话中直接请 Agent 使用钉钉。', { exact: true }).waitFor({ timeout: 10_000 })
    await page.getByText('钉钉已连接', { exact: true }).waitFor({ timeout: 10_000 })

    // Signing in again while connected adds another organization's account; the section shows the account dws then reports.
    await rm(join(binDir, 'auth-visited'))
    await section.getByRole('button', { name: '登录其他组织', exact: true }).click()
    await expect.poll(() => section.getAttribute('data-connector-account'), { timeout: 20_000 }).toBe('connecting')
    await expect.poll(() => section.getAttribute('data-connector-account'), { timeout: 20_000 }).toBe('connected')
    expect(opened.map(popup => popup.url())).toEqual([authUrl(1), authUrl(2), authUrl(3)])
    await section.getByText('已登录为 第二个 E2E 组织 的 第二个 E2E 用户。可以在对话中直接请 Agent 使用钉钉。', { exact: true }).waitFor({ timeout: 10_000 })

    await section.getByRole('button', { name: '退出登录', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '退出钉钉登录？' })
    await dialog.getByRole('button', { name: '退出登录', exact: true }).click()
    await expect.poll(() => section.getAttribute('data-connector-account'), { timeout: 20_000 }).toBe('disconnected')
    await page.getByText('已退出钉钉登录', { exact: true }).waitFor({ timeout: 10_000 })
    expect(tripwire.pageErrors).toEqual([])
  })
})
