/** A delayed pairing result cannot undo the browser session already delivered by HTTP. */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { openSettings, ZH_BROWSER_LOCALE } from './support.ts'

it('recognizes a delivered browser session when the pairing result crosses the local deadline', async () => {
  const scaffold = await launchWebScaffold({
    publicMount: { prefix: '/tools/dsh/' },
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  try {
    const owner = await browser.newPage({ locale: ZH_BROWSER_LOCALE })
    await owner.goto(scaffold.authenticatedUrl)
    await owner.waitForFunction(() => '__DSH_BOOT__' in window)
    await openSettings(owner, 'zh')
    await owner.getByRole('dialog', { name: '设置', exact: true })
      .getByRole('button', { name: '远程连接', exact: true }).click()
    const approvals = owner.getByRole('region', { name: '远程连接', exact: true })
      .getByRole('region', { name: '配对申请', exact: true })
    await approvals.waitFor()

    const applicant = await browser.newPage({ locale: ZH_BROWSER_LOCALE })
    const errors: string[] = []
    let creations = 0
    applicant.on('pageerror', error => errors.push(error.message))
    applicant.on('request', (request) => {
      if (new URL(request.url()).pathname.endsWith('/pairing/request')) creations++
    })
    await applicant.clock.install()
    await applicant.addInitScript(() => {
      const nativeFetch = globalThis.fetch.bind(globalThis)
      const release = new Promise<void>((resolve) => {
        globalThis.addEventListener('release-pairing-completion', () => { resolve() }, { once: true })
      })
      const releaseCheck = new Promise<void>((resolve) => {
        globalThis.addEventListener('release-session-check', () => { resolve() }, { once: true })
      })
      globalThis.fetch = async (...args) => {
        const response = await nativeFetch(...args)
        if (args[1]?.method === 'HEAD' && response.url === new URL('.', document.baseURI).href) {
          document.documentElement.dataset.sessionCheckStatus = String(response.status)
          await releaseCheck
        }
        if (!new URL(response.url).pathname.endsWith('/pairing/status')) return response
        const nativeJson = response.json.bind(response)
        response.json = async () => {
          const value: unknown = await nativeJson()
          if (typeof value === 'object' && value !== null && Reflect.get(value, 'status') === 'completed') {
            document.documentElement.dataset.completionHeld = 'true'
            await release
            document.documentElement.dataset.completionReleased = 'true'
          }
          return value
        }
        return response
      }
    })
    expect((await applicant.goto(scaffold.baseUrl))?.status()).toBe(401)
    const created = applicant.waitForResponse(response => new URL(response.url()).pathname.endsWith('/pairing/request'))
    await applicant.getByRole('button', { name: '申请配对', exact: true }).click()
    const ticket = await (await created).json() as { expiresInMs: number }
    await applicant.locator('#auth-pair-code').waitFor()
    const code = await applicant.locator('#auth-pair-code').innerText()
    await approvals.getByText(code, { exact: true }).waitFor()
    await approvals.getByRole('button', { name: '批准', exact: true }).click()
    await expect.poll(() => applicant.evaluate(() => document.documentElement.dataset.completionHeld), { timeout: 15_000 }).toBe('true')

    const delivered = (await applicant.context().cookies()).some(cookie => cookie.name.startsWith('dsh-remote-') && cookie.httpOnly)
    const protectedResponse = await applicant.request.get(scaffold.baseUrl)
    const protectedStatus = protectedResponse.status()
    await protectedResponse.dispose()
    expect(delivered).toBe(true)
    expect(protectedStatus).toBe(200)
    expect(await applicant.evaluate(() => '__DSH_BOOT__' in window)).toBe(false)

    await applicant.clock.fastForward(ticket.expiresInMs)
    await expect.poll(() => applicant.evaluate(() => document.documentElement.dataset.sessionCheckStatus)).toBe('200')
    await applicant.locator('#auth-pair-panel[data-state="checking"]').waitFor()
    const applicationUrl = new URL(scaffold.authenticatedUrl)
    const tokenPlaceholder = `${applicationUrl.origin}${applicationUrl.pathname}?token=xxx`
    expect(await applicant.locator('#token').getAttribute('placeholder')).toBe(tokenPlaceholder)
    await compareOrRefreshGolden(
      fileURLToPath(new URL('./expected/device-pairing/completion-checking.expected.md', import.meta.url)),
      await captureStableAria(applicant, 'main', scaffold.workspaceCwd, {
        replacements: [[tokenPlaceholder, '{{application-url}}?token=xxx'], [code, '{{pairing-code}}']],
      }), webSnapshotMode(),
    )
    await applicant.evaluate(() => { globalThis.dispatchEvent(new Event('release-pairing-completion')) })
    await expect.poll(() => applicant.evaluate(() => document.documentElement.dataset.completionReleased)).toBe('true')
    expect(await applicant.locator('#auth-pair-panel').getAttribute('data-state')).toBe('checking')
    expect(await applicant.evaluate(() => '__DSH_BOOT__' in window)).toBe(false)
    expect(creations).toBe(1)

    await applicant.evaluate(() => { globalThis.dispatchEvent(new Event('release-session-check')) })
    await applicant.waitForFunction(() => '__DSH_BOOT__' in window)
    expect(applicant.url()).toBe(scaffold.baseUrl)
    expect(creations).toBe(1)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
  }
})
