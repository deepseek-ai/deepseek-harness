/** Real settings-to-phone QR and link login; only test browsers accept the fixture's self-signed TLS. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { launchRemoteConnectionFixture, type RemoteConnectionFixture } from './remote-connection-fixture.ts'
import { openSettings, ZH_BROWSER_LOCALE } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/remote-connection', import.meta.url))
const MODE = webSnapshotMode()
const MOBILE = { width: 390, height: 844 }
const REPLACEMENT_FIXTURE = fileURLToPath(new URL('./fixtures/plugins/fixture-remote-connection', import.meta.url))
const REPLACEMENT_OVERLAY = fileURLToPath(new URL('./remote-connection-replacement.overlay.yml', import.meta.url))

async function remoteSettings(page: Page): Promise<Locator> {
  await openSettings(page, 'zh')
  await page.getByRole('dialog', { name: '设置', exact: true })
    .getByRole('button', { name: '远程连接', exact: true }).click()
  const section = page.getByRole('region', { name: '远程连接', exact: true })
  await section.waitFor()
  const link = section.getByRole('region', { name: '链接登录', exact: true })
  await expect.poll(() => link.getByRole('button', { name: /^(复制链接|重试)$/ }).isEnabled()).toBe(true)
  return section
}

async function createCode(page: Page, section: Locator): Promise<string> {
  const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/remoteConnection/create')
  await section.getByRole('button', { name: /^(生成二维码|重新生成)$/ }).click()
  const response = await created
  expect(response.status()).toBe(200)
  const envelope = await response.json() as { result: { ok: boolean; value: { url: string } } }
  expect(envelope.result.ok).toBe(true)
  const url = envelope.result.value.url
  const parsed = new URL(url)
  expect(parsed.pathname).toBe('/')
  expect(parsed.search).toBe('?login=qr')
  expect(parsed.hash).toMatch(/^#[A-Za-z0-9_-]{43}$/)
  await section.getByRole('img', { name: '一次性登录二维码' }).waitFor()
  return url
}

async function snapshot(page: Page, fixture: RemoteConnectionFixture, name: string): Promise<void> {
  const aria = await captureStableAria(page, 'section[aria-label="远程连接"]', fixture.root, {
    replacements: [[fixture.authenticatedUrl, '{{access-address}}?token={{login-token}}'], [fixture.url, '{{access-address}}']],
  })
  await compareOrRefreshGolden(join(EXPECTED, `${name}.expected.md`), aria.replace(/\d+ 秒后过期/gu, '{{seconds}} 秒后过期'), MODE)
}

describe('web e2e: one-use QR browser login', () => {
  let browser: Browser
  let secure: RemoteConnectionFixture

  beforeAll(async () => {
    if (MODE === 'refresh') await mkdir(EXPECTED, { recursive: true })
    secure = await launchRemoteConnectionFixture(true)
    browser = await chromium.launch({
      // Content growth must exercise the width consumed by a real scrollbar.
      ignoreDefaultArgs: ['--hide-scrollbars'],
      // Browser contexts otherwise inherit the OS proxy; bypass all destinations without contacting this unused address.
      proxy: { server: 'http://127.0.0.1:9', bypass: '*' },
      args: ['--host-resolver-rules=MAP qr-login.test 127.0.0.1'],
    })
  })

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      await secure?.close()
    }
  })

  it('shows the Remote-owned anonymous page, rejects an invalid Token in place, and signs in with the independent Token URL', async () => {
    const phone = await browser.newContext({
      ignoreHTTPSErrors: true, locale: ZH_BROWSER_LOCALE, viewport: MOBILE, colorScheme: 'light',
    })
    try {
      const page = await phone.newPage()
      const console = watchConsole(page)
      const response = await page.goto(secure.url)
      expect(response?.status()).toBe(401)
      expect(response?.headers()['content-type']).toContain('text/html')
      expect(response?.headers()['cache-control']).toBe('no-store')
      const startupToken = new URL(secure.authenticatedUrl).searchParams.get('token')!
      const body = await response!.text()
      expect(body).not.toContain(startupToken)
      expect(body).not.toContain('__DSH_BOOT__')
      await page.getByRole('heading', { name: '连接到此 Host', exact: true }).waitFor()
      const input = page.getByLabel('登录令牌或链接', { exact: true })
      const submit = page.getByRole('button', { name: '继续', exact: true })
      await input.waitFor()
      expect(await page.getByRole('button', { name: '账号菜单', exact: true }).count()).toBe(0)
      expect(await page.evaluate(async () => {
        const reply = await fetch('./', { method: 'HEAD', credentials: 'same-origin', cache: 'no-store', redirect: 'manual' })
        return { status: reply.status, body: await reply.text() }
      })).toEqual({ status: 401, body: '' })
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(MOBILE.width)
      await input.focus()
      expect(await input.evaluate(element => document.activeElement === element)).toBe(true)
      await compareOrRefreshGolden(join(EXPECTED, 'anonymous-login.expected.md'),
        await captureStableAria(page, 'main', secure.root), MODE)
      const screenshots = process.env['DSH_REMOTE_CONNECTION_SCREENSHOTS']
      if (screenshots !== undefined) {
        await mkdir(screenshots, { recursive: true })
        await page.screenshot({ path: join(screenshots, 'anonymous-mobile-light.png') })
      }
      const lightBackground = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)
      await page.emulateMedia({ colorScheme: 'dark' })
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).not.toBe(lightBackground)
      if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'anonymous-mobile-dark.png') })

      const invalidToken = `${startupToken.startsWith('a') ? 'b' : 'a'}${startupToken.slice(1)}`
      const rejected = page.waitForResponse(reply => new URL(reply.url()).searchParams.get('token') === invalidToken)
      await input.fill(invalidToken)
      await submit.click()
      expect((await rejected).status()).toBe(401)
      await page.getByRole('alert').filter({ hasText: '此登录令牌无效或已过期，请粘贴新的令牌后重试' }).waitFor()
      expect(page.url()).toBe(secure.url)
      expect(await input.getAttribute('aria-invalid')).toBe('true')
      expect(await submit.isEnabled()).toBe(true)
      expect(await phone.cookies()).toEqual([])
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(MOBILE.width)
      await compareOrRefreshGolden(join(EXPECTED, 'anonymous-rejected.expected.md'),
        await captureStableAria(page, 'main', secure.root, { replacements: [[invalidToken, '{{invalid-token}}']] }), MODE)
      if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'anonymous-token-rejected-dark.png') })

      await input.fill(secure.authenticatedUrl)
      await submit.click()
      await page.getByRole('button', { name: '账号菜单', exact: true, includeHidden: true }).waitFor({ state: 'attached' })
      expect(page.url()).toBe(secure.url)
      expect((await phone.cookies()).filter(cookie => cookie.name.startsWith('dsh-auth-'))).toHaveLength(1)
      expect((await phone.cookies()).filter(cookie => cookie.name.startsWith('dsh-remote-'))).toEqual([])
      expect(await page.evaluate(async () => {
        const reply = await fetch('./', { method: 'HEAD', credentials: 'same-origin', cache: 'no-store', redirect: 'manual' })
        return { status: reply.status, body: await reply.text() }
      })).toEqual({ status: 200, body: '' })
      await page.reload()
      await page.getByRole('button', { name: '账号菜单', exact: true, includeHidden: true }).waitFor({ state: 'attached' })
      expect(console.pageErrors).toEqual([])
    } finally {
      await phone.close()
    }
  })

  it('retries in the copy button, shows a fading tokenized link, and keeps credential warnings independent', async () => {
    const desktop = await browser.newContext({
      ignoreHTTPSErrors: true, locale: ZH_BROWSER_LOCALE, viewport: { width: 1200, height: 1000 },
      permissions: ['clipboard-read', 'clipboard-write'], colorScheme: 'light',
    })
    const phone = await browser.newContext({ ignoreHTTPSErrors: true, locale: ZH_BROWSER_LOCALE, viewport: MOBILE })
    try {
      const page = await desktop.newPage()
      const console = watchConsole(page)
      let rejectLinkRead = true
      await page.route('**/api/remoteConnection/loginUrl', (route) => {
        if (!rejectLinkRead) return route.continue()
        const request = route.request().postDataJSON() as { rpcId: string }
        return route.fulfill({ json: {
          type: 'server-response', rpcId: request.rpcId,
          result: { ok: false, error: { code: 'gateway/internal', message: 'Fixture unavailable', details: {} } },
        } })
      })
      await page.goto(secure.authenticatedUrl)
      const section = await remoteSettings(page)
      const qrSection = section.getByRole('region', { name: '二维码登录', exact: true })
      const linkSection = section.getByRole('region', { name: '链接登录', exact: true })
      expect(await qrSection.count()).toBe(1)
      expect(await linkSection.count()).toBe(1)
      for (const card of [qrSection, linkSection]) {
        expect(await card.getByRole('button').first().evaluate(element => getComputedStyle(element).fontSize)).toBe('12px')
        expect(await card.evaluate(element => Number.parseFloat(getComputedStyle(element).borderLeftWidth))).toBeGreaterThan(0)
        const cardBox = await card.boundingBox()
        const titleBox = await card.getByRole('heading', { level: 3 }).boundingBox()
        expect(cardBox).not.toBeNull()
        expect(titleBox).not.toBeNull()
        expect(titleBox!.x).toBeGreaterThan(cardBox!.x)
        expect(titleBox!.y).toBeGreaterThan(cardBox!.y)
        expect(titleBox!.x + titleBox!.width).toBeLessThan(cardBox!.x + cardBox!.width)
      }
      expect(await qrSection.locator('code').count()).toBe(0)
      expect(await linkSection.getByRole('button').count()).toBe(1)
      await linkSection.getByText('无法获取登录链接，请重试', { exact: true }).waitFor()
      await snapshot(page, secure, 'link-failed')
      rejectLinkRead = false
      await linkSection.getByRole('button', { name: '重试', exact: true }).click()
      await expect.poll(() => linkSection.getByRole('button', { name: '复制链接', exact: true }).isEnabled()).toBe(true)
      expect(await linkSection.getByRole('button').count()).toBe(1)
      const desktopLinkField = await linkSection.locator('code').locator('..').boundingBox()
      const desktopCopy = await linkSection.getByRole('button', { name: '复制链接', exact: true }).boundingBox()
      expect(desktopLinkField).not.toBeNull()
      expect(desktopCopy).not.toBeNull()
      expect(desktopLinkField!.height).toBe(desktopCopy!.height)
      expect(Math.abs(desktopLinkField!.y - desktopCopy!.y)).toBeLessThanOrEqual(1)
      expect(await section.getByText('请勿分享登录二维码', { exact: true }).count()).toBe(0)
      expect(await section.getByText('请勿公开分享登录链接', { exact: true }).count()).toBe(0)
      await snapshot(page, secure, 'link-ready')
      await linkSection.getByRole('button', { name: '复制链接', exact: true }).click()
      await page.getByText('链接已复制', { exact: true }).waitFor()
      const copiedUrl = await page.evaluate(() => navigator.clipboard.readText())
      expect(copiedUrl).toBe(secure.authenticatedUrl)
      const token = new URL(copiedUrl).searchParams.get('token')!
      expect(token).not.toBe('')
      expect(await linkSection.locator('code').textContent()).toBe(copiedUrl)
      expect(await linkSection.locator('code').evaluate(element => getComputedStyle(element).maskImage)).not.toBe('none')
      await linkSection.getByText('请勿公开分享登录链接', { exact: true }).waitFor()
      expect(await qrSection.getByText('请勿分享登录二维码', { exact: true }).count()).toBe(0)
      await snapshot(page, secure, 'link-copied')
      const screenshots = process.env['DSH_REMOTE_CONNECTION_SCREENSHOTS']
      if (screenshots !== undefined) {
        await mkdir(screenshots, { recursive: true })
        await page.getByText('链接已复制', { exact: true }).waitFor({ state: 'hidden' })
        await page.screenshot({ path: join(screenshots, 'link-desktop-light.png') })
      }

      const phonePage = await phone.newPage()
      await phonePage.goto(copiedUrl)
      await phonePage.getByRole('button', { name: '账号菜单', exact: true, includeHidden: true }).waitFor({ state: 'attached' })
      expect(phonePage.url()).toBe(secure.url)
      expect((await phone.cookies()).filter(cookie => cookie.name.startsWith('dsh-auth-'))).toHaveLength(1)
      await phonePage.reload()
      await phonePage.getByRole('button', { name: '账号菜单', exact: true, includeHidden: true }).waitFor({ state: 'attached' })

      await page.setViewportSize(MOBILE)
      await snapshot(page, secure, 'link-mobile-light')
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(MOBILE.width)
      const copyBox = await linkSection.getByRole('button', { name: '已复制', exact: true }).boundingBox()
      expect(copyBox).not.toBeNull()
      expect(copyBox!.x).toBeGreaterThanOrEqual(0)
      expect(copyBox!.x + copyBox!.width).toBeLessThanOrEqual(MOBILE.width)
      const mobileLinkField = await linkSection.locator('code').locator('..').boundingBox()
      expect(mobileLinkField).not.toBeNull()
      expect(mobileLinkField!.height).toBe(copyBox!.height)
      expect(mobileLinkField!.y + mobileLinkField!.height).toBeLessThan(copyBox!.y)
      if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'link-mobile-light.png') })
      await page.emulateMedia({ colorScheme: 'dark' })
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark')
      await snapshot(page, secure, 'link-mobile-dark')
      if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'link-mobile-dark.png') })
      await page.setViewportSize({ width: 1200, height: 1000 })
      await page.emulateMedia({ colorScheme: 'light' })
      await createCode(page, section)
      await qrSection.getByText('请勿分享登录二维码', { exact: true }).waitFor()
      await linkSection.getByText('请勿公开分享登录链接', { exact: true }).waitFor()
      await snapshot(page, secure, 'both-active')
      if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'both-desktop-light.png') })
      await linkSection.getByRole('button', { name: '已复制', exact: true }).click()
      await page.getByText('链接已复制', { exact: true }).waitFor()
      await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
      expect(await page.getByRole('dialog', { name: '设置', exact: true }).count()).toBe(0)
      expect(await page.getByText('链接已复制', { exact: true }).count()).toBe(1)
      expect(console.pageErrors).toEqual([])
    } finally {
      await Promise.all([desktop.close(), phone.close()])
    }
  })

  it.each([true, false])('keeps QR and link rows horizontal when copying adds a scrollbar to a short panel (TLS: %s)', async (tls) => {
    const fixture = tls ? secure : await launchRemoteConnectionFixture(false)
    if (!tls) onTestFinished(() => fixture.close())
    const desktop = await browser.newContext({
      ignoreHTTPSErrors: true, locale: ZH_BROWSER_LOCALE, viewport: { width: 1200, height: 800 },
      permissions: ['clipboard-read', 'clipboard-write'], colorScheme: 'light',
    })
    try {
      const page = await desktop.newPage()
      await page.goto(fixture.authenticatedUrl)
      const section = await remoteSettings(page)
      await createCode(page, section)
      const qr = section.getByRole('region', { name: '二维码登录', exact: true })
      const link = section.getByRole('region', { name: '链接登录', exact: true })
      const copy = link.getByRole('button', { name: '复制链接', exact: true })
      const beforeSection = await section.boundingBox()
      const beforeQr = await qr.boundingBox()
      const beforeField = await link.locator('code').locator('..').boundingBox()
      const beforeCopy = await copy.boundingBox()
      const scrollport = page.getByRole('dialog', { name: '设置', exact: true }).locator('[data-slot="settings.section"]').locator('..')
      const beforeGutter = await scrollport.evaluate(element => element.getBoundingClientRect().width - element.clientWidth)
      const screenshots = process.env['DSH_REMOTE_CONNECTION_SCREENSHOTS']
      if (screenshots !== undefined) {
        await mkdir(screenshots, { recursive: true })
        await page.screenshot({ path: join(screenshots, 'copy-short-panel-before.png') })
      }
      await copy.click()
      await link.getByText('请勿公开分享登录链接', { exact: true }).waitFor()
      await page.getByText('链接已复制', { exact: true }).waitFor()
      if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'copy-short-panel-after.png') })
      expect(beforeSection).not.toBeNull()
      expect(beforeQr).not.toBeNull()
      expect(beforeField).not.toBeNull()
      expect(beforeCopy).not.toBeNull()
      const gutterChange = await scrollport.evaluate(element => element.getBoundingClientRect().width - element.clientWidth) - beforeGutter
      expect((await section.boundingBox())!.width).toBe(beforeSection!.width - gutterChange)
      expect(await qr.boundingBox()).toEqual({ ...beforeQr!, width: beforeQr!.width - gutterChange })
      expect(await link.locator('code').locator('..').boundingBox()).toEqual({ ...beforeField!, width: beforeField!.width - gutterChange })
      expect(await link.getByRole('button', { name: '已复制', exact: true }).boundingBox()).toEqual({ ...beforeCopy!, x: beforeCopy!.x - gutterChange })
      expect(await qr.getByRole('img').count()).toBe(1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1200)
    } finally {
      await desktop.close()
    }
  })

  it('signs in a separate phone browser once, preserves its login, and reports use without desktop approval', async () => {
    const desktop = await browser.newContext({ ignoreHTTPSErrors: true, locale: ZH_BROWSER_LOCALE })
    const phone = await browser.newContext({ ignoreHTTPSErrors: true, locale: ZH_BROWSER_LOCALE, viewport: MOBILE, colorScheme: 'light' })
    const stranger = await browser.newContext({ ignoreHTTPSErrors: true, locale: ZH_BROWSER_LOCALE, viewport: MOBILE })
    try {
      const desktopPage = await desktop.newPage()
      await desktopPage.goto(secure.authenticatedUrl)
      const desktopSection = await remoteSettings(desktopPage)
      const qrUrl = await createCode(desktopPage, desktopSection)
      expect(new URL(qrUrl).origin).toBe(new URL(secure.url).origin)
      const desktopCode = await desktopSection.getByRole('img', { name: '一次性登录二维码' }).boundingBox()
      const desktopAction = await desktopSection.getByRole('button', { name: '重新生成', exact: true }).boundingBox()
      const desktopTitle = await desktopSection.getByRole('heading', { name: '二维码登录', exact: true }).boundingBox()
      expect(desktopCode).not.toBeNull()
      expect(desktopAction).not.toBeNull()
      expect(desktopTitle).not.toBeNull()
      expect(desktopAction!.x).toBeGreaterThan(desktopTitle!.x + desktopTitle!.width)
      expect(desktopAction!.y + desktopAction!.height).toBeLessThan(desktopCode!.y)
      expect(Math.abs(desktopTitle!.y + desktopTitle!.height / 2 - desktopAction!.y - desktopAction!.height / 2)).toBeLessThanOrEqual(1)
      const desktopScan = await desktopSection.getByText('扫码后直接登录', { exact: true }).boundingBox()
      const desktopTimer = await desktopSection.getByRole('timer').boundingBox()
      const desktopWarning = await desktopSection.getByText('请勿分享登录二维码', { exact: true }).boundingBox()
      const desktopDetails = await desktopSection.getByRole('timer').locator('..').boundingBox()
      const desktopBanner = await desktopSection.getByText('请勿分享登录二维码', { exact: true }).locator('..').locator('..').boundingBox()
      expect(desktopScan).not.toBeNull()
      expect(desktopTimer).not.toBeNull()
      expect(desktopWarning).not.toBeNull()
      expect(desktopDetails).not.toBeNull()
      expect(desktopBanner).not.toBeNull()
      expect(desktopDetails!.x).toBe(desktopBanner!.x)
      expect(desktopDetails!.width).toBe(desktopBanner!.width)
      expect(Math.abs(desktopScan!.y - desktopTimer!.y)).toBeLessThanOrEqual(1)
      expect(desktopTimer!.y).toBeGreaterThan(desktopCode!.y + desktopCode!.height)
      expect(desktopWarning!.y).toBeGreaterThan(desktopTimer!.y + desktopTimer!.height)

      const phonePage = await phone.newPage()
      const pageErrors: string[] = []
      phonePage.on('pageerror', (error) => { pageErrors.push(error.message) })
      const exchanged = phonePage.waitForResponse(response => new URL(response.url()).pathname === '/' && new URL(response.url()).search === '?login=qr'
        && response.request().method() === 'POST')
      await phonePage.goto(qrUrl)
      expect((await exchanged).status()).toBe(204)
      await phonePage.getByRole('button', { name: '账号菜单', exact: true, includeHidden: true }).waitFor({ state: 'attached' })
      expect(phonePage.url()).toBe(secure.url)
      expect((await phone.cookies()).filter(cookie => cookie.name.startsWith('dsh-remote-'))).toEqual([
        expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'Strict', domain: 'qr-login.test' }),
      ])
      expect((await phone.cookies()).filter(cookie => cookie.name.startsWith('dsh-auth-'))).toEqual([])
      expect(await phonePage.evaluate(async () => (await fetch('./', {
        method: 'HEAD', credentials: 'same-origin', cache: 'no-store', redirect: 'manual',
      })).status)).toBe(200)
      await phonePage.reload()
      await phonePage.getByRole('button', { name: '账号菜单', exact: true, includeHidden: true }).waitFor({ state: 'attached' })
      await desktopSection.getByText('二维码已使用，请在手机上确认是否已登录', { exact: true }).waitFor()
      expect(await desktopSection.getByRole('img').count()).toBe(0)
      await snapshot(desktopPage, secure, 'used')
      await desktopPage.close()

      await phonePage.close()
      const returning = await phone.newPage()
      await returning.goto(secure.url)
      await returning.getByRole('button', { name: '账号菜单', exact: true, includeHidden: true }).waitFor({ state: 'attached' })
      expect(returning.url()).toBe(secure.url)
      const mobileSection = await remoteSettings(returning)
      await mobileSection.getByRole('button', { name: '生成二维码', exact: true }).waitFor()
      await createCode(returning, mobileSection)
      await snapshot(returning, secure, 'mobile-light')
      expect(await returning.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(MOBILE.width)
      const box = await mobileSection.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(MOBILE.width)
      const qrBox = await mobileSection.getByRole('img', { name: '一次性登录二维码' }).boundingBox()
      expect(qrBox).not.toBeNull()
      expect(qrBox!.x).toBeGreaterThanOrEqual(0)
      expect(qrBox!.x + qrBox!.width).toBeLessThanOrEqual(MOBILE.width)
      const mobileAction = await mobileSection.getByRole('button', { name: '重新生成', exact: true }).boundingBox()
      const mobileTitle = await mobileSection.getByRole('heading', { name: '二维码登录', exact: true }).boundingBox()
      expect(mobileAction).not.toBeNull()
      expect(mobileTitle).not.toBeNull()
      expect(mobileAction!.y).toBeGreaterThan(mobileTitle!.y + mobileTitle!.height)
      expect(mobileAction!.x).toBe(mobileTitle!.x)
      expect(mobileAction!.width).toBe(mobileTitle!.width)
      expect(mobileAction!.y + mobileAction!.height).toBeLessThan(qrBox!.y)
      const mobileCancel = await mobileSection.getByRole('button', { name: '取消', exact: true }).boundingBox()
      expect(mobileCancel).not.toBeNull()
      expect(mobileCancel!.y).toBeGreaterThan(mobileAction!.y + mobileAction!.height)
      expect(mobileCancel!.x).toBe(mobileAction!.x)
      expect(mobileCancel!.width).toBe(mobileAction!.width)
      const mobileScan = await mobileSection.getByText('扫码后直接登录', { exact: true }).boundingBox()
      const mobileTimer = await mobileSection.getByRole('timer').boundingBox()
      const mobileWarning = await mobileSection.getByText('请勿分享登录二维码', { exact: true }).boundingBox()
      const mobileDetails = await mobileSection.getByRole('timer').locator('..').boundingBox()
      const mobileBanner = await mobileSection.getByText('请勿分享登录二维码', { exact: true }).locator('..').locator('..').boundingBox()
      expect(mobileScan).not.toBeNull()
      expect(mobileTimer).not.toBeNull()
      expect(mobileWarning).not.toBeNull()
      expect(mobileDetails).not.toBeNull()
      expect(mobileBanner).not.toBeNull()
      expect(mobileDetails!.x).toBe(mobileBanner!.x)
      expect(mobileDetails!.width).toBe(mobileBanner!.width)
      expect(Math.abs(mobileScan!.y - mobileTimer!.y)).toBeLessThanOrEqual(1)
      expect(mobileTimer!.y).toBeGreaterThan(qrBox!.y + qrBox!.height)
      expect(mobileWarning!.y).toBeGreaterThan(mobileTimer!.y + mobileTimer!.height)
      const screenshots = process.env['DSH_REMOTE_CONNECTION_SCREENSHOTS']
      if (screenshots !== undefined) {
        await mkdir(screenshots, { recursive: true })
        await returning.screenshot({ path: join(screenshots, 'qr-mobile-light.png') })
      }
      await returning.emulateMedia({ colorScheme: 'dark' })
      await expect.poll(() => returning.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark')
      await snapshot(returning, secure, 'mobile-dark')
      if (screenshots !== undefined) await returning.screenshot({ path: join(screenshots, 'qr-mobile-dark.png') })
      await mobileSection.getByRole('button', { name: '取消', exact: true }).click()
      await mobileSection.getByRole('button', { name: '取消', exact: true }).waitFor({ state: 'detached' })
      expect(await mobileSection.getByRole('status').count()).toBe(0)
      expect(await mobileSection.getByRole('img').count()).toBe(0)

      const reusedPage = await stranger.newPage()
      const refused = reusedPage.waitForResponse(response => new URL(response.url()).pathname === '/' && new URL(response.url()).search === '?login=qr'
        && response.request().method() === 'POST')
      await reusedPage.goto(qrUrl)
      expect((await refused).status()).toBe(410)
      await expect.poll(() => new URL(reusedPage.url()).hash).toBe('')
      expect((await stranger.cookies()).filter(cookie => cookie.name.startsWith('dsh-remote-'))).toEqual([])
      expect(await reusedPage.getByRole('button', { name: '账号菜单', exact: true }).count()).toBe(0)
      expect(pageErrors).toEqual([])
    } finally {
      await Promise.all([desktop.close(), phone.close(), stranger.close()])
    }
  })

  it('redeems a QR invitation at the root when the phone already has a Token login', async () => {
    const desktop = await browser.newContext({ ignoreHTTPSErrors: true, locale: ZH_BROWSER_LOCALE })
    const phone = await browser.newContext({ ignoreHTTPSErrors: true, locale: ZH_BROWSER_LOCALE, viewport: MOBILE })
    try {
      const owner = await desktop.newPage()
      await owner.goto(secure.authenticatedUrl)
      const settings = await remoteSettings(owner)
      const qrUrl = await createCode(owner, settings)
      const page = await phone.newPage()
      await page.goto(secure.authenticatedUrl)
      await page.getByRole('button', { name: '账号菜单', exact: true, includeHidden: true }).waitFor({ state: 'attached' })
      expect((await phone.cookies()).some(cookie => cookie.name.startsWith('dsh-auth-'))).toBe(true)
      expect((await phone.cookies()).some(cookie => cookie.name.startsWith('dsh-remote-'))).toBe(false)
      const exchanged = page.waitForResponse(response => new URL(response.url()).pathname === '/' && new URL(response.url()).search === '?login=qr'
        && response.request().method() === 'POST')
      await page.goto(qrUrl)
      expect((await exchanged).status()).toBe(204)
      await page.getByRole('button', { name: '账号菜单', exact: true, includeHidden: true }).waitFor({ state: 'attached' })
      expect(page.url()).toBe(secure.url)
      expect((await phone.cookies()).some(cookie => cookie.name.startsWith('dsh-remote-'))).toBe(true)
      await settings.getByText('二维码已使用，请在手机上确认是否已登录', { exact: true }).waitFor()
    } finally {
      await Promise.all([desktop.close(), phone.close()])
    }
  })

  it('keeps both cards in place while regenerating a QR with a local spinner', async () => {
    for (const viewport of [{ width: 1200, height: 1000 }, MOBILE]) {
      const desktop = await browser.newContext({ ignoreHTTPSErrors: true, locale: ZH_BROWSER_LOCALE, viewport })
      try {
        const page = await desktop.newPage()
        await page.goto(secure.authenticatedUrl)
        const section = await remoteSettings(page)
        await createCode(page, section)
        const qr = section.getByRole('region', { name: '二维码登录', exact: true })
        const link = section.getByRole('region', { name: '链接登录', exact: true })
        const qrBox = await qr.boundingBox()
        const linkBox = await link.boundingBox()
        const symbol = await qr.getByRole('img').boundingBox()
        const firstSvg = await qr.getByRole('img').innerHTML()
        expect(symbol).not.toBeNull()
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        await page.route('**/api/remoteConnection/create', async (route) => {
          await gate
          await route.continue()
        })
        const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/remoteConnection/create')
        try {
          await qr.getByRole('button', { name: '重新生成', exact: true }).click()
          const loading = qr.getByRole('status', { name: '正在生成登录二维码', exact: true })
          await loading.waitFor()
          expect(await qr.getByRole('img').count()).toBe(0)
          expect(await qr.getByRole('timer').isVisible()).toBe(true)
          expect(await qr.getByText('请勿分享登录二维码', { exact: true }).isVisible()).toBe(true)
          expect(await qr.boundingBox()).toEqual(qrBox)
          expect(await link.boundingBox()).toEqual(linkBox)
          expect(await link.getByRole('button', { name: '复制链接', exact: true }).isEnabled()).toBe(true)
          const spinner = await loading.boundingBox()
          expect(spinner).not.toBeNull()
          expect(Math.abs(spinner!.x + spinner!.width / 2 - symbol!.x - symbol!.width / 2)).toBeLessThanOrEqual(1)
          expect(Math.abs(spinner!.y + spinner!.height / 2 - symbol!.y - symbol!.height / 2)).toBeLessThanOrEqual(1)
          if (viewport.width !== MOBILE.width) await snapshot(page, secure, 'regenerating')
          const screenshots = process.env['DSH_REMOTE_CONNECTION_SCREENSHOTS']
          if (screenshots !== undefined) {
            await mkdir(screenshots, { recursive: true })
            await page.screenshot({ path: join(screenshots, viewport.width === MOBILE.width ? 'qr-generating-mobile.png' : 'qr-generating-desktop.png') })
          }
        } finally {
          release()
          await created
        }
        await qr.getByRole('img').waitFor()
        expect(await qr.getByRole('img').innerHTML()).not.toBe(firstSvg)
        expect(await qr.boundingBox()).toEqual(qrBox)
        expect(await link.boundingBox()).toEqual(linkBox)
      } finally {
        await desktop.close()
      }
    }
  })

  it('places the expiry banner below the QR controls at full width and allows regeneration', async () => {
    const fixture = await launchRemoteConnectionFixture(false, 5000)
    onTestFinished(() => fixture.close())
    const desktop = await browser.newContext({
      locale: ZH_BROWSER_LOCALE, viewport: { width: 1200, height: 1000 }, colorScheme: 'light',
    })
    try {
      const page = await desktop.newPage()
      await page.goto(fixture.authenticatedUrl)
      const section = await remoteSettings(page)
      const first = await createCode(page, section)
      const qr = section.getByRole('region', { name: '二维码登录', exact: true })
      const notice = qr.getByRole('status')
      await notice.getByText('二维码已过期，请生成新二维码登录', { exact: true }).waitFor()
      expect(await notice.evaluate(element => Number.parseFloat(getComputedStyle(element).borderLeftWidth))).toBeGreaterThan(0)
      expect(await qr.getByRole('img').count()).toBe(0)
      expect(await qr.getByRole('timer').count()).toBe(0)
      expect(await qr.getByRole('button', { name: '重新生成', exact: true }).isEnabled()).toBe(true)
      const header = await qr.getByRole('heading', { name: '二维码登录', exact: true }).locator('..').boundingBox()
      const desktopNotice = await notice.boundingBox()
      expect(header).not.toBeNull()
      expect(desktopNotice).not.toBeNull()
      expect(desktopNotice!.y).toBeGreaterThan(header!.y + header!.height)
      expect(desktopNotice!.x).toBe(header!.x)
      expect(desktopNotice!.width).toBe(header!.width)
      await snapshot(page, fixture, 'expired')
      const screenshots = process.env['DSH_REMOTE_CONNECTION_SCREENSHOTS']
      if (screenshots !== undefined) {
        await mkdir(screenshots, { recursive: true })
        await page.screenshot({ path: join(screenshots, 'expired-desktop-light.png') })
      }
      await page.emulateMedia({ colorScheme: 'dark' })
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark')
      if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'expired-desktop-dark.png') })
      await page.setViewportSize(MOBILE)
      const mobileTitle = await qr.getByRole('heading', { name: '二维码登录', exact: true }).boundingBox()
      const mobileNotice = await notice.boundingBox()
      const mobileAction = await qr.getByRole('button', { name: '重新生成', exact: true }).boundingBox()
      expect(mobileTitle).not.toBeNull()
      expect(mobileNotice).not.toBeNull()
      expect(mobileAction).not.toBeNull()
      expect(mobileAction!.y).toBeGreaterThan(mobileTitle!.y + mobileTitle!.height)
      expect(mobileNotice!.y).toBeGreaterThan(mobileAction!.y + mobileAction!.height)
      expect(mobileAction!.x).toBe(mobileTitle!.x)
      expect(mobileAction!.width).toBe(mobileTitle!.width)
      expect(mobileNotice!.x).toBe(mobileAction!.x)
      expect(mobileNotice!.width).toBe(mobileAction!.width)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(MOBILE.width)
      await snapshot(page, fixture, 'expired-mobile-dark')
      if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'expired-mobile-dark.png') })
      expect(await createCode(page, section)).not.toBe(first)
      expect(await qr.getByText('二维码已过期，请生成新二维码登录', { exact: true }).count()).toBe(0)
    } finally {
      await desktop.close()
    }
  })

  it('cancels an unused code without logging out an existing browser', async () => {
    const desktop = await browser.newContext({ ignoreHTTPSErrors: true, locale: ZH_BROWSER_LOCALE })
    const phone = await browser.newContext({ ignoreHTTPSErrors: true, locale: ZH_BROWSER_LOCALE })
    try {
      const page = await desktop.newPage()
      await page.goto(secure.authenticatedUrl)
      const section = await remoteSettings(page)
      const qrUrl = await createCode(page, section)
      await section.getByRole('button', { name: '取消', exact: true }).click()
      await section.getByRole('button', { name: '取消', exact: true }).waitFor({ state: 'detached' })
      expect(await section.getByRole('status').count()).toBe(0)
      expect(await section.getByRole('img').count()).toBe(0)
      await snapshot(page, secure, 'cancelled')
      const other = await phone.newPage()
      const refused = other.waitForResponse(response => new URL(response.url()).pathname === '/' && new URL(response.url()).search === '?login=qr'
        && response.request().method() === 'POST')
      await other.goto(qrUrl)
      expect((await refused).status()).toBe(410)
      expect((await phone.cookies()).filter(cookie => cookie.name.startsWith('dsh-remote-'))).toEqual([])
      await page.reload()
      await page.getByRole('button', { name: '账号菜单', exact: true, includeHidden: true }).waitFor({ state: 'attached' })
    } finally {
      await Promise.all([desktop.close(), phone.close()])
    }
  })

  it('replaces only the panel content while sharing the invitation and restores the default when unloaded', async () => {
    const scaffold = await launchWebScaffold({
      remoteAuthority: 'qr-login.test', extraOverlayPath: REPLACEMENT_OVERLAY,
      extraInstallAnchors: [join(REPLACEMENT_FIXTURE, 'package.json')],
    })
    onTestFinished(() => scaffold.close())
    const desktop = await browser.newContext({ locale: ZH_BROWSER_LOCALE })
    try {
      const page = await desktop.newPage()
      const console = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl)
      const section = await remoteSettings(page)
      const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/remoteConnection/create')
      await createCode(page, section)
      const initial = await (await created).json() as { result: { value: { id: string } } }
      const invitationId = initial.result.value.id
      const svg = section.getByRole('img', { name: '一次性登录二维码' })
      const initialSvg = await svg.innerHTML()
      const nav = page.getByRole('dialog', { name: '设置', exact: true })
        .getByRole('button', { name: '远程连接', exact: true })
      const custom = page.getByRole('region', { name: '自定义远程连接', exact: true })

      const replacement = await scaffold.ctx.loader.create({ name: '@fixture/remote-connection' })
      await custom.waitFor()
      expect(await nav.count()).toBe(1)
      expect(await section.count()).toBe(0)
      expect(await custom.getByRole('status', { name: '邀请编号' }).textContent()).toBe(invitationId)
      await custom.getByText('邀请状态: pending', { exact: true }).waitFor()
      await compareOrRefreshGolden(join(EXPECTED, 'replacement.expected.md'),
        await captureStableAria(page, 'section[aria-label="自定义远程连接"]', scaffold.workspaceCwd, {
          replacements: [[`${scaffold.baseUrl}/`, '{{access-address}}'], [invitationId, '{{invitation-id}}']],
        }), MODE)

      await custom.getByRole('button', { name: '重新读取', exact: true }).click()
      await custom.getByText('邀请状态: pending', { exact: true }).waitFor()
      expect(await custom.getByRole('status', { name: '邀请编号' }).textContent()).toBe(invitationId)
      scaffold.ctx.loader.remove(replacement)
      await svg.waitFor()
      expect(await nav.count()).toBe(1)
      expect(await custom.count()).toBe(0)
      expect(await svg.innerHTML()).toBe(initialSvg)

      const nextReplacement = await scaffold.ctx.loader.create({ name: '@fixture/remote-connection' })
      await custom.waitFor()
      await custom.getByRole('button', { name: '取消邀请', exact: true }).click()
      await custom.getByText('邀请状态: cancelled', { exact: true }).waitFor()
      expect(await custom.getByRole('status', { name: '邀请编号' }).textContent()).toBe('')
      const recreated = page.waitForResponse(response => new URL(response.url()).pathname === '/api/remoteConnection/create')
      await custom.getByRole('button', { name: '生成新邀请', exact: true }).click()
      const response = await recreated
      expect(response.status()).toBe(200)
      const next = await response.json() as { result: { ok: boolean; value: { id: string } } }
      expect(next.result.ok).toBe(true)
      expect(next.result.value.id).not.toBe(invitationId)
      await expect.poll(() => custom.getByRole('status', { name: '邀请编号' }).textContent()).toBe(next.result.value.id)
      await custom.getByRole('button', { name: '关闭设置', exact: true }).click()
      expect(await page.getByRole('dialog', { name: '设置', exact: true }).count()).toBe(0)
      scaffold.ctx.loader.remove(nextReplacement)
      expect(console.pageErrors).toEqual([])
    } finally {
      await desktop.close()
    }
  })

  it('signs in over HTTP and preserves the phone login after the desktop closes without allowing code reuse', async () => {
    const fixture = await launchRemoteConnectionFixture(false)
    const desktop = await browser.newContext({ locale: ZH_BROWSER_LOCALE })
    const phone = await browser.newContext({ locale: ZH_BROWSER_LOCALE, viewport: MOBILE })
    const stranger = await browser.newContext({ locale: ZH_BROWSER_LOCALE, viewport: MOBILE })
    try {
      const desktopPage = await desktop.newPage()
      await desktopPage.goto(fixture.authenticatedUrl)
      const section = await remoteSettings(desktopPage)
      await section.getByRole('button', { name: '生成二维码', exact: true }).waitFor()
      await snapshot(desktopPage, fixture, 'http-ready')
      const qrUrl = await createCode(desktopPage, section)
      expect(new URL(qrUrl).protocol).toBe('http:')
      expect(new URL(qrUrl).origin).toBe(new URL(fixture.url).origin)
      await snapshot(desktopPage, fixture, 'http-active')
      expect(await desktopPage.evaluate(() => window.isSecureContext)).toBe(false)
      await section.getByRole('button', { name: '复制链接', exact: true }).click()
      await desktopPage.getByText('链接已复制', { exact: true }).waitFor()
      await section.getByText('请勿公开分享登录链接', { exact: true }).waitFor()
      expect(await section.getByText('HTTP 会明文传输登录凭据，请仅在可信网络中使用', { exact: true }).count()).toBe(2)
      expect(await section.getByRole('img', { name: '一次性登录二维码' }).count()).toBe(1)
      await snapshot(desktopPage, fixture, 'http-link-copied')

      const phonePage = await phone.newPage()
      const exchanged = phonePage.waitForResponse(response => new URL(response.url()).pathname === '/' && new URL(response.url()).search === '?login=qr'
        && response.request().method() === 'POST')
      await phonePage.goto(qrUrl)
      expect((await exchanged).status()).toBe(204)
      await phonePage.getByRole('button', { name: '账号菜单', exact: true, includeHidden: true }).waitFor({ state: 'attached' })
      expect(phonePage.url()).toBe(fixture.url)
      expect((await phone.cookies()).filter(cookie => cookie.name.startsWith('dsh-remote-'))).toEqual([
        expect.objectContaining({ httpOnly: true, secure: false, sameSite: 'Strict', domain: 'qr-login.test' }),
      ])
      expect((await phone.cookies()).filter(cookie => cookie.name.startsWith('dsh-auth-'))).toEqual([])
      expect(await phonePage.evaluate(async () => (await fetch('./', {
        method: 'HEAD', credentials: 'same-origin', cache: 'no-store', redirect: 'manual',
      })).status)).toBe(200)
      await desktop.close()

      await phonePage.close()
      const returning = await phone.newPage()
      await returning.goto(fixture.url)
      await returning.getByRole('button', { name: '账号菜单', exact: true, includeHidden: true }).waitFor({ state: 'attached' })
      expect(returning.url()).toBe(fixture.url)

      const reusedPage = await stranger.newPage()
      const refused = reusedPage.waitForResponse(response => new URL(response.url()).pathname === '/' && new URL(response.url()).search === '?login=qr'
        && response.request().method() === 'POST')
      await reusedPage.goto(qrUrl)
      expect((await refused).status()).toBe(410)
      await expect.poll(() => new URL(reusedPage.url()).hash).toBe('')
      expect((await stranger.cookies()).filter(cookie => cookie.name.startsWith('dsh-remote-'))).toEqual([])
      expect(await reusedPage.getByRole('button', { name: '账号菜单', exact: true }).count()).toBe(0)
    } finally {
      try {
        await Promise.all([desktop.close(), phone.close(), stranger.close()])
      } finally {
        await fixture.close()
      }
    }
  })
})
