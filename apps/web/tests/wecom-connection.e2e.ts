// WeCom QR-code authorization failures and recovery through the real Host/Remote/browser composition.
// A stand-in CLI waits for each QR-code page visit and keeps the authorization on disk.
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const WECOM_DIR = fileURLToPath(new URL('../../../packages/connector/wecom', import.meta.url))
const QR_PAGE = 'https://work.weixin.qq.com/ai/qc/gen'
const qrUrl = (attempt: number) => `${QR_PAGE}?e2e=${String(attempt)}&scode=fixture-scode`

// The stand-in keeps its authorization in state.json beside itself; auth init
// prints a new QR-code link alone on its third stdout line for each attempt and
// waits until the test marks the page visited.
const WECOM_CLI = `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const dir = __dirname
const statePath = join(dir, 'state.json')
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { authorized: false, attempts: 0, bots: 0 }
const save = () => { writeFileSync(statePath, JSON.stringify(state)) }
switch (process.argv.slice(2).join(' ')) {
  case 'auth show': process.stdout.write(state.authorized ? 'Status: authorized\\nBot ID: bot-e2e-' + state.bots + '\\n' : 'Status: unauthorized\\n'); break
  case 'auth init --noninteractive --no-browser': {
    state.attempts += 1
    save()
    process.stdout.write('Scan the QR code with WeCom to bind a bot.\\nOpen this link if the QR code does not display:\\n${QR_PAGE}?e2e=' + state.attempts + '&scode=fixture-scode\\n')
    const poll = setInterval(() => {
      if (!existsSync(join(dir, 'qr-visited'))) return
      clearInterval(poll)
      if (existsSync(join(dir, 'init-fails'))) {
        process.stdout.write('bind failed; scode=fixture-scode\\n')
        process.exitCode = 4
      } else { state.authorized = true; state.bots += 1; save() }
    }, 50)
    break
  }
  default:
    process.stderr.write('unexpected wecom-cli arguments: ' + process.argv.slice(2).join(' ') + '\\n')
    process.exitCode = 1
}
`

// The stand-in runs through its shebang, which Windows cannot execute.
describe.skipIf(process.platform === 'win32')('web e2e: WeCom plugin authorization', () => {
  let binDir: string
  let scaffold: WebScaffold
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    binDir = await mkdtemp(join(tmpdir(), 'dsh-wecom-e2e-'))
    await writeFile(join(binDir, 'wecom-cli'), WECOM_CLI)
    await chmod(join(binDir, 'wecom-cli'), 0o755)
    await mkdir(join(binDir, 'skills'))
    const overlay = join(binDir, 'wecom.overlay.yml')
    await writeFile(overlay, `- id: wecom\n  config:\n    binDir: ${JSON.stringify(binDir)}\n    skillsDir: ${JSON.stringify(join(binDir, 'skills'))}\n`)
    scaffold = await launchWebScaffold({
      extraOverlayPath: [fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)), overlay],
      profile: { packages: [{ dir: WECOM_DIR, enabled: true }] },
    })
    browser = await chromium.launch()
    context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    await context.route(url => url.href.startsWith(QR_PAGE), async (route) => {
      await writeFile(join(binDir, 'qr-visited'), '')
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>WeCom</title><p>WeCom stand-in page</p>' })
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

  it('reports a failed QR-code authorization without its output, connects, and changes the bot after confirmation', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-wecom-connection'))
    await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
    const panel = page.locator('[data-plugin-panel]')
    await panel.getByRole('button', { name: '查看 企业微信', exact: true }).click({ timeout: 20_000 })
    const section = panel.locator('[data-connector-account-key="@deepseek-ai/dsh-wecom"]')
    await expect.poll(() => section.getAttribute('data-connector-account'), { timeout: 20_000 }).toBe('disconnected')
    expect(await panel.locator('[data-plugin-detail]').getByText('未授权', { exact: true }).count()).toBe(2)

    const opened: Page[] = []
    context.on('page', (popup) => { opened.push(popup) })
    await writeFile(join(binDir, 'init-fails'), '')
    await section.getByRole('button', { name: '连接企业微信', exact: true }).click()
    await section.getByRole('alert').waitFor({ timeout: 20_000 })
    expect(await section.getAttribute('data-connector-account')).toBe('disconnected')
    expect(await section.getByRole('alert').innerText()).toContain('auth-init · exit 4')
    expect(await section.innerText()).not.toContain('fixture-scode')

    await rm(join(binDir, 'init-fails'))
    await rm(join(binDir, 'qr-visited'))
    await section.getByRole('button', { name: '连接企业微信', exact: true }).click()
    await expect.poll(() => section.getAttribute('data-connector-account'), { timeout: 20_000 }).toBe('connected')
    expect(opened.map(popup => popup.url())).toEqual([qrUrl(1), qrUrl(2)])
    await section.getByText('可以在对话中直接请 Agent 使用企业微信。', { exact: true }).waitFor({ timeout: 10_000 })
    await page.getByText('企业微信已授权', { exact: true }).waitFor({ timeout: 10_000 })
    await section.getByText('已绑定机器人：bot-e2e-1', { exact: true }).waitFor({ timeout: 10_000 })

    // Changing the bot asks first, then runs the same QR-code binding; the stand-in reports the next bot afterwards.
    await rm(join(binDir, 'qr-visited'))
    await section.getByRole('button', { name: '更换机器人', exact: true }).click()
    await page.getByRole('dialog', { name: '更换机器人？' }).getByRole('button', { name: '更换机器人', exact: true }).click()
    await section.getByText('已绑定机器人：bot-e2e-2', { exact: true }).waitFor({ timeout: 20_000 })
    expect(await section.getAttribute('data-connector-account')).toBe('connected')
    expect(opened.map(popup => popup.url())).toEqual([qrUrl(1), qrUrl(2), qrUrl(3)])
    expect(tripwire.pageErrors).toEqual([])
  })
})
