// Shipped Loader composition, real account/settings APIs, and an isolated external Platform fixture.
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectDesktopWelcome } from '../../desktop/src/welcome-backend.ts'
import { chromium, type Browser, type Page } from 'playwright'
import { afterEach, beforeEach, describe, expect, it, onTestFailed } from 'vitest'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'
import {
  acknowledgeReloadConnectionLoss, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { REPO_ROOT, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const MODE = webSnapshotMode()
const EXPECTED = fileURLToPath(new URL('./expected/desktop-onboarding', import.meta.url))
const NS = 'ui-settings-account'
const INITIAL = { version: 1, step: 'welcome', purpose: null, process: null, completion: null, usage: 'compact', developerTools: false }

describe.skipIf(MODE === 'record')('web e2e: App-only desktop onboarding', () => {
  let root: string
  let server: Server
  let origin: string
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let balanceFailure = false
  let balanceReads = 0
  let walletBalance = '0E-16'
  let bonusBalance = '0'
  let screenshots: string | undefined

  beforeEach(async () => {
    balanceFailure = false
    balanceReads = 0
    walletBalance = '0E-16'
    bonusBalance = '0'
    screenshots = undefined
    root = await mkdtemp(join(tmpdir(), 'dsh-desktop-onboarding-'))
    server = createServer((request, response) => {
      if (request.url !== '/auth-api/v0/users/current' && request.url !== '/api/v0/users/get_user_summary') {
        response.writeHead(404).end()
        return
      }
      const balance = request.url === '/api/v0/users/get_user_summary'
      if (balance) balanceReads++
      const value = balance
        ? { bonus_wallets: [{ currency: 'CNY', balance: bonusBalance }], normal_wallets: [{ currency: 'CNY', balance: walletBalance }] }
        : { id: 'onboarding-fixture-user', email: 'f***@example.invalid', id_profile: { name: 'Onboarding Fixture' } }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ code: 0, data: { biz_code: balance && balanceFailure ? 17 : 0, biz_data: value } }))
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture server address unavailable')
    origin = `http://127.0.0.1:${address.port}`
    const overlay = join(root, 'account.patch.yml')
    await writeFile(overlay, `- id: deepseek-account\n  config:\n    platformOrigin: ${origin}\n    allowLoopbackHttp: true\n`)
    scaffold = await launchWebScaffold({ deepSeekMissingCredential: true, extraOverlayPath: overlay })
    await scaffold.ctx.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'default'), async () => ({
      kind: 'grant', payload: { version: 1, issuer: origin, token: 'onboarding-fixture-token' },
    }))
    browser = await chromium.launch()
  })

  afterEach(async () => {
    try { await browser?.close() } finally {
      try { await scaffold?.close() } finally {
        try {
          if (server?.listening) await new Promise<void>((resolve, reject) => {
            server.close((error) => { if (error) reject(error); else resolve() })
          })
        } finally {
          if (root !== undefined) await rm(root, { recursive: true, force: true })
        }
      }
    }
  })

  async function desktopPage(locale = ZH_BROWSER_LOCALE): Promise<Page> {
    const opened = await browser.newPage({ viewport: { width: 1280, height: 840 }, locale, reducedMotion: 'reduce' })
    const welcome = await connectDesktopWelcome(scaffold.authenticatedUrl, (input, init) => scaffold.hostFetch(input, init))
    await opened.exposeFunction('__onboardingHasApiKey', async () => (await welcome.read()).hasApiKey)
    await opened.addInitScript(() => {
      Object.defineProperty(globalThis, 'dshOnboarding', { value: {
        hasApiKey: () => (globalThis as typeof globalThis & { __onboardingHasApiKey(): Promise<boolean> }).__onboardingHasApiKey(),
        setActive: () => {},
      } })
      Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } })
      Object.defineProperty(globalThis, 'dshPlatform', { value: {
        open: async () => {}, setBounds: async () => {}, close: async () => {},
      } })
    })
    return opened
  }

  async function snapshot(name: string): Promise<void> {
    await expect.poll(() => page.locator('[data-desktop-onboarding]').getAttribute('aria-busy')).toBe('false')
    const aria = await captureStableAria(page, '[data-desktop-onboarding]', scaffold.workspaceCwd)
    await mkdir(EXPECTED, { recursive: true })
    await compareOrRefreshGolden(join(EXPECTED, `${name}.expected.md`), aria, MODE)
    if (MODE === 'refresh' && screenshots === undefined) {
      const artifacts = join(REPO_ROOT, '.artifacts')
      await mkdir(artifacts, { recursive: true })
      screenshots = await mkdtemp(join(artifacts, 'desktop-onboarding-'))
      console.log(`Onboarding screenshots: ${screenshots}`)
    }
    for (const viewport of [
      { width: 880, height: 600 }, { width: 960, height: 600 }, { width: 1000, height: 780 }, { width: 1200, height: 920 },
      { width: 1440, height: 920 }, { width: 2200, height: 1200 },
    ]) {
      await page.setViewportSize(viewport)
      await page.evaluate(async () => { await document.fonts.ready })
      const geometry = await page.locator('[data-desktop-onboarding]').evaluate(region => ({
        scrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        clippedControls: [...region.querySelectorAll('h1, button, label')].filter((element) => {
          const box = element.getBoundingClientRect()
          const outside = box.left < 0 || box.top < 0 || box.right > window.innerWidth + 1 || box.bottom > window.innerHeight + 1
          return box.width > 0 && box.height > 0 && outside
        }).map(element => element.textContent?.trim() || element.getAttribute('aria-label')),
      }))
      expect(geometry.scrollWidth, `${name} at ${viewport.width}: document width`).toBeLessThanOrEqual(geometry.viewportWidth)
      expect(geometry.clippedControls, `${name} at ${viewport.width}: clipped controls`).toEqual([])
      const primary = page.locator('[class*="primaryAction"] > button')
      if (await primary.count()) {
        expect(await primary.evaluate((button) => {
          const box = button.getBoundingClientRect()
          return [2, box.height / 2, box.height - 2]
            .every(y => button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + y)))
        }), `${name}: primary action receives clicks across its height`).toBe(true)
      }
      if (name.includes('-en-')) {
        const headingFont = await page.locator('h1').evaluate(element => ({
          font: getComputedStyle(element).fontFamily, weight: getComputedStyle(element).fontWeight,
        }))
        expect(headingFont.font).toContain('Montserrat')
        expect(headingFont.weight).toBe('300')
        const brandWeights = await page.locator('h1 em').evaluateAll(elements => elements.map(element => getComputedStyle(element).fontWeight))
        expect(brandWeights.every(weight => weight === '500')).toBe(true)
        expect(await page.evaluate(async () => (await document.fonts.load('500 28px Montserrat')).length)).toBeGreaterThan(0)
        const copyFonts = await page.locator('[class*="heroDescription"], [class*="subtitle"], [class*="cardTitle"], [class*="cardDescription"]')
          .evaluateAll(elements => elements.map(element => getComputedStyle(element).fontFamily))
        expect(copyFonts.every(font => font.includes('Montserrat'))).toBe(true)
        const buttonFonts = await page.locator('[class*="navigation"] button').evaluateAll(elements =>
          elements.map(element => getComputedStyle(element).fontFamily))
        expect(buttonFonts.every(font => font.includes('Montserrat'))).toBe(true)
        expect(await page.evaluate(async () => (await document.fonts.load('300 28px Montserrat')).length)).toBeGreaterThan(0)
      }
      if ((name === 'purpose' || name === 'process') && viewport.height > 760) {
        const card = await page.locator('[class*="cardTitle"]').first().locator('..').boundingBox()
        const action = await page.locator('[class*="primaryAction"]').boundingBox()
        expect(card).not.toBeNull()
        expect(action).not.toBeNull()
        expect(action!.y - (card!.y + card!.height)).toBeCloseTo(name === 'process' ? 101.5 : 100, 0)
        if (viewport.width === 1440 && viewport.height === 920) {
          expect(card!.y).toBeCloseTo(name === 'purpose' ? 396.5 : 398, 0)
          expect(card!.height).toBeCloseTo(222, 0)
        }
      }
      if (name === 'process' && viewport.width === 960) {
        const card = await page.getByRole('radio').first().boundingBox()
        const action = await page.getByRole('button', { name: '进入应用', exact: true }).boundingBox()
        expect(card?.x).toBeCloseTo(40, 0)
        expect(card?.y).toBeCloseTo(244, 0)
        expect(card?.height).toBeCloseTo(187, 0)
        expect(action?.width).toBeCloseTo(240, 0)
        expect(action!.y - (card!.y + card!.height)).toBeCloseTo(40, 0)
      }
      if (name === 'welcome' || name === 'credit') {
        const illustrations = await page.locator('[class*="illustration"] > img:visible').evaluateAll(elements => elements.map((element) => {
          const image = element as HTMLImageElement
          const box = image.getBoundingClientRect()
          return {
            width: box.width, ratio: box.width / box.height, exportedRatio: image.naturalWidth / image.naturalHeight,
            loaded: image.complete && image.naturalWidth > 0,
          }
        }))
        expect(illustrations).toHaveLength(1)
        for (const illustration of illustrations) {
          expect(illustration.loaded).toBe(true)
          expect(illustration.width).toBeGreaterThan(0)
          expect(illustration.ratio).toBeCloseTo(illustration.exportedRatio, 2)
        }

      }
      if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, `${name}-${viewport.width}x${viewport.height}.png`) })
    }
    await page.setViewportSize({ width: 1280, height: 840 })
  }

  it('keeps Web unchanged, resumes App progress, and returns to credit even when balance refresh fails', async () => {
    const web = await browser.newPage({ viewport: { width: 1280, height: 840 }, locale: ZH_BROWSER_LOCALE })
    try {
      await web.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await web.getByText('选择一个工作区开始', { exact: true }).waitFor()
      expect(await web.locator('[data-desktop-onboarding]').count()).toBe(0)
      expect((scaffold.ctx.settings.describe().find(row => row.ns === NS)?.value as { step: string }).step).toBe('welcome')
    } finally { await web.close() }

    page = await desktopPage()
    tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'desktop-onboarding'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: '开始设置', exact: true }).waitFor()
    expect(await page.getByRole('button', { name: '跳过', exact: true }).count()).toBe(0)
    expect(await page.locator('[data-desktop-onboarding]').count()).toBe(1)
    await snapshot('welcome')
    for (const platform of ['darwin', 'win32']) {
      await page.evaluate((value) => { document.documentElement.dataset.platform = value }, platform)
      expect(await page.locator('[data-desktop-onboarding]').evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-app-region'))).toBe('none')
      expect(await page.getByRole('button', { name: '开始设置', exact: true }).evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-app-region'))).toBe(platform === 'darwin' ? 'no-drag' : 'none')
    }
    await page.evaluate(() => { delete document.documentElement.dataset.platform })
    await page.getByRole('button', { name: '开始设置', exact: true }).click()
    await page.getByRole('heading', { name: '准备可用额度', exact: true }).waitFor()
    expect(await page.getByRole('button', { name: '下一步', exact: true })
      .evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(255, 255, 255)')
    await snapshot('credit')
    const laterButton = page.getByRole('button', { name: '下一步', exact: true })
    await laterButton.hover()
    const laterHover = await laterButton.evaluate(element => ({
      fill: getComputedStyle(element).backgroundColor, overlay: getComputedStyle(element).backgroundImage,
    }))
    expect(laterHover.fill).toBe('rgb(255, 255, 255)')
    expect(laterHover.overlay).toContain('rgba(38, 49, 72, 0.06)')
    if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'credit-later-hover.png') })
    const warningsBefore = tripwire.warnings.length
    const [balanceResponse] = await Promise.all([
      page.waitForResponse('**/api/account/getBalance'),
      page.reload({ waitUntil: 'load' }),
    ])
    await balanceResponse.finished()
    acknowledgeReloadConnectionLoss(tripwire, warningsBefore)
    await page.getByRole('heading', { name: '准备可用额度', exact: true }).waitFor()
    expect(await page.getByRole('button', { name: '开始设置', exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: '下一步', exact: true }).click()
    await page.getByRole('heading', { name: '暂时跳过充值？', exact: true }).waitFor()
    expect(await page.locator('[data-desktop-onboarding]').evaluate(element => getComputedStyle(element).filter)).toBe('none')
    expect(await page.getByRole('dialog').evaluate(element => getComputedStyle(element.previousElementSibling!).backdropFilter)).toBe('none')
    await page.getByRole('button', { name: '前往充值', exact: true }).click()
    await page.getByRole('button', { name: '返回 DeepSeek Harness', exact: true }).waitFor()
    expect((scaffold.ctx.settings.describe().find(row => row.ns === NS)?.value as { step: string }).step).toBe('credit')
    balanceFailure = true
    const readsBefore = balanceReads
    await page.getByRole('button', { name: '返回 DeepSeek Harness', exact: true }).click()
    await page.getByRole('heading', { name: '准备可用额度', exact: true }).waitFor()
    await expect.poll(() => balanceReads).toBeGreaterThan(readsBefore)
    await expect.poll(() => page.getByRole('button', { name: '下一步', exact: true }).isEnabled()).toBe(true)
    await page.getByRole('button', { name: '下一步', exact: true }).click()
    await page.getByRole('checkbox', { name: '办公与创作', exact: true }).waitFor()
    await snapshot('purpose')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const development = page.getByRole('checkbox', { name: '代码与开发', exact: true })
    const description = page.locator('[class*="purposeCards"] > div').last().locator('[class*="cardDescription"]')
    for (const selected of [true, false]) {
      const box = await description.boundingBox()
      if (box === null) throw new Error('development description is not visible')
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await expect.poll(() => development.isChecked()).toBe(selected)
      await expect.poll(() => page.locator('[data-desktop-onboarding]').getAttribute('aria-busy')).toBe('false')
    }
    const title = await page.getByText('代码与开发', { exact: true }).boundingBox()
    if (title === null) throw new Error('development card title is not visible')
    await page.mouse.click(title.x + title.width / 2, title.y + title.height / 2)
    await expect.poll(() => development.isChecked()).toBe(true)
    const office = page.getByRole('checkbox', { name: '办公与创作', exact: true })
    await office.locator('..').click()
    await expect.poll(() => office.isChecked()).toBe(true)
    const icons = page.locator('[class*="purposeCards"] > div').first().locator('[class*="fileIcons"] > svg')
    const iconMotion = await icons.evaluateAll(elements => elements.map(e => ({
      name: getComputedStyle(e).animationName, delay: getComputedStyle(e).animationDelay,
      origin: getComputedStyle(e).transformOrigin,
    })))
    expect(iconMotion.every(icon => icon.name.includes('iconEnter') && icon.origin.startsWith('0px'))).toBe(true)
    expect(iconMotion.map(icon => icon.delay)).toEqual(['0s', '0.03s', '0.05s', '0.062s', '0.07s'])
    const officeCard = page.locator('[class*="purposeCards"] > div').first()
    await office.focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    const focusStyles = await officeCard.evaluate((card) => {
      const checkbox = card.querySelector('input')!
      return {
        drag: getComputedStyle(card).getPropertyValue('-webkit-app-region'),
        card: getComputedStyle(card).outlineStyle,
        checkbox: getComputedStyle(checkbox).outlineStyle,
        indicator: getComputedStyle(checkbox.nextElementSibling!).outlineStyle,
      }
    })
    expect(focusStyles).toEqual({ drag: 'no-drag', card: 'solid', checkbox: 'none', indicator: 'none' })
    await expect.poll(() => officeCard.evaluate(card => getComputedStyle(card, '::after').opacity)).toBe('1')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const purposeBorders = await page.locator('[class*="purposeCards"] > div').evaluateAll(cards => cards.map(card => ({
      gradient: getComputedStyle(card, '::after').backgroundImage,
      opacity: getComputedStyle(card, '::after').opacity,
    })))
    expect(purposeBorders[0]?.gradient).toContain('conic-gradient(')
    expect(purposeBorders[0]?.gradient).toContain('rgb(42, 47, 182)')
    expect(purposeBorders[1]?.gradient).toContain('rgb(57, 100, 254)')
    expect(purposeBorders.map(border => border.opacity)).toEqual(['1', '1'])
    const back = page.getByRole('button', { name: '上一步', exact: true })
    const restingBackColor = await back.evaluate(element => getComputedStyle(element).color)
    await back.hover()
    const hoverBack = await back.evaluate(element => ({
      text: getComputedStyle(element).color,
      arrow: getComputedStyle(element.querySelector('span')!).backgroundColor,
    }))
    expect(hoverBack.text).not.toBe(restingBackColor)
    expect(hoverBack.arrow).toBe(hoverBack.text)
    if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'purpose-selected-back-hover.png') })
    await page.getByRole('button', { name: '继续', exact: true }).click()
    await page.getByRole('radiogroup').waitFor()
    await page.getByRole('button', { name: '上一步', exact: true }).click()
    await office.waitFor()
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    expect(await icons.evaluateAll(elements => elements.map(e => getComputedStyle(e).animationName))).toEqual(Array(5).fill('none'))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('button', { name: '继续', exact: true }).click()
    await page.getByRole('radiogroup').waitFor()
    await page.getByRole('radio', { name: /聚焦结果/ }).focus()
    for (const [name, process] of [['关键细节', 'standard'], ['完整过程', 'detailed']] as const) {
      const [saved] = await Promise.all([
        page.waitForResponse((response) => {
          if (!response.url().endsWith('/api/settings/mutate')) return false
          const request = response.request().postDataJSON() as {
            payload: { args: { ns: string; ops: { op: string; path: string[]; value?: unknown }[] } }
          }
          return request.payload.args.ns === NS && request.payload.args.ops.some(op =>
            op.op === 'set' && op.path[0] === 'process' && op.value === process)
        }),
        page.keyboard.press('ArrowRight'),
      ])
      await saved.finished()
      const selected = page.getByRole('radio', { name: new RegExp(name) })
      await expect.poll(() => selected.getAttribute('aria-checked')).toBe('true')
      await expect.poll(() => page.getByRole('button', { name: '进入应用', exact: true }).isEnabled()).toBe(true)
      expect(scaffold.ctx.settings.describe().find(row => row.ns === NS)?.value).toMatchObject({ process })
      expect(await selected.evaluate(element => document.activeElement === element)).toBe(true)
    }
    await page.getByRole('button', { name: '进入应用', exact: true }).waitFor()
    const processBorders = await page.getByRole('radio').evaluateAll(cards => cards.map(card => getComputedStyle(card, '::after').backgroundImage))
    expect(processBorders.every(border => border.startsWith('conic-gradient('))).toBe(true)
    expect(new Set(processBorders).size).toBe(3)
    await snapshot('process')
    await page.getByRole('button', { name: '进入应用', exact: true }).click()
    await page.locator('[data-desktop-onboarding]').waitFor({ state: 'detached' })
    expect(scaffold.ctx.settings.describe().find(row => row.ns === NS)?.value).toMatchObject({ step: 'done', process: 'detailed', usage: 'detailed', developerTools: true })
    expect(scaffold.ctx.settings.describe().find(row => row.ns === 'ui-chat')?.value).toMatchObject({ transcriptView: 'detailed', performanceUsage: 'detailed' })
    expect(scaffold.ctx.settings.describe().find(row => row.ns === 'ui-settings')?.value).toMatchObject({ enabled: true })
    const persisted = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
    expect(persisted).toContain('id: ui-settings-account')
    expect(persisted).toContain('process: detailed')
    expect(persisted).toContain('transcriptView: detailed')
    const warningsAfter = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningsAfter)
    await page.getByText('选择一个工作区开始', { exact: true }).waitFor()
    expect(await page.locator('[data-desktop-onboarding]').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    await page.close()
  })

  it('keeps funded credit actions stable and rechecks on reload in English dark mode', async () => {
    bonusBalance = '12.50'
    await scaffold.ctx.settings.mutate('ui-theme', [{ op: 'set', path: ['preference'], value: 'dark' }])
    page = await desktopPage('en-US')
    const response = page.waitForResponse('**/api/account/getBalance')
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await (await response).finished()
    await snapshot('welcome-en-dark')
    await page.getByRole('button', { name: 'Get started', exact: true }).click()
    await snapshot('credit-funded-en-dark')
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByRole('checkbox', { name: 'Office & creative work', exact: true }).waitFor()
    await snapshot('purpose-en-dark')
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await page.getByRole('button', { name: 'Continue', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await page.getByRole('button', { name: 'Get started', exact: true }).waitFor()
    expect(scaffold.ctx.settings.describe().find(row => row.ns === NS)?.value).not.toHaveProperty('creditFunded')
    bonusBalance = '0'
    const recheck = page.waitForResponse('**/api/account/getBalance')
    await page.reload({ waitUntil: 'load' })
    await (await recheck).finished()
    await page.getByRole('button', { name: 'Get started', exact: true }).click()
    await page.getByRole('heading', { name: 'Add credits', exact: true }).waitFor()
    expect(await page.getByRole('button', { name: 'Next', exact: true })
      .evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(72, 73, 76)')
    await snapshot('credit-en-dark')
    expect(await page.locator('[class*="backIcon"]').evaluate(element => getComputedStyle(element).maskImage)).toContain('data:image/svg+xml')
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await page.getByRole('button', { name: 'Got it', exact: true }).click()
    await page.getByRole('checkbox', { name: 'Coding & development', exact: true }).locator('..').click()
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByRole('radiogroup').waitFor()
    await snapshot('process-en-dark')
    await page.close()
  })

  it('applies API-key defaults without opening App onboarding or repeating after account login', async () => {
    await scaffold.ctx.credentials.deleteRecord(credentialKey('deepseek-account-platform', 'default'))
    await scaffold.ctx.credentials.set(credentialRef('DEEPSEEK_API_KEY'), 'fixture-api-key')
    await scaffold.ctx.settings.mutate(NS, Object.entries(INITIAL).map(([field, value]) => ({ op: 'set', path: [field], value })))
    page = await desktopPage()
    // Completion follows client activation, credential metadata, and three ordered Host writes.
    const completed = page.waitForResponse((response) => {
      if (!response.url().endsWith('/api/settings/mutate')) return false
      const request = response.request().postDataJSON() as { payload: { args: { ns: string } } }
      return request.payload.args.ns === NS
    })
    const [response] = await Promise.all([completed, page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })])
    await response.finished()
    expect(await response.json()).toMatchObject({ result: { ok: true } })
    expect((scaffold.ctx.settings.describe().find(row => row.ns === NS)?.value as { step: string }).step).toBe('done')
    expect(await page.locator('[data-desktop-onboarding]').count()).toBe(0)
    expect(scaffold.ctx.settings.describe().find(row => row.ns === NS)?.value).toMatchObject({ completion: 'api-key', process: 'standard', usage: 'detailed', developerTools: true })
    expect(scaffold.ctx.settings.describe().find(row => row.ns === 'ui-chat')?.value).toMatchObject({ transcriptView: 'standard', performanceUsage: 'detailed' })
    expect(scaffold.ctx.settings.describe().find(row => row.ns === 'ui-settings')?.value).toMatchObject({ enabled: true })
    await scaffold.ctx.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'default'), async () => ({
      kind: 'grant', payload: { version: 1, issuer: origin, token: 'onboarding-fixture-token' },
    }))
    await page.reload({ waitUntil: 'load' })
    await page.getByText('选择一个工作区开始', { exact: true }).waitFor()
    expect(await page.locator('[data-desktop-onboarding]').count()).toBe(0)
    await page.close()
  })
})
