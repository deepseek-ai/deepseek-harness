/** Real settings-to-phone QR and link login; only test browsers accept the fixture's self-signed TLS. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { launchRemoteConnectionFixture, type RemoteConnectionFixture } from './remote-connection-fixture.ts'
import { credentialOnboardingStarted, openSettings, ZH_BROWSER_LOCALE } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/remote-connection', import.meta.url))
const MODE = webSnapshotMode()
const MOBILE = { width: 390, height: 844 }
const REPLACEMENT_FIXTURE = fileURLToPath(new URL('./fixtures/plugins/fixture-remote-connection', import.meta.url))
const EXTENSION_FIXTURE = fileURLToPath(new URL('./fixtures/plugins/fixture-remote-connection-extension', import.meta.url))
const REPLACEMENT_OVERLAY = fileURLToPath(new URL('./remote-connection-replacement.overlay.yml', import.meta.url))
const UNTRUSTED_OVERLAY = fileURLToPath(new URL('./remote-connection-untrusted.overlay.yml', import.meta.url))

/**
 * Wait until startup navigation opens the default Workspace's blank Session,
 * whose live composer replaces the Workspace trigger. Navigation selects that
 * Session only after the first Session-list pull lands; on the same pull the
 * Settings onboarding coordinator mounts its first-run steps and closes a
 * Settings panel that is already open (#9234).
 * @param page - application page of a Remote fixture, whose CLI starts with a default Workspace.
 */
async function startupSession(page: Page): Promise<void> {
  await page.locator('[data-composer-input][data-placeholder="描述你想要构建的内容, / 调用指令, @ 文件或对话"]')
    .waitFor({ state: 'attached' })
}

/**
 * Open Remote connection settings on a Remote fixture page once startup navigation has settled.
 * @param page - application page of a Remote fixture.
 * @returns the Remote connection section.
 */
async function remoteSettings(page: Page): Promise<Locator> {
  await startupSession(page)
  return openRemoteSettings(page)
}

/**
 * Open Settings on the Remote connection page and wait for its address card.
 * @param page - application page whose first Session-list pull has landed.
 * @returns the Remote connection section.
 */
async function openRemoteSettings(page: Page): Promise<Locator> {
  await openSettings(page, 'zh')
  await page.getByRole('dialog', { name: '设置', exact: true })
    .getByRole('button', { name: '远程连接', exact: true }).click()
  const section = page.getByRole('region', { name: '远程连接', exact: true })
  await section.waitFor()
  const link = section.getByRole('region', { name: '访问地址', exact: true })
  await expect.poll(() => link.getByRole('button', { name: '复制链接', exact: true }).isEnabled()).toBe(true)
  await assertAddressLayout(section, true)
  return section
}

async function assertAddressLayout(section: Locator, available: boolean): Promise<void> {
  const title = section.getByRole('heading', { level: 2 })
  expect(await title.evaluate((element) => {
    const style = getComputedStyle(element)
    return { fontSize: style.fontSize, lineHeight: style.lineHeight, fontWeight: style.fontWeight }
  })).toEqual({ fontSize: '16px', lineHeight: '24px', fontWeight: '500' })
  const address = section.getByRole('region', { name: '访问地址', exact: true })
  if (available) {
    const intro = section.getByText('通过以下方式，在其他设备上登录并使用 DeepSeek Harness。', { exact: true })
    expect(await intro.evaluate((element) => {
      const style = getComputedStyle(element)
      return { fontSize: style.fontSize, lineHeight: style.lineHeight }
    })).toEqual({ fontSize: '14px', lineHeight: '22px' })
    const titleBox = await title.boundingBox()
    const introBox = await intro.boundingBox()
    const addressBox = await address.boundingBox()
    expect(titleBox).not.toBeNull()
    expect(introBox).not.toBeNull()
    expect(addressBox).not.toBeNull()
    expect(introBox!.y - titleBox!.y - titleBox!.height).toBeCloseTo(12)
    expect(addressBox!.y - introBox!.y - introBox!.height).toBeCloseTo(24)
  }
  const code = address.locator('code')
  const fieldBox = await code.locator('..').boundingBox()
  const codeBox = await code.boundingBox()
  expect(fieldBox).not.toBeNull()
  expect(codeBox).not.toBeNull()
  expect(fieldBox!.height).toBe(28)
  expect(Math.abs(codeBox!.y + codeBox!.height / 2 - fieldBox!.y - fieldBox!.height / 2)).toBeLessThanOrEqual(1)
  const copyBox = await address.getByRole('button', { name: '复制链接', exact: true }).boundingBox()
  expect(copyBox).not.toBeNull()
  if (copyBox!.y > fieldBox!.y + fieldBox!.height) {
    expect(copyBox!.x).toBe(fieldBox!.x)
    expect(copyBox!.width).toBe(fieldBox!.width)
  } else {
    expect(copyBox!.y).toBe(fieldBox!.y)
  }
  const qr = section.getByRole('region', { name: '二维码登录', exact: true })
  const buttons = [...await address.getByRole('button').all(), ...await qr.getByRole('button').all()]
  for (const button of buttons) {
    const geometry = await button.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(element)
      const text = range.getBoundingClientRect()
      return { height: box.height, textOffset: Math.abs(text.y + text.height / 2 - box.y - box.height / 2) }
    })
    expect(geometry.height).toBe(28)
    expect(geometry.textOffset).toBeLessThanOrEqual(1)
  }
}

async function assertQrDetails(section: Locator): Promise<void> {
  const qr = section.getByRole('region', { name: '二维码登录', exact: true })
  const code = await qr.getByRole('img', { name: '一次性登录二维码' }).boundingBox()
  const timer = qr.getByRole('timer')
  const timerBox = await timer.boundingBox()
  const detailsBox = await timer.locator('..').boundingBox()
  const bannerBox = await qr.getByText('请勿分享登录二维码', { exact: true }).locator('..').locator('..').boundingBox()
  expect(code).not.toBeNull()
  expect(timerBox).not.toBeNull()
  expect(detailsBox).not.toBeNull()
  expect(bannerBox).not.toBeNull()
  expect(await qr.getByText('扫码后直接登录', { exact: true }).count()).toBe(0)
  expect(timerBox!.y).toBeGreaterThan(code!.y + code!.height)
  expect(Math.abs(timerBox!.x + timerBox!.width / 2 - code!.x - code!.width / 2)).toBeLessThanOrEqual(1)
  expect(await timer.locator('..').evaluate(element => getComputedStyle(element).marginBottom)).toBe('16px')
  expect(bannerBox!.y - detailsBox!.y - detailsBox!.height).toBeCloseTo(28)
}

async function headingTypography(heading: Locator, introGap: number) {
  const intro = heading.locator('..').locator(':scope > p').first()
  await intro.waitFor()
  const headingBox = await heading.boundingBox()
  const introBox = await intro.boundingBox()
  expect(headingBox).not.toBeNull()
  expect(introBox).not.toBeNull()
  expect(introBox!.y - headingBox!.y - headingBox!.height).toBeCloseTo(introGap)
  expect(introBox!.x).toBe(headingBox!.x)
  const typography = (element: HTMLElement | SVGElement) => {
    const style = getComputedStyle(element)
    return { fontSize: style.fontSize, lineHeight: style.lineHeight, fontWeight: style.fontWeight, color: style.color }
  }
  return { title: await heading.evaluate(typography), intro: await intro.evaluate(typography) }
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

async function waitForPairingList(pairing: Locator): Promise<void> {
  await pairing.waitFor()
  await pairing.getByRole('status', { name: '正在加载配对申请', exact: true }).waitFor({ state: 'hidden' })
  expect(await pairing.getByRole('alert').count()).toBe(0)
}

async function snapshot(page: Page, fixture: RemoteConnectionFixture, name: string, addressUrl = fixture.authenticatedUrl): Promise<void> {
  await waitForPairingList(page.getByRole('region', { name: '配对申请', exact: true }))
  await expect.poll(() => page.getByRole('region', { name: '访问地址', exact: true }).locator('code').textContent()).toBe(addressUrl)
  const section = page.getByRole('region', { name: '远程连接', exact: true })
  await assertAddressLayout(section, true)
  if (await section.getByRole('img', { name: '一次性登录二维码' }).count() > 0) await assertQrDetails(section)
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
      ignoreHTTPSErrors: true, locale: ZH_BROWSER_LOCALE, viewport: MOBILE, colorScheme: 'light', hasTouch: true,
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
      const input = page.locator('#token')
      const submit = page.getByRole('button', { name: '继续', exact: true })
      await input.waitFor()
      const applicationUrl = new URL(secure.url)
      const tokenPlaceholder = `${applicationUrl.origin}${applicationUrl.pathname}?token=xxx`
      expect(await input.getAttribute('placeholder')).toBe(tokenPlaceholder)
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
      const inputTypography = await input.evaluate((element) => {
        const textStyle = (style: CSSStyleDeclaration) => ({
          family: style.fontFamily, weight: style.fontWeight, style: style.fontStyle,
          smoothing: style.getPropertyValue('-webkit-font-smoothing'), size: style.fontSize,
        })
        const style = getComputedStyle(element)
        return {
          input: textStyle(style), placeholder: textStyle(getComputedStyle(element, '::placeholder')),
          family: getComputedStyle(document.documentElement).fontFamily, lineHeight: style.lineHeight,
        }
      })
      expect(inputTypography.input).toEqual({
        family: inputTypography.family, weight: '400', style: 'normal', smoothing: 'antialiased', size: '16px',
      })
      expect(inputTypography.placeholder).toEqual(inputTypography.input)
      expect(inputTypography.lineHeight).toBe('24px')
      const expectPlaceholderColor = async (color: string) => {
        const appearance = await input.evaluate(element => ({
          placeholder: getComputedStyle(element, '::placeholder').color,
          foreground: getComputedStyle(element).color,
        }))
        expect(appearance.placeholder).toBe(color)
        expect(appearance.placeholder).not.toBe(appearance.foreground)
      }
      await expectPlaceholderColor('rgb(173, 178, 184)')
      expect(await page.locator('#token-hint').innerText()).toBe('在已登录设备的「设置 → 远程连接」中复制链接，粘贴到此处')
      const tokenHeading = page.getByRole('heading', { name: '输入登录令牌或链接', level: 2, exact: true })
      const pairingHeading = page.getByRole('heading', { name: '配对此设备', level: 2, exact: true })
      await pairingHeading.waitFor()
      const methodLayout = (heading: Locator) => heading.evaluate((title) => {
        const hint = title.nextElementSibling!
        const control = title.parentElement!.querySelector('input,button')!
        const titleBox = title.getBoundingClientRect()
        const hintBox = hint.getBoundingClientRect()
        const controlBox = control.getBoundingClientRect()
        const typography = (element: Element) => {
          const style = getComputedStyle(element)
          return { size: style.fontSize, height: style.lineHeight, weight: style.fontWeight }
        }
        return {
          title: typography(title.querySelector('label') ?? title), description: typography(hint),
          titleGap: hintBox.top - titleBox.bottom, controlGap: controlBox.top - hintBox.bottom,
        }
      })
      const tokenLayout = await methodLayout(tokenHeading)
      expect(tokenLayout).toEqual(await methodLayout(pairingHeading))
      expect(tokenLayout).toEqual({
        title: { size: '14px', height: '21px', weight: '500' },
        description: { size: '14px', height: '21px', weight: '400' }, titleGap: 12, controlGap: 12,
      })
      expect(await page.getByRole('button', { name: '账号菜单', exact: true }).count()).toBe(0)
      expect(await page.evaluate(async () => {
        const reply = await fetch('./', { method: 'HEAD', credentials: 'same-origin', cache: 'no-store', redirect: 'manual' })
        return { status: reply.status, body: await reply.text() }
      })).toEqual({ status: 401, body: '' })
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(MOBILE.width)
      const inputAppearance = () => input.evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          borderWidth: style.borderTopWidth, borderColor: style.borderTopColor,
          outline: style.outlineStyle, shadow: style.boxShadow,
        }
      })
      const lightFocus = {
        borderWidth: (await inputAppearance()).borderWidth,
        borderColor: 'rgb(65, 118, 230)', outline: 'none', shadow: 'none',
      }
      await input.click()
      expect(await input.evaluate(element => document.activeElement === element)).toBe(true)
      expect(await inputAppearance()).toEqual(lightFocus)
      await page.keyboard.press('Tab')
      expect(await submit.evaluate(element => document.activeElement === element)).toBe(true)
      await page.keyboard.press('Shift+Tab')
      expect(await input.evaluate(element => document.activeElement === element)).toBe(true)
      expect(await inputAppearance()).toEqual(lightFocus)
      await compareOrRefreshGolden(join(EXPECTED, 'anonymous-login.expected.md'),
        await captureStableAria(page, 'main', secure.root, {
          replacements: [[tokenPlaceholder, '{{application-url}}?token=xxx']],
        }), MODE)
      const screenshots = process.env['DSH_REMOTE_CONNECTION_SCREENSHOTS']
      if (screenshots !== undefined) {
        await mkdir(screenshots, { recursive: true })
        await page.screenshot({ path: join(screenshots, 'anonymous-mobile-light.png') })
      }
      const lightBackground = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)
      await page.emulateMedia({ colorScheme: 'dark' })
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).not.toBe(lightBackground)
      await expectPlaceholderColor('rgb(129, 133, 140)')
      expect(await inputAppearance()).toEqual({ ...lightFocus, borderColor: 'rgb(122, 170, 255)' })
      if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'anonymous-mobile-dark.png') })

      const invalidToken = `${startupToken.startsWith('a') ? 'b' : 'a'}${startupToken.slice(1)}`
      const rejected = page.waitForResponse(reply => new URL(reply.url()).searchParams.get('token') === invalidToken)
      await input.fill(invalidToken)
      await submit.click()
      expect((await rejected).status()).toBe(401)
      await page.getByRole('alert').filter({ hasText: '此登录令牌无效或已过期，请粘贴新的令牌后重试' }).waitFor()
      await input.focus()
      expect(page.url()).toBe(secure.url)
      expect(await input.getAttribute('aria-invalid')).toBe('true')
      expect(await page.locator('#token-hint').isVisible()).toBe(true)
      expect(await methodLayout(tokenHeading)).toEqual(tokenLayout)
      expect(await inputAppearance()).toMatchObject({ borderColor: 'rgb(242, 90, 90)', outline: 'none', shadow: 'none' })
      expect(await submit.isEnabled()).toBe(true)
      const [inputBox, errorBox, submitBox] = await Promise.all([
        input.boundingBox(), page.locator('#token-error').boundingBox(), submit.boundingBox(),
      ])
      expect(inputBox).not.toBeNull()
      expect(errorBox).not.toBeNull()
      expect(submitBox).not.toBeNull()
      expect(errorBox!.y).toBeGreaterThanOrEqual(inputBox!.y + inputBox!.height)
      expect(submitBox!.y).toBeGreaterThanOrEqual(errorBox!.y + errorBox!.height)
      expect(await phone.cookies()).toEqual([])
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(MOBILE.width)
      expect(await input.getAttribute('placeholder')).toBe(tokenPlaceholder)
      await compareOrRefreshGolden(join(EXPECTED, 'anonymous-rejected.expected.md'),
        await captureStableAria(page, 'main', secure.root, {
          replacements: [[tokenPlaceholder, '{{application-url}}?token=xxx'], [invalidToken, '{{invalid-token}}']],
        }), MODE)
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

  it.each([
    { language: 'zh', locale: ZH_BROWSER_LOCALE, limited: '请求过于频繁，稍后自动重试…', creating: '正在申请配对…', again: '重新申请' },
    { language: 'en', locale: 'en-US', limited: 'Too many requests. Retrying shortly…', creating: 'Requesting approval…', again: 'Request again' },
  ])('keeps the pairing action readable during rate-limit recovery in $language', async ({ language, locale, limited, creating, again }) => {
    const fixture = await launchRemoteConnectionFixture(true)
    onTestFinished(() => fixture.close())
    const context = await browser.newContext({ ignoreHTTPSErrors: true, locale, viewport: MOBILE, colorScheme: 'light', hasTouch: true })
    const page = await context.newPage()
    const releaseRetry = Promise.withResolvers<undefined>()
    try {
      const console = watchConsole(page)
      await page.clock.install()
      expect((await page.goto(fixture.url))?.status()).toBe(401)
      const request = page.locator('#auth-pair-request')
      const panel = page.locator('#auth-pair-panel')
      await request.click()
      await page.locator('#auth-pair-code').waitFor()
      const originalCode = await page.locator('#auth-pair-code').innerText()
      await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 1000)))
      let limitedOnce = false
      const retryStarted = Promise.withResolvers<undefined>()
      await page.route('**/pairing/request', async (route) => {
        if (!limitedOnce) {
          limitedOnce = true
          await route.fulfill({ status: 429, contentType: 'application/json', body: '{"status":"busy"}' })
          return
        }
        retryStarted.resolve(undefined)
        await releaseRetry.promise
        await route.continue()
      })
      await request.click()
      const status = panel.getByRole('status')
      await status.getByText(limited, { exact: true }).waitFor()
      await page.clock.fastForward(2000)
      await retryStarted.promise
      expect(await request.isDisabled()).toBe(true)
      expect(await request.textContent()).toBe(creating)
      expect(await status.textContent()).toBe(limited)
      await compareOrRefreshGolden(join(EXPECTED, `pairing-rate-limited.${language}.expected.md`),
        await captureStableAria(page, 'dsh-device-pairing', fixture.root), MODE)
      const screenshots = process.env['DSH_REMOTE_CONNECTION_SCREENSHOTS']
      const screenshotDirectory = screenshots === undefined ? undefined : join(screenshots, 'pairing-rate-limited')
      if (screenshotDirectory !== undefined) await mkdir(screenshotDirectory, { recursive: true })
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        const contrast = await request.evaluate((element) => {
          const style = getComputedStyle(element)
          const canvas = document.createElement('canvas')
          canvas.width = canvas.height = 1
          const drawing = canvas.getContext('2d')!
          drawing.fillStyle = style.backgroundColor
          drawing.fillRect(0, 0, 1, 1)
          const luminance = (pixel: Uint8ClampedArray) => {
            const linear = Array.from(pixel.slice(0, 3), (value) => {
              const channel = value / 255
              return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
            })
            return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
          }
          const background = luminance(drawing.getImageData(0, 0, 1, 1).data)
          drawing.fillStyle = style.color
          drawing.fillRect(0, 0, 1, 1)
          const foreground = luminance(drawing.getImageData(0, 0, 1, 1).data)
          return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
        })
        expect(contrast, colorScheme).toBeGreaterThanOrEqual(3)
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(MOBILE.width)
        if (screenshotDirectory !== undefined) await page.screenshot({ path: join(screenshotDirectory, `${language}-${colorScheme}.png`) })
      }
      releaseRetry.resolve(undefined)
      await page.clock.resume()
      await page.locator('#auth-pair-panel[data-state="waiting"]').waitFor()
      expect(await request.isEnabled()).toBe(true)
      expect(await request.textContent()).toBe(again)
      expect(await page.locator('#auth-pair-code').innerText()).not.toBe(originalCode)
      expect(console.pageErrors).toEqual([])
      expect(console.warnings).toEqual([])
    } finally {
      releaseRetry.resolve(undefined)
      await page.unrouteAll({ behavior: 'wait' })
      await context.close()
    }
  })

  it.each([
    {
      name: 'unreachable', hostname: '127.0.0.1', options: {},
      warning: '当前地址无法用于跨设备登录。请用另一台设备能访问的地址重新启动服务。',
      steps: [
        '两台设备在同一局域网时，可用局域网 IP。',
        '通过 VPN 或公网访问时，可用已开通访问的 VPN 地址或公网 IP。',
      ],
    },
    {
      name: 'untrusted', hostname: 'untrusted-remote.test', options: { extraOverlayPath: UNTRUSTED_OVERLAY },
      warning: '请先将此访问地址加入 Host 的可信主机配置，才能使用下方的登录方式',
      steps: [],
    },
  ])('explains unavailable address prerequisites before sign-in methods for $name', async ({ name, hostname, options, warning, steps }) => {
    const scaffold = await launchWebScaffold(options)
    onTestFinished(() => scaffold.close())
    // The shared QR browser's proxy setup rejects the scaffold's loopback URL.
    const localBrowser = await chromium.launch()
    onTestFinished(() => localBrowser.close())
    const plainUrl = scaffold.ctx.webApp.getAdvertisedUrl()
    expect(new URL(plainUrl).hostname).toBe(hostname)
    const loopback = name === 'unreachable'
    const expectedAddress = loopback ? scaffold.authenticatedUrl : plainUrl
    for (const [viewport, colorScheme, suffix] of [
      [{ width: 1200, height: 1000 }, 'light', 'desktop'],
      [MOBILE, 'dark', 'mobile-dark'],
    ] as const) {
      const context = await localBrowser.newContext({
        locale: ZH_BROWSER_LOCALE, viewport, colorScheme, permissions: ['clipboard-read', 'clipboard-write'],
      })
      try {
        const page = await context.newPage()
        const console = watchConsole(page)
        // The scaffold starts without a Workspace, so startup navigation opens no Session to wait for.
        const onboarding = credentialOnboardingStarted(page)
        await page.goto(scaffold.authenticatedUrl)
        await onboarding
        await openSettings(page, 'zh')
        await page.getByRole('dialog', { name: '设置', exact: true })
          .getByRole('button', { name: '远程连接', exact: true }).click()
        const section = page.getByRole('region', { name: '远程连接', exact: true })
        const address = section.getByRole('region', { name: '访问地址', exact: true })
        await expect.poll(async () => await address.locator('code').textContent() === expectedAddress).toBe(true)
        const notice = section.getByRole('status').filter({ hasText: warning })
        await notice.getByText(warning, { exact: true }).waitFor()
        expect(await notice.getByRole('listitem').allTextContents()).toEqual(steps)
        const pairing = section.getByRole('region', { name: '配对申请', exact: true })
        await waitForPairingList(pairing)
        expect(await section.getByRole('region').count()).toBe(2)
        expect(await section.getByRole('heading', { level: 3 }).allTextContents()).toEqual(['访问地址', '配对申请'])
        expect(await address.getByText(warning, { exact: true }).count()).toBe(0)
        expect(await pairing.getByText(warning, { exact: true }).count()).toBe(0)
        expect(await section.getByRole('region', { name: '二维码登录', exact: true }).count()).toBe(0)
        expect(await section.getByRole('img').count()).toBe(0)
        const copy = address.getByRole('button', { name: '复制链接', exact: true })
        expect(await address.getByRole('button').count()).toBe(1)
        await copy.click()
        await page.getByText('链接已复制', { exact: true }).waitFor()
        const copiedAddress = await page.evaluate(() => navigator.clipboard.readText())
        expect(copiedAddress === expectedAddress).toBe(true)
        expect(await copy.isEnabled()).toBe(true)
        expect(await section.getByText('请勿公开分享登录链接', { exact: true }).count()).toBe(loopback ? 1 : 0)
        expect(await section.getByText('请勿分享登录二维码', { exact: true }).count()).toBe(0)
        expect(Boolean(new URL(copiedAddress).searchParams.get('token'))).toBe(loopback)
        const titleBox = await section.getByRole('heading', { level: 2 }).boundingBox()
        const noticeBox = await notice.boundingBox()
        const addressBox = await address.boundingBox()
        expect(titleBox).not.toBeNull()
        expect(noticeBox).not.toBeNull()
        expect(addressBox).not.toBeNull()
        expect(noticeBox!.y - titleBox!.y - titleBox!.height).toBeCloseTo(12)
        expect(addressBox!.y - noticeBox!.y - noticeBox!.height).toBeCloseTo(12)
        await assertAddressLayout(section, false)
        expect(noticeBox!.x).toBeCloseTo(addressBox!.x)
        expect(noticeBox!.x).toBeGreaterThanOrEqual(0)
        expect(noticeBox!.x + noticeBox!.width).toBeLessThanOrEqual(viewport.width)
        await compareOrRefreshGolden(join(EXPECTED, `${name}-${suffix}.expected.md`),
          await captureStableAria(page, 'section[aria-label="远程连接"]', scaffold.workspaceCwd, {
            replacements: [[scaffold.authenticatedUrl, '{{access-address}}?token={{login-token}}'], [plainUrl, '{{access-address}}']],
          }), MODE)
        const screenshots = process.env['DSH_REMOTE_CONNECTION_SCREENSHOTS']
        if (screenshots !== undefined) {
          await mkdir(screenshots, { recursive: true })
          await page.screenshot({ path: join(screenshots, `${name}-${suffix}.png`), mask: loopback ? [address.locator('code')] : [] })
        }
        if (loopback && suffix === 'desktop') {
          const guest = await localBrowser.newPage({ locale: ZH_BROWSER_LOCALE })
          try {
            await guest.goto(copiedAddress)
            await guest.getByRole('button', { name: '账号菜单', exact: true, includeHidden: true }).waitFor({ state: 'attached' })
            expect(guest.url() === new URL(plainUrl).href).toBe(true)
            expect((await guest.context().cookies()).some(cookie => cookie.name.startsWith('dsh-auth-'))).toBe(true)
          } finally {
            await guest.close()
          }

          await page.route('**/api/remoteConnection/status', route => route.abort('failed'))
          const reloadedOnboarding = credentialOnboardingStarted(page)
          await page.reload()
          await reloadedOnboarding
          await openSettings(page, 'zh')
          await page.getByRole('dialog', { name: '设置', exact: true })
            .getByRole('button', { name: '远程连接', exact: true }).click()
          const failure = address.getByRole('alert')
          await failure.waitFor()
          expect(await failure.textContent()).toBe('无法加载远程连接设置，请重试')
          const retry = address.getByRole('button', { name: '重试', exact: true })
          expect(await retry.isEnabled()).toBe(true)
          expect((await retry.boundingBox())!.height).toBe(28)
          expect(await section.getByRole('region', { name: '二维码登录', exact: true }).count()).toBe(0)
          await waitForPairingList(pairing)
          await compareOrRefreshGolden(join(EXPECTED, 'unreachable-load-failed.expected.md'),
            await captureStableAria(page, 'section[aria-label="远程连接"]', scaffold.workspaceCwd), MODE)
          if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'unreachable-load-failed.png') })
          await page.unroute('**/api/remoteConnection/status')
          await retry.click()
          await expect.poll(async () => await address.locator('code').textContent() === expectedAddress).toBe(true)
          await notice.getByText(warning, { exact: true }).waitFor()
          expect(await address.getByRole('alert').count()).toBe(0)
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width)
        expect(console.pageErrors).toEqual([])
      } finally {
        await context.close()
      }
    }
  })

  it('matches Models heading typography across Remote connection and Agent presets', async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: ZH_BROWSER_LOCALE })
    try {
      const page = await context.newPage()
      const console = watchConsole(page)
      await page.goto(secure.authenticatedUrl)
      await startupSession(page)
      await openSettings(page, 'zh')
      const dialog = page.getByRole('dialog', { name: '设置', exact: true })
      for (const [viewport, colorScheme, suffix] of [
        [{ width: 1200, height: 1000 }, 'light', 'desktop-light'],
        [{ width: 1200, height: 1000 }, 'dark', 'desktop-dark'],
        [MOBILE, 'light', 'mobile-light'],
        [MOBILE, 'dark', 'mobile-dark'],
      ] as const) {
        await page.setViewportSize(viewport)
        await page.emulateMedia({ colorScheme })
        await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(colorScheme)
        await dialog.getByRole('button', { name: '模型', exact: true }).click()
        const modelsHeading = dialog.getByRole('heading', { name: '模型', level: 2, exact: true })
        await modelsHeading.locator('..').locator('..').locator(':scope > ul').waitFor({ state: 'attached' })
        const models = await headingTypography(modelsHeading, 4)
        expect(models.title).toMatchObject({ fontSize: '16px', lineHeight: '24px', fontWeight: '500' })
        expect(models.intro).toMatchObject({ fontSize: '14px', lineHeight: '22px' })
        const screenshots = process.env['DSH_REMOTE_CONNECTION_SCREENSHOTS']
        if (screenshots !== undefined) {
          await mkdir(screenshots, { recursive: true })
          await page.screenshot({ path: join(screenshots, `typography-models-${suffix}.png`) })
        }
        await dialog.getByRole('button', { name: 'Agent 预设', exact: true }).click()
        await dialog.locator('[data-agent-preset-id]').first().waitFor()
        expect(await headingTypography(dialog.getByRole('heading', { name: 'Agent 预设', level: 2, exact: true }), 4)).toEqual(models)
        if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, `typography-presets-${suffix}.png`) })
        await dialog.getByRole('button', { name: '远程连接', exact: true }).click()
        const section = dialog.getByRole('region', { name: '远程连接', exact: true })
        await section.getByText('通过以下方式，在其他设备上登录并使用 DeepSeek Harness。', { exact: true }).waitFor()
        expect(await headingTypography(section.getByRole('heading', { name: '远程连接', level: 2, exact: true }), 12)).toEqual(models)
        await assertAddressLayout(section, true)
        if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, `typography-remote-${suffix}.png`) })
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width)
      }
      expect(console.pageErrors).toEqual([])
    } finally {
      await context.close()
    }
  })

  it('copies the plain address after a failed read and restores the credential link on reload', async () => {
    const desktop = await browser.newContext({
      ignoreHTTPSErrors: true, locale: ZH_BROWSER_LOCALE, viewport: { width: 1200, height: 1000 },
      permissions: ['clipboard-read', 'clipboard-write'], colorScheme: 'light',
    })
    const phone = await browser.newContext({ ignoreHTTPSErrors: true, locale: ZH_BROWSER_LOCALE, viewport: MOBILE })
    try {
      const page = await desktop.newPage()
      const console = watchConsole(page)
      let rejectLinkRead = true
      let reads = 0
      await page.route('**/api/remoteConnection/loginUrl', (route) => {
        reads += 1
        if (!rejectLinkRead) return route.continue()
        const request = route.request().postDataJSON() as { rpcId: string }
        return route.fulfill({ json: {
          type: 'server-response', rpcId: request.rpcId,
          result: { ok: false, error: { code: 'gateway/internal', message: 'Fixture unavailable', details: {} } },
        } })
      })
      const rejected = page.waitForResponse(response => new URL(response.url()).pathname === '/api/remoteConnection/loginUrl')
      await page.goto(secure.authenticatedUrl)
      const section = await remoteSettings(page)
      await rejected
      const qrSection = section.getByRole('region', { name: '二维码登录', exact: true })
      const linkSection = section.getByRole('region', { name: '访问地址', exact: true })
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
      expect(await linkSection.locator('code').textContent()).toBe(secure.url)
      expect(await section.getByRole('alert').count()).toBe(0)
      expect(await section.getByRole('button', { name: '重试', exact: true }).count()).toBe(0)
      expect(await section.getByText('无法获取登录链接，请重试', { exact: true }).count()).toBe(0)
      await snapshot(page, secure, 'address-token-unavailable', secure.url)
      const readsBeforeCopy = reads
      await linkSection.getByRole('button', { name: '复制链接', exact: true }).click()
      await page.getByText('链接已复制', { exact: true }).waitFor()
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secure.url)
      expect(reads).toBe(readsBeforeCopy)
      expect(await linkSection.getByText('请勿公开分享登录链接', { exact: true }).count()).toBe(0)
      await snapshot(page, secure, 'address-plain-copied', secure.url)
      rejectLinkRead = false
      await page.reload()
      await remoteSettings(page)
      await expect.poll(() => linkSection.locator('code').textContent()).toBe(secure.authenticatedUrl)
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
      const copyBox = await linkSection.getByRole('button', { name: '复制链接', exact: true }).boundingBox()
      expect(copyBox).not.toBeNull()
      expect(copyBox!.x).toBeGreaterThanOrEqual(0)
      expect(copyBox!.x + copyBox!.width).toBeLessThanOrEqual(MOBILE.width)
      const mobileLinkField = await linkSection.locator('code').locator('..').boundingBox()
      expect(mobileLinkField).not.toBeNull()
      expect(mobileLinkField!.height).toBe(copyBox!.height)
      expect(await qrSection.getByRole('button', { name: '生成二维码', exact: true }).boundingBox())
        .toMatchObject({ x: copyBox!.x, width: copyBox!.width })
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
      await linkSection.getByRole('button', { name: '复制链接', exact: true }).click()
      await page.getByText('链接已复制', { exact: true }).waitFor()
      await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
      expect(await page.getByRole('dialog', { name: '设置', exact: true }).count()).toBe(0)
      expect(await page.getByText('链接已复制', { exact: true }).count()).toBe(1)
      await remoteSettings(page)
      expect(await linkSection.getByText('请勿公开分享登录链接', { exact: true }).count()).toBe(0)
      expect(await linkSection.locator('code').textContent()).toBe(copiedUrl)
      expect(await qrSection.getByRole('img').count()).toBe(1)
      expect(await qrSection.getByText('请勿分享登录二维码', { exact: true }).count()).toBe(1)
      await snapshot(page, secure, 'link-reopened')
      if (screenshots !== undefined) {
        await page.getByRole('dialog', { name: '设置', exact: true }).screenshot({ path: join(screenshots, 'link-reopened-desktop.png') })
      }
      await linkSection.getByRole('button', { name: '复制链接', exact: true }).click()
      await linkSection.getByText('请勿公开分享登录链接', { exact: true }).waitFor()
      expect(console.pageErrors).toEqual([])
    } finally {
      await Promise.all([desktop.close(), phone.close()])
    }
  })

  it('keeps copying busy while a Token read finishes and only warns after a credential copy', async () => {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true, locale: ZH_BROWSER_LOCALE,
      viewport: { width: 1200, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'],
    })
    let releaseRead!: () => void
    const gate = new Promise<void>((resolve) => { releaseRead = resolve })
    const pendingReads: Promise<void>[] = []
    const deployment = Promise.withResolvers<undefined>()
    let readStarted!: () => void
    const started = new Promise<void>((resolve) => { readStarted = resolve })
    try {
      const page = await context.newPage()
      const console = watchConsole(page)
      let initialDeploymentRead = true
      // Initial connection readiness reloads deployment; keep the pre-connect reply from starting a Token read.
      await page.route('**/api/remoteConnection/status', (route) => {
        if (initialDeploymentRead) initialDeploymentRead = false
        else deployment.resolve(undefined)
        const reading = deployment.promise.then(() => route.continue())
        pendingReads.push(reading)
        return reading
      })
      await page.route('**/api/remoteConnection/loginUrl', (route) => {
        readStarted()
        const reading = gate.then(() => route.continue())
        pendingReads.push(reading)
        return reading
      })
      await page.goto(secure.authenticatedUrl)
      const section = await remoteSettings(page)
      await started
      const address = section.getByRole('region', { name: '访问地址', exact: true })
      expect(await address.locator('code').textContent()).toBe(secure.url)
      await page.evaluate(() => {
        const write = navigator.clipboard.writeText.bind(navigator.clipboard)
        Object.defineProperty(navigator.clipboard, 'writeText', {
          configurable: true,
          value: async (text: string) => {
            Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: write })
            const released = new Promise<void>((resolve) => {
              document.addEventListener('fixture-release-clipboard', () => { resolve() }, { once: true })
            })
            await write(text)
            await released
          },
        })
      })
      const copy = address.getByRole('button', { name: '复制链接', exact: true })
      await copy.click()
      await expect.poll(() => copy.isEnabled()).toBe(false)
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secure.url)
      releaseRead()
      await expect.poll(() => address.locator('code').textContent()).toBe(secure.authenticatedUrl)
      expect(await copy.isEnabled()).toBe(false)
      expect(await address.getByText('请勿公开分享登录链接', { exact: true }).count()).toBe(0)
      await snapshot(page, secure, 'address-copying-after-token-load')
      const screenshots = process.env['DSH_REMOTE_CONNECTION_SCREENSHOTS']
      if (screenshots !== undefined) {
        await mkdir(screenshots, { recursive: true })
        await page.screenshot({ path: join(screenshots, 'address-copying-after-token-load.png') })
      }
      await page.evaluate(() => document.dispatchEvent(new Event('fixture-release-clipboard')))
      await page.getByText('链接已复制', { exact: true }).waitFor()
      expect(await copy.isEnabled()).toBe(true)
      expect(await address.getByText('请勿公开分享登录链接', { exact: true }).count()).toBe(0)
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secure.url)
      await snapshot(page, secure, 'address-plain-copied-after-token-load')
      if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'address-plain-copied-after-token-load.png') })
      await copy.click()
      await address.getByText('请勿公开分享登录链接', { exact: true }).waitFor()
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secure.authenticatedUrl)
      expect(await copy.isEnabled()).toBe(true)
      expect(console.pageErrors).toEqual([])
    } finally {
      deployment.resolve(undefined)
      releaseRead()
      try {
        await Promise.all(pendingReads)
      } finally {
        await context.close()
      }
    }
  })

  it('keeps the address and copy label after both clipboard methods reject the write', async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: ZH_BROWSER_LOCALE })
    try {
      const page = await context.newPage()
      const console = watchConsole(page)
      await page.goto(secure.authenticatedUrl)
      const section = await remoteSettings(page)
      const address = section.getByRole('region', { name: '访问地址', exact: true })
      await expect.poll(() => address.locator('code').textContent()).toBe(secure.authenticatedUrl)
      await page.evaluate(() => {
        Object.defineProperty(navigator.clipboard, 'writeText', {
          configurable: true, value: () => Promise.reject(new DOMException('Fixture clipboard denied', 'NotAllowedError')),
        })
        Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false })
      })
      const copy = address.getByRole('button', { name: '复制链接', exact: true })
      const originalButton = await copy.elementHandle()
      expect(originalButton).not.toBeNull()
      await copy.click()
      await page.getByText('无法复制登录链接，请检查剪贴板权限后重试', { exact: true }).waitFor()
      expect(await copy.isEnabled()).toBe(true)
      expect(await copy.evaluate((element, original) => element === original, originalButton)).toBe(true)
      await copy.focus()
      expect(await copy.evaluate(element => document.activeElement === element)).toBe(true)
      expect(await address.locator('code').textContent()).toBe(secure.authenticatedUrl)
      expect(await address.getByText('请勿公开分享登录链接', { exact: true }).count()).toBe(0)
      expect(await section.getByRole('alert').count()).toBe(0)
      await snapshot(page, secure, 'address-clipboard-denied')
      const screenshots = process.env['DSH_REMOTE_CONNECTION_SCREENSHOTS']
      if (screenshots !== undefined) {
        await mkdir(screenshots, { recursive: true })
        await page.screenshot({ path: join(screenshots, 'address-clipboard-denied.png') })
      }
      expect(console.pageErrors).toEqual([])
    } finally {
      await context.close()
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
      const link = section.getByRole('region', { name: '访问地址', exact: true })
      await expect.poll(() => link.locator('code').textContent()).toBe(fixture.authenticatedUrl)
      const copy = link.getByRole('button', { name: '复制链接', exact: true })
      await copy.scrollIntoViewIfNeeded()
      const beforeSection = await section.boundingBox()
      const beforeQr = await qr.boundingBox()
      const beforeLink = await link.boundingBox()
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
      expect(beforeLink).not.toBeNull()
      expect(beforeField).not.toBeNull()
      expect(beforeCopy).not.toBeNull()
      const gutterChange = await scrollport.evaluate(element => element.getBoundingClientRect().width - element.clientWidth) - beforeGutter
      expect((await section.boundingBox())!.width).toBe(beforeSection!.width - gutterChange)
      const afterQr = await qr.boundingBox()
      const afterLink = await link.boundingBox()
      expect(afterQr).not.toBeNull()
      expect(afterLink).not.toBeNull()
      expect(afterLink!.height).toBeGreaterThan(beforeLink!.height)
      expect(afterQr).toEqual({
        ...beforeQr!, y: beforeQr!.y + afterLink!.height - beforeLink!.height, width: beforeQr!.width - gutterChange,
      })
      expect(await link.locator('code').locator('..').boundingBox()).toEqual({ ...beforeField!, width: beforeField!.width - gutterChange })
      expect(await link.getByRole('button', { name: '复制链接', exact: true }).boundingBox()).toEqual({ ...beforeCopy!, x: beforeCopy!.x - gutterChange })
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
      await assertQrDetails(desktopSection)

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
      await assertQrDetails(mobileSection)
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
      expect(await mobileSection.getByRole('region', { name: '二维码登录', exact: true }).getByRole('status').count()).toBe(0)
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

  it('keeps ordinary login choices after rejected QR exchanges and signs in through the Token form', async () => {
    const invalidMessage = '此二维码无效、已过期或已使用，请在已登录的设备上生成新的二维码，或使用其他登录方式'
    const phone = await browser.newContext({ ignoreHTTPSErrors: true, locale: ZH_BROWSER_LOCALE })
    try {
      const page = await phone.newPage()
      const invalid = new URL(secure.url)
      invalid.searchParams.set('login', 'qr')
      invalid.hash = 'x'.repeat(43)
      const refused = page.waitForResponse(response => new URL(response.url()).pathname === '/' && new URL(response.url()).search === '?login=qr'
        && response.request().method() === 'POST')
      expect((await page.goto(invalid.href))?.status()).toBe(200)
      expect((await refused).status()).toBe(410)
      await page.locator('#qr-notice[data-state="error"]').waitFor()
      await page.getByRole('alert').filter({ hasText: invalidMessage }).waitFor()
      await page.getByRole('heading', { name: '连接到此 Host', exact: true }).waitFor()
      const input = page.locator('#token')
      const submit = page.getByRole('button', { name: '继续', exact: true })
      expect(await input.isEnabled()).toBe(true)
      expect(await submit.isEnabled()).toBe(true)
      expect(new URL(page.url()).hash).toBe('')
      expect((await phone.cookies()).some(cookie => cookie.name.startsWith('dsh-remote-'))).toBe(false)
      const screenshots = process.env['DSH_REMOTE_CONNECTION_SCREENSHOTS']
      if (screenshots !== undefined) await mkdir(screenshots, { recursive: true })
      for (const viewport of [{ width: 1200, height: 900 }, MOBILE]) {
        await page.setViewportSize(viewport)
        for (const colorScheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme })
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width)
          expect(await input.isVisible()).toBe(true)
          expect(await submit.isVisible()).toBe(true)
          if (screenshots !== undefined) await page.screenshot({
            path: join(screenshots, `invalid-qr-${viewport.width === MOBILE.width ? 'mobile' : 'desktop'}-${colorScheme}.png`),
          })
        }
      }
      await input.fill(new URL(secure.authenticatedUrl).searchParams.get('token')!)
      await submit.click()
      await page.getByRole('button', { name: '账号菜单', exact: true, includeHidden: true }).waitFor({ state: 'attached' })
      expect(page.url()).toBe(secure.url)
      expect((await phone.cookies()).some(cookie => cookie.name.startsWith('dsh-auth-'))).toBe(true)
    } finally {
      await phone.close()
    }

    const expired = await launchRemoteConnectionFixture(false, 5000)
    onTestFinished(() => expired.close())
    const desktop = await browser.newContext({ locale: ZH_BROWSER_LOCALE })
    const applicant = await browser.newContext({ locale: ZH_BROWSER_LOCALE, viewport: MOBILE })
    try {
      const owner = await desktop.newPage()
      await owner.goto(expired.authenticatedUrl)
      const settings = await remoteSettings(owner)
      const invitation = await createCode(owner, settings)
      await settings.getByText('二维码已过期，请生成新二维码登录', { exact: true }).waitFor()
      const page = await applicant.newPage()
      const refused = page.waitForResponse(response => new URL(response.url()).pathname === '/' && new URL(response.url()).search === '?login=qr'
        && response.request().method() === 'POST')
      await page.goto(invitation)
      expect((await refused).status()).toBe(410)
      await page.getByRole('alert').filter({ hasText: invalidMessage }).waitFor()
      await page.getByRole('heading', { name: '连接到此 Host', exact: true }).waitFor()
      const input = page.locator('#token')
      const submit = page.getByRole('button', { name: '继续', exact: true })
      expect(await input.isEnabled()).toBe(true)
      expect(await submit.isEnabled()).toBe(true)
      const screenshots = process.env['DSH_REMOTE_CONNECTION_SCREENSHOTS']
      if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'expired-qr-mobile-light.png') })
      await input.fill(new URL(expired.authenticatedUrl).searchParams.get('token')!)
      await submit.click()
      await page.getByRole('button', { name: '账号菜单', exact: true, includeHidden: true }).waitFor({ state: 'attached' })
      expect(page.url()).toBe(expired.url)
      expect((await applicant.cookies()).some(cookie => cookie.name.startsWith('dsh-auth-'))).toBe(true)
    } finally {
      await Promise.all([desktop.close(), applicant.close()])
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
        const link = section.getByRole('region', { name: '访问地址', exact: true })
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
      const qr = section.getByRole('region', { name: '二维码登录', exact: true })
      expect(await qr.getByRole('status').count()).toBe(0)
      expect(await qr.getByRole('button', { name: '生成二维码', exact: true }).isEnabled()).toBe(true)
      expect(await qr.getByRole('button', { name: '重新生成', exact: true }).count()).toBe(0)
      expect(await section.getByRole('img').count()).toBe(0)
      await snapshot(page, secure, 'cancelled')
      const screenshots = process.env['DSH_REMOTE_CONNECTION_SCREENSHOTS']
      if (screenshots !== undefined) {
        await mkdir(screenshots, { recursive: true })
        await page.getByRole('dialog', { name: '设置', exact: true }).screenshot({ path: join(screenshots, 'cancelled-desktop.png') })
      }
      const other = await phone.newPage()
      const refused = other.waitForResponse(response => new URL(response.url()).pathname === '/' && new URL(response.url()).search === '?login=qr'
        && response.request().method() === 'POST')
      await other.goto(qrUrl)
      expect((await refused).status()).toBe(410)
      expect((await phone.cookies()).filter(cookie => cookie.name.startsWith('dsh-remote-'))).toEqual([])
      expect(await createCode(page, section)).not.toBe(qrUrl)
      await page.reload()
      await page.getByRole('button', { name: '账号菜单', exact: true, includeHidden: true }).waitFor({ state: 'attached' })
    } finally {
      await Promise.all([desktop.close(), phone.close()])
    }
  })

  it('adds options alongside the panel and preserves them across content replacement', async () => {
    const scaffold = await launchWebScaffold({
      remoteAuthority: 'qr-login.test', extraOverlayPath: REPLACEMENT_OVERLAY,
      extraInstallAnchors: [join(REPLACEMENT_FIXTURE, 'package.json'), join(EXTENSION_FIXTURE, 'package.json')],
    })
    onTestFinished(() => scaffold.close())
    const desktop = await browser.newContext({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1200, height: 1200 }, colorScheme: 'light' })
    try {
      const page = await desktop.newPage()
      const console = watchConsole(page)
      // The scaffold starts without a Workspace, so startup navigation opens no Session to wait for.
      const onboarding = credentialOnboardingStarted(page)
      await page.goto(scaffold.authenticatedUrl)
      await onboarding
      const section = await openRemoteSettings(page)
      const extension = page.getByRole('region', { name: '连接选项', exact: true })
      const additional = await scaffold.ctx.loader.create({ name: '@fixture/remote-connection-extension' })
      await extension.waitFor()
      const screenshots = process.env['DSH_REMOTE_CONNECTION_SCREENSHOTS']
      if (screenshots !== undefined) {
        await mkdir(screenshots, { recursive: true })
        await page.screenshot({ path: join(screenshots, 'extensions-overview-desktop-light.png') })
      }
      const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/remoteConnection/create')
      await createCode(page, section)
      const initial = await (await created).json() as { result: { value: { id: string } } }
      const invitationId = initial.result.value.id
      const svg = section.getByRole('img', { name: '一次性登录二维码' })
      const initialSvg = await svg.innerHTML()
      const nav = page.getByRole('dialog', { name: '设置', exact: true })
        .getByRole('button', { name: '远程连接', exact: true })
      const custom = page.getByRole('region', { name: '自定义远程连接', exact: true })
      const linkCard = section.getByRole('region', { name: '访问地址', exact: true })
      await expect.poll(() => linkCard.locator('code').textContent()).toBe(scaffold.authenticatedUrl)
      expect(await nav.count()).toBe(1)
      expect(await svg.innerHTML()).toBe(initialSvg)
      expect(await section.getByRole('button', { name: '复制链接', exact: true }).isEnabled()).toBe(true)
      const details = extension.getByRole('checkbox', { name: '显示邀请详情', exact: true })
      await extension.getByText('在此浏览器查看当前邀请的状态和编号', { exact: true }).waitFor()
      expect(await extension.getByRole('status', { name: '附加选项中的邀请编号' }).count()).toBe(0)
      await details.check()
      expect(await extension.getByRole('status', { name: '附加选项中的邀请编号' }).textContent()).toBe(invitationId)
      expect(await extension.locator('dl dt').count()).toBe(2)
      expect(await extension.locator('dl dd').count()).toBe(2)
      expect(await extension.locator('dl code').textContent()).toBe(invitationId)
      const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/remoteConnection/status')
      await extension.getByRole('button', { name: '刷新连接状态', exact: true }).click()
      expect((await refreshed).status()).toBe(200)
      await extension.getByRole('status').filter({ hasText: '等待扫码' }).waitFor()
      expect(await svg.innerHTML()).toBe(initialSvg)
      const loginUrl = await section.getByRole('region', { name: '访问地址', exact: true }).locator('code').textContent()
      expect(loginUrl).not.toBeNull()
      await waitForPairingList(section.getByRole('region', { name: '配对申请', exact: true }))
      const extendedAria = await captureStableAria(page, '[data-slot="settings.section"]', scaffold.workspaceCwd, {
        replacements: [[loginUrl!, '{{access-address}}?token={{login-token}}'], [invitationId, '{{invitation-id}}']],
      })
      await compareOrRefreshGolden(join(EXPECTED, 'extensions.expected.md'), extendedAria.replace(/\d+ 秒后过期/gu, '{{seconds}} 秒后过期'), MODE)
      for (const viewport of [{ width: 1200, height: 1200 }, MOBILE]) {
        await page.setViewportSize(viewport)
        for (const colorScheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme })
          await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(colorScheme)
          await extension.scrollIntoViewIfNeeded()
          const panelBox = await section.boundingBox()
          const extensionBox = await extension.boundingBox()
          expect(panelBox).not.toBeNull()
          expect(extensionBox).not.toBeNull()
          expect(Math.abs(extensionBox!.x - panelBox!.x)).toBeLessThanOrEqual(1)
          expect(Math.abs(extensionBox!.width - panelBox!.width)).toBeLessThanOrEqual(1)
          expect(extensionBox!.y).toBeGreaterThanOrEqual(panelBox!.y + panelBox!.height)
          expect(extensionBox!.x).toBeGreaterThanOrEqual(0)
          expect(extensionBox!.x + extensionBox!.width).toBeLessThanOrEqual(viewport.width)
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width)
          const [extensionStyle, linkStyle] = await Promise.all([extension, linkCard].map(card => card.evaluate((element) => {
            const style = getComputedStyle(element)
            return {
              padding: style.padding, borderWidth: style.borderTopWidth, borderStyle: style.borderTopStyle,
              borderColor: style.borderTopColor, borderRadius: style.borderTopLeftRadius, background: style.backgroundColor,
            }
          })))
          expect(extensionStyle).toEqual(linkStyle)
          expect(extensionStyle?.padding).toBe('16px')
          expect(extensionStyle?.borderStyle).toBe('solid')
          expect(Number.parseFloat(extensionStyle!.borderWidth)).toBeGreaterThan(0)
          expect(Number.parseFloat(extensionStyle!.borderRadius)).toBeGreaterThan(0)
          const [extensionHeading, linkHeading] = await Promise.all([extension, linkCard].map(card => card.getByRole('heading').evaluate((element) => {
            const style = getComputedStyle(element)
            return {
              x: element.getBoundingClientRect().x, fontSize: style.fontSize,
              fontWeight: style.fontWeight, lineHeight: style.lineHeight,
            }
          })))
          expect(extensionHeading).toEqual(linkHeading)
          expect(extensionHeading).toMatchObject({ fontSize: '14px', fontWeight: '500', lineHeight: '22px' })
          const code = extension.locator('dl code')
          expect(await code.evaluate(element => getComputedStyle(element).overflowWrap)).toBe('anywhere')
          const codeBox = await code.boundingBox()
          expect(codeBox).not.toBeNull()
          expect(codeBox!.x).toBeGreaterThanOrEqual(extensionBox!.x + 16)
          expect(codeBox!.x + codeBox!.width).toBeLessThanOrEqual(extensionBox!.x + extensionBox!.width - 16)
          expect(await details.isChecked()).toBe(true)
          if (screenshots !== undefined) await page.screenshot({
            path: join(screenshots, `extensions-${viewport.width === MOBILE.width ? 'mobile' : 'desktop'}-${colorScheme}.png`),
          })
        }
      }
      await page.setViewportSize({ width: 1200, height: 1200 })
      await page.emulateMedia({ colorScheme: 'light' })

      const replacement = await scaffold.ctx.loader.create({ name: '@fixture/remote-connection' })
      await custom.waitFor()
      expect(await nav.count()).toBe(1)
      expect(await section.count()).toBe(0)
      expect(await page.getByRole('region', { name: '配对申请', exact: true }).count()).toBe(0)
      expect(await details.isChecked()).toBe(true)
      expect(await extension.getByRole('status', { name: '附加选项中的邀请编号' }).textContent()).toBe(invitationId)
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
      await section.getByRole('region', { name: '配对申请', exact: true }).waitFor()
      expect(await nav.count()).toBe(1)
      expect(await custom.count()).toBe(0)
      expect(await svg.innerHTML()).toBe(initialSvg)
      expect(await details.isChecked()).toBe(true)
      scaffold.ctx.loader.remove(additional)
      await extension.waitFor({ state: 'detached' })
      await expect.poll(() => page.locator('style[data-plugin="@fixture/remote-connection-extension"]').count()).toBe(0)
      expect(await nav.count()).toBe(1)
      expect(await svg.innerHTML()).toBe(initialSvg)
      expect(await section.getByRole('button', { name: '复制链接', exact: true }).isEnabled()).toBe(true)

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
