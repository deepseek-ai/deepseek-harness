/** Real anonymous pages recover transport failures and replace requests without inheriting old approval. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { openSettings, ZH_BROWSER_LOCALE } from './support.ts'

it.each(['zh', 'en'])('recovers and replaces a request from the same browser and IP after repeated failures in %s', async (language) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pairing-recovery-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const overlay = join(root, 'pairing.yml')
  await writeFile(overlay, '- id: remote-connection\n  config:\n    pairing:\n      requestIntervalMs: 1\n      pollIntervalMs: 100\n      requestTimeoutMs: 1000\n      maxRetries: 2\n      retryMaxDelayMs: 400\n')
  const scaffold = await launchWebScaffold({
    publicMount: { prefix: '/tools/dsh/' },
    extraOverlayPath: [fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)), overlay],
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  try {
    const owner = await browser.newPage({ locale: ZH_BROWSER_LOCALE })
    await owner.goto(scaffold.authenticatedUrl)
    await owner.waitForFunction(() => '__DSH_BOOT__' in window)
    await openSettings(owner, 'zh')
    await owner.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '远程连接', exact: true }).click()
    const approvals = owner.getByRole('region', { name: '配对申请', exact: true })
    const applicant = await browser.newPage({ locale: language === 'zh' ? ZH_BROWSER_LOCALE : 'en-US', viewport: { width: 390, height: 844 } })
    const errors: string[] = []
    applicant.on('pageerror', error => errors.push(error.message))
    const oldRead = Promise.withResolvers<undefined>()
    const releaseOldRead = Promise.withResolvers<undefined>()
    const oldReadSettled = Promise.withResolvers<undefined>()
    let held = false
    await applicant.route('**/pairing/status', async (route) => {
      if (held) { await route.continue(); return }
      held = true
      const response = await route.fetch()
      oldRead.resolve(undefined)
      try {
        await releaseOldRead.promise
        if (route.request().failure()?.errorText === 'net::ERR_ABORTED') await route.abort('aborted')
        else await route.fulfill({ response })
      } finally { oldReadSettled.resolve(undefined) }
    })
    try {
      expect((await applicant.goto(scaffold.baseUrl))?.status()).toBe(401)
      await applicant.locator('#auth-pair-request').click()
      await applicant.locator('#auth-pair-code').waitFor()
      const original = await applicant.locator('#auth-pair-code').innerText()
      await approvals.getByText(original, { exact: true }).waitFor()
      await oldRead.promise
      await applicant.locator('#auth-pair-request').click()
      // Cancelling the previous request briefly clears its code before the replacement arrives.
      await expect.poll(async () => {
        const code = await applicant.locator('#auth-pair-code').innerText()
        return /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4} [23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/u.test(code) && code !== original
      }).toBe(true)
      const replacement = await applicant.locator('#auth-pair-code').innerText()
      await approvals.getByText(replacement, { exact: true }).waitFor()
      await expect.poll(() => approvals.getByText(original, { exact: true }).count()).toBe(0)
      releaseOldRead.resolve(undefined)
      await oldReadSettled.promise
      await applicant.unrouteAll({ behavior: 'wait' })
      expect(await applicant.evaluate(() => '__DSH_BOOT__' in window)).toBe(false)
      expect((await applicant.context().cookies()).filter(cookie => /^dsh-(?:auth|remote)-/u.test(cookie.name))).toEqual([])
      expect(await approvals.innerText()).toContain('127.0.0.1')

      await applicant.context().setOffline(true)
      await applicant.locator('#auth-pair-panel[data-state="error"]').waitFor()
      expect(await applicant.locator('#auth-pair-retry').count()).toBe(0)
      expect(await applicant.locator('#auth-pair-request').isEnabled()).toBe(true)
      const applicationUrl = new URL(scaffold.authenticatedUrl)
      const tokenPlaceholder = `${applicationUrl.origin}${applicationUrl.pathname}?token=xxx`
      expect(await applicant.locator('#token').getAttribute('placeholder')).toBe(tokenPlaceholder)
      await compareOrRefreshGolden(
        fileURLToPath(new URL(`./expected/device-pairing/recovery-error.${language}.expected.md`, import.meta.url)),
        await captureStableAria(applicant, 'main', scaffold.workspaceCwd, {
          replacements: [[tokenPlaceholder, '{{application-url}}?token=xxx'], [replacement, '{{pairing-code}}']],
        }),
        webSnapshotMode(),
      )
      const screenshots = process.env.DSH_PAIRING_SCREENSHOT_DIR
      if (screenshots !== undefined) {
        await mkdir(screenshots, { recursive: true })
        for (const theme of ['light', 'dark'] as const) {
          await applicant.emulateMedia({ colorScheme: theme })
          await applicant.screenshot({ path: join(screenshots, `recovery-${language}-${theme}.png`), fullPage: true })
        }
      }
      expect(await applicant.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await applicant.context().setOffline(false)
      await applicant.locator('#auth-pair-request').click()
      await expect.poll(async () => {
        const code = await applicant.locator('#auth-pair-code').innerText()
        return /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4} [23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/u.test(code) && code !== replacement
      }).toBe(true)
      const fresh = await applicant.locator('#auth-pair-code').innerText()
      await approvals.getByText(fresh, { exact: true }).waitFor()
      await expect.poll(() => approvals.getByText(replacement, { exact: true }).count()).toBe(0)
      const approved = owner.waitForResponse(response => new URL(response.url()).pathname.endsWith('/remoteConnection/decidePairing'))
      await approvals.getByRole('button', { name: '批准', exact: true }).click()
      await approved
      await applicant.waitForFunction(() => '__DSH_BOOT__' in window)
      expect(errors).toEqual([])
    } finally {
      releaseOldRead.resolve(undefined)
      await applicant.unrouteAll({ behavior: 'wait' })
    }
  } finally {
    await browser.close()
  }
})
