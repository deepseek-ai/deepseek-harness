/** An anonymous browser enters the shipped application only after settings approval. */
import { fileURLToPath } from 'node:url'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium, type Locator, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode,
} from './scaffold.ts'
import { launchRemoteConnectionFixture } from './remote-connection-fixture.ts'
import { openSettings, ZH_BROWSER_LOCALE } from './support.ts'

const spoofedSourceIp = '198.51.100.42'
const spoofedSourceHeaders = {
  forwarded: `for=${spoofedSourceIp}`,
  'x-forwarded-for': spoofedSourceIp,
  'x-real-ip': spoofedSourceIp,
}

async function expectObservedSource(requests: Locator, authority: string): Promise<void> {
  const content = await requests.innerText()
  expect(content).toContain('来源 IP')
  expect(content).toContain('127.0.0.1')
  expect(content).not.toContain(authority)
  expect(content).not.toContain(spoofedSourceIp)
}

async function readPairingCodes(page: Page, baseUrl: string): Promise<{ status: number; codes: (string | undefined)[] | undefined }> {
  const response = await page.request.post(new URL('api/remoteConnection/pairingRequests', baseUrl).href, {
    data: { type: 'client-request', rpcId: 'pairing-list-observation', method: 'remoteConnection/pairingRequests', payload: { args: {} } },
  })
  try {
    const list: unknown = await response.json()
    const result: unknown = typeof list === 'object' && list !== null ? Reflect.get(list, 'result') : undefined
    const value: unknown = typeof result === 'object' && result !== null ? Reflect.get(result, 'value') : undefined
    const rows: unknown = typeof value === 'object' && value !== null ? Reflect.get(value, 'requests') : undefined
    const codes = Array.isArray(rows) ? rows.map((row: unknown) => {
      const code: unknown = typeof row === 'object' && row !== null ? Reflect.get(row, 'code') : undefined
      return typeof code === 'string' ? code : undefined
    }) : undefined
    return { status: response.status(), codes }
  } finally { await response.dispose() }
}

async function decideWithDelayedList(page: Page, requests: Locator, code: string, decision: 'allow' | 'deny'): Promise<string> {
  const releaseStaleRead = Promise.withResolvers<undefined>()
  const releaseFreshReads = Promise.withResolvers<undefined>()
  let readCount = 0
  let staleRead: { method: string; request: unknown; response: unknown } | undefined
  let staleReadSettled = false
  let freshReadStarted = false
  const routeErrors: unknown[] = []
  await page.route('**/api/remoteConnection/pairingRequests', async (route) => {
    const stale = readCount++ === 0
    let handlingStarted = false
    try {
      if (stale) {
        const response = await route.fetch()
        staleRead = {
          method: route.request().method(), request: route.request().postDataJSON(), response: await response.json(),
        }
        await releaseStaleRead.promise
        handlingStarted = true
        if (route.request().failure()?.errorText === 'net::ERR_ABORTED') await route.abort('aborted')
        else await route.fulfill({ response })
      } else {
        freshReadStarted = true
        await releaseFreshReads.promise
        handlingStarted = true
        if (route.request().failure()?.errorText === 'net::ERR_ABORTED') await route.abort('aborted')
        else await route.continue()
      }
    } catch (error) {
      if (route.request().failure()?.errorText !== 'net::ERR_ABORTED') routeErrors.push(error)
      if (!handlingStarted) {
        try { await route.abort('failed') } catch (abortError) { routeErrors.push(abortError) }
      }
    } finally {
      if (stale) staleReadSettled = true
    }
  })
  try {
    await expect.poll(() => staleRead !== undefined || routeErrors.length > 0, { timeout: 15_000 }).toBe(true)
    expect(routeErrors).toEqual([])
    expect(staleRead?.method).toBe('POST')
    expect(staleRead?.request).toMatchObject({ payload: { args: {} } })
    expect(staleRead?.response).toMatchObject({ result: {
      ok: true, value: { requests: [{ code: code.replace(' ', '') }] },
    } })
    await requests.getByRole('button', { name: decision === 'allow' ? '批准' : '拒绝', exact: true }).click()
    const notice = page.getByRole('alert').filter({ hasText: decision === 'allow' ? '已批准申请' : '已拒绝申请' })
    await notice.waitFor()
    expect(await requests.getByText(code, { exact: true }).count()).toBe(0)
    const snapshot = (await Promise.all([requests.ariaSnapshot(), notice.ariaSnapshot()])).join('\n')
    releaseStaleRead.resolve(undefined)
    await expect.poll(() => staleReadSettled, { timeout: 15_000 }).toBe(true)
    await expect.poll(() => freshReadStarted, { timeout: 15_000 }).toBe(true)
    expect(await requests.getByText(code, { exact: true }).count()).toBe(0)
    return snapshot
  } finally {
    releaseStaleRead.resolve(undefined)
    releaseFreshReads.resolve(undefined)
    await page.unrouteAll({ behavior: 'wait' })
    expect(routeErrors).toEqual([])
  }
}

it('lets a paired mobile browser approve another device and keeps denied or cancelled applicants signed out behind a public mount', async () => {
  const scaffold = await launchWebScaffold({
    publicMount: { prefix: '/tools/dsh/' },
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  try {
    const owner = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 1000 } })
    await owner.goto(scaffold.authenticatedUrl)
    await owner.waitForFunction(() => '__DSH_BOOT__' in window)
    expect((await owner.context().cookies()).some(cookie => cookie.name.startsWith('dsh-auth-') && cookie.httpOnly)).toBe(true)
    await openSettings(owner, 'zh')
    const navigation = owner.getByRole('dialog', { name: '设置', exact: true })
      .getByRole('button', { name: '远程连接', exact: true })
    await expect.poll(() => navigation.count()).toBe(1)
    await navigation.click()
    const approvals = owner.getByRole('region', { name: '远程连接', exact: true })
      .getByRole('region', { name: '配对申请', exact: true })
    await approvals.waitFor()

    const applicant = await browser.newPage({
      locale: ZH_BROWSER_LOCALE, viewport: { width: 390, height: 844 },
      extraHTTPHeaders: spoofedSourceHeaders,
    })
    const errors: string[] = []
    applicant.on('pageerror', error => errors.push(error.message))
    const anonymousScript = applicant.waitForResponse(response => response.url() === new URL('pairing/client.js', scaffold.baseUrl).href)
    expect((await applicant.goto(scaffold.baseUrl))?.status()).toBe(401)
    expect((await anonymousScript).status()).toBe(200)
    expect(await applicant.evaluate(() => customElements.get('dsh-device-pairing') !== undefined)).toBe(true)
    expect(await applicant.evaluate(() => '__ModuleLoader__' in window)).toBe(false)
    await applicant.locator('#auth-pair-request').click()
    await applicant.locator('#auth-pair-code').waitFor()
    const previousCode = await applicant.locator('#auth-pair-code').innerText()
    await approvals.getByText(previousCode, { exact: true }).waitFor()
    const countdown = applicant.locator('#auth-pair-countdown')
    const initialCountdown = await countdown.innerText()
    expect(initialCountdown).toMatch(/\d+:\d{2}/u)
    await expect.poll(() => countdown.innerText()).not.toBe(initialCountdown)
    const [replacementResponse] = await Promise.all([
      applicant.waitForResponse(response => new URL(response.url()).pathname.endsWith('/pairing/request')),
      applicant.getByRole('button', { name: '重新申请', exact: true }).click(),
    ])
    await expect.poll(() => applicant.locator('#auth-pair-code').innerText()).not.toBe(previousCode)
    await applicant.locator('#auth-pair-panel[data-state="waiting"]').waitFor()
    const code = await applicant.locator('#auth-pair-code').innerText()
    expect(code).toMatch(/^[A-Z2-9]{4} [A-Z2-9]{4}$/u)
    await approvals.getByText(previousCode, { exact: true }).waitFor({ state: 'detached' })
    await approvals.getByText(code, { exact: true }).waitFor()
    expect(await replacementResponse.request().allHeaders()).toMatchObject(spoofedSourceHeaders)
    const ticket: unknown = await replacementResponse.json()
    expect(ticket).toMatchObject({ code: code.replace(' ', ''), sourceIp: '127.0.0.1', authority: new URL(scaffold.baseUrl).origin })
    await expectObservedSource(approvals, new URL(scaffold.baseUrl).host)
    expect(await applicant.evaluate(() => '__DSH_BOOT__' in window)).toBe(false)
    expect((await applicant.context().cookies()).filter(cookie => /^dsh-(?:auth|remote)-/u.test(cookie.name))).toEqual([])
    expect(await applicant.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

    const screenshotDirectory = process.env.DSH_PAIRING_SCREENSHOT_DIR
    if (screenshotDirectory !== undefined) {
      await applicant.emulateMedia({ colorScheme: 'light' })
      await expect.poll(() => applicant.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe('rgb(250, 250, 250)')
      await applicant.screenshot({ path: join(screenshotDirectory, 'auth-request-light.png'), fullPage: true })
      await applicant.emulateMedia({ colorScheme: 'dark' })
      await expect.poll(() => applicant.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe('rgb(23, 23, 23)')
      await applicant.screenshot({ path: join(screenshotDirectory, 'auth-request-dark.png'), fullPage: true })
      await applicant.emulateMedia({ colorScheme: null })
    }

    const mode = webSnapshotMode()
    const applicationUrl = new URL(scaffold.authenticatedUrl)
    const tokenPlaceholder = `${applicationUrl.origin}${applicationUrl.pathname}?token=xxx`
    expect(await applicant.locator('#token').getAttribute('placeholder')).toBe(tokenPlaceholder)
    await compareOrRefreshGolden(
      fileURLToPath(new URL('./expected/device-pairing/request.expected.md', import.meta.url)),
      (await captureStableAria(applicant, 'main', scaffold.workspaceCwd, {
        replacements: [
          [tokenPlaceholder, '{{application-url}}?token=xxx'],
          [code, '{{pairing-code}}'], [new URL(scaffold.baseUrl).host, '{{authority}}'],
        ],
      })).replace(/\d+:\d{2}/gu, '{{remaining}}'), mode,
    )
    await compareOrRefreshGolden(
      fileURLToPath(new URL('./expected/device-pairing/approval.expected.md', import.meta.url)),
      (await approvals.ariaSnapshot()).replaceAll(code, '{{pairing-code}}'), mode,
    )

    const approvedDecision = await decideWithDelayedList(owner, approvals, code, 'allow')
    await applicant.waitForFunction(() => '__DSH_BOOT__' in window)
    expect(applicant.url()).toBe(scaffold.baseUrl)
    expect((await applicant.context().cookies()).some(cookie => cookie.name.startsWith('dsh-remote-') && cookie.httpOnly)).toBe(true)
    expect((await applicant.reload())?.status()).toBe(200)
    await applicant.waitForFunction(() => '__DSH_BOOT__' in window)

    await openSettings(applicant, 'zh')
    await applicant.getByRole('dialog', { name: '设置', exact: true })
      .getByRole('button', { name: '远程连接', exact: true }).click()
    const mobileSection = applicant.getByRole('region', { name: '远程连接', exact: true })
    const mobileApprovals = mobileSection.getByRole('region', { name: '配对申请', exact: true })
    await mobileApprovals.waitFor()
    expect(await mobileSection.getByRole('img', { name: '一次性登录二维码', exact: true }).count()).toBe(0)

    const third = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 390, height: 844 } })
    third.on('pageerror', error => errors.push(error.message))
    expect((await third.goto(scaffold.baseUrl))?.status()).toBe(401)
    await third.getByRole('button', { name: '申请配对', exact: true }).click()
    await third.locator('#auth-pair-code').waitFor()
    const thirdCode = await third.locator('#auth-pair-code').innerText()
    await mobileApprovals.getByText(thirdCode, { exact: true }).waitFor()
    await expectObservedSource(mobileApprovals, new URL(scaffold.baseUrl).host)
    expect(await third.evaluate(() => '__DSH_BOOT__' in window)).toBe(false)
    expect((await third.context().cookies()).filter(cookie => /^dsh-(?:auth|remote)-/u.test(cookie.name))).toEqual([])
    expect(await applicant.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await third.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (screenshotDirectory !== undefined) {
      await applicant.emulateMedia({ colorScheme: 'light' })
      await expect.poll(() => applicant.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('light')
      await applicant.screenshot({ path: join(screenshotDirectory, 'pairing-light.png'), fullPage: true })
      await applicant.emulateMedia({ colorScheme: 'dark' })
      await expect.poll(() => applicant.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark')
      await applicant.screenshot({ path: join(screenshotDirectory, 'pairing-dark.png'), fullPage: true })
      await applicant.emulateMedia({ colorScheme: null })
    }
    await mobileApprovals.getByRole('button', { name: '批准', exact: true }).click()
    await third.waitForFunction(() => '__DSH_BOOT__' in window)
    expect(third.url()).toBe(scaffold.baseUrl)
    expect((await third.context().cookies()).some(cookie => cookie.name.startsWith('dsh-remote-') && cookie.httpOnly)).toBe(true)
    expect((await third.reload())?.status()).toBe(200)
    await third.waitForFunction(() => '__DSH_BOOT__' in window)
    await mobileApprovals.getByText(thirdCode, { exact: true }).waitFor({ state: 'detached' })
    expect(await third.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(errors).toEqual([])

    const denied = await browser.newPage({ locale: ZH_BROWSER_LOCALE })
    expect((await denied.goto(scaffold.baseUrl))?.status()).toBe(401)
    await denied.locator('#auth-pair-request').click()
    await denied.locator('#auth-pair-code').waitFor()
    const deniedCode = await denied.locator('#auth-pair-code').innerText()
    await approvals.getByText(deniedCode, { exact: true }).waitFor()
    const deniedDecision = await decideWithDelayedList(owner, approvals, deniedCode, 'deny')
    await compareOrRefreshGolden(
      fileURLToPath(new URL('./expected/device-pairing/decision.expected.md', import.meta.url)),
      [approvedDecision, deniedDecision].join('\n'), mode,
    )
    await denied.locator('#auth-pair-panel[data-state="denied"]').waitFor()
    expect(await denied.evaluate(() => '__DSH_BOOT__' in window)).toBe(false)
    expect((await denied.context().cookies()).filter(cookie => /^dsh-(?:auth|remote)-/u.test(cookie.name))).toEqual([])

    await denied.getByRole('button', { name: '重新申请', exact: true }).click()
    await denied.locator('#auth-pair-panel[data-state="waiting"]').waitFor()
    const cancelledCode = await denied.locator('#auth-pair-code').innerText()
    await approvals.getByText(cancelledCode, { exact: true }).waitFor()
    await denied.locator('#auth-pair-cancel').click()
    await denied.getByRole('button', { name: '申请配对', exact: true }).waitFor()
    expect(await denied.locator('#auth-pair-panel').isHidden()).toBe(true)
    await approvals.getByText(cancelledCode, { exact: true }).waitFor({ state: 'detached' })
    expect((await denied.context().cookies()).filter(cookie => /^dsh-(?:auth|remote)-/u.test(cookie.name))).toEqual([])
    expect((await denied.reload())?.status()).toBe(401)

    for (const decision of ['allow', 'deny'] as const) {
      const unconfirmed = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 390, height: 844 } })
      unconfirmed.on('pageerror', error => errors.push(error.message))
      expect((await unconfirmed.goto(scaffold.baseUrl))?.status()).toBe(401)
      const creation = unconfirmed.waitForResponse(response => new URL(response.url()).pathname.endsWith('/pairing/request') && response.status() === 200)
      await unconfirmed.getByRole('button', { name: '申请配对', exact: true }).click()
      await unconfirmed.locator('#auth-pair-code').waitFor()
      const unconfirmedCode = await unconfirmed.locator('#auth-pair-code').innerText()
      const created = await creation
      const ticket: unknown = await created.json()
      const submitted: unknown = created.request().postDataJSON()
      if (typeof ticket !== 'object' || ticket === null || typeof submitted !== 'object' || submitted === null) {
        throw new Error('Pairing creation did not exchange credential records')
      }
      expect(Reflect.get(ticket, 'id') === Reflect.get(submitted, 'id') && Reflect.get(ticket, 'secret') === Reflect.get(submitted, 'secret')).toBe(true)
      expect(Reflect.get(ticket, 'code')).toBe(unconfirmedCode.replace(' ', ''))
      const observed = await readPairingCodes(owner, scaffold.baseUrl)
      expect(observed.status).toBe(200)
      expect(observed.codes).toContain(unconfirmedCode.replace(' ', ''))
      try { await approvals.getByText(unconfirmedCode, { exact: true }).waitFor() }
      catch (error) {
        const current = await readPairingCodes(owner, scaffold.baseUrl)
        console.info('pairing approval list before dropped decision', { decision, code: unconfirmedCode, ...current, content: await approvals.innerText(), errors })
        throw error
      }
      expect((await unconfirmed.context().cookies()).filter(cookie => /^dsh-(?:auth|remote)-/u.test(cookie.name))).toEqual([])

      const decisionDropped = Promise.withResolvers<undefined>()
      const routeErrors: unknown[] = []
      let committedResponse: unknown
      await owner.route('**/api/remoteConnection/decidePairing', async (route) => {
        try {
          const response = await route.fetch()
          committedResponse = await response.json()
          expect(response.status()).toBe(200)
        } catch (error) {
          routeErrors.push(error)
        } finally {
          try { await route.abort('failed') } catch (error) { routeErrors.push(error) }
          decisionDropped.resolve(undefined)
        }
      })
      try {
        await approvals.getByRole('button', { name: decision === 'allow' ? '批准' : '拒绝', exact: true }).click()
        await decisionDropped.promise
        expect(routeErrors).toEqual([])
        expect(committedResponse).toMatchObject({ result: { ok: true, value: decision === 'allow' ? 'approved' : 'denied' } })
        await owner.getByRole('alert').filter({ hasText: '无法确认审批结果，请刷新列表后再试' }).waitFor()
        expect(await owner.getByRole('alert').filter({ hasText: '已批准申请' }).count()).toBe(0)
        expect(await owner.getByRole('alert').filter({ hasText: '已拒绝申请' }).count()).toBe(0)
        if (decision === 'allow') {
          await unconfirmed.waitForFunction(() => '__DSH_BOOT__' in window)
          expect(unconfirmed.url()).toBe(scaffold.baseUrl)
          expect((await unconfirmed.context().cookies()).some(cookie => cookie.name.startsWith('dsh-remote-') && cookie.httpOnly)).toBe(true)
          expect((await unconfirmed.reload())?.status()).toBe(200)
          await unconfirmed.waitForFunction(() => '__DSH_BOOT__' in window)
        } else {
          await unconfirmed.locator('#auth-pair-panel[data-state="denied"]').waitFor()
          expect(await unconfirmed.evaluate(() => '__DSH_BOOT__' in window)).toBe(false)
          expect((await unconfirmed.context().cookies()).filter(cookie => /^dsh-(?:auth|remote)-/u.test(cookie.name))).toEqual([])
          expect((await unconfirmed.reload())?.status()).toBe(401)
        }
        await approvals.getByText(unconfirmedCode, { exact: true }).waitFor({ state: 'detached' })
      } finally {
        await owner.unrouteAll({ behavior: 'wait' })
        expect(routeErrors).toEqual([])
      }
    }
    expect(errors).toEqual([])
  } finally {
    await browser.close()
  }
})

it('keeps one Remote connection panel, its QR invitation, and login link while another browser requests approval', async () => {
  const fixture = await launchRemoteConnectionFixture(false)
  onTestFinished(() => fixture.close())
  const browser = await chromium.launch({
    proxy: { server: 'http://127.0.0.1:9', bypass: '*' },
    args: ['--host-resolver-rules=MAP qr-login.test 127.0.0.1'],
  })
  try {
    const owner = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 1440, height: 1000 } })
    await owner.goto(fixture.authenticatedUrl)
    await openSettings(owner, 'zh')
    const navigation = owner.getByRole('dialog', { name: '设置', exact: true })
      .getByRole('button', { name: '远程连接', exact: true })
    await expect.poll(() => navigation.count()).toBe(1)
    await navigation.click()
    const section = owner.getByRole('region', { name: '远程连接', exact: true })
    const loginLink = section.getByRole('region', { name: '访问地址', exact: true }).locator('code')
    await expect.poll(() => loginLink.innerText()).toBe(fixture.authenticatedUrl)
    const approvals = section.getByRole('region', { name: '配对申请', exact: true })
    await approvals.waitFor()
    const created = owner.waitForResponse(response => new URL(response.url()).pathname === '/api/remoteConnection/create')
    await section.getByRole('button', { name: '生成二维码', exact: true }).click()
    const invitation = await (await created).json() as { result: { ok: boolean; value: { url: string } } }
    expect(invitation.result.ok).toBe(true)
    const qr = section.getByRole('img', { name: '一次性登录二维码', exact: true })
    await qr.waitFor()
    const qrMarkup = await qr.innerHTML()

    const applicant = await browser.newPage({
      locale: ZH_BROWSER_LOCALE, viewport: { width: 390, height: 844 }, extraHTTPHeaders: spoofedSourceHeaders,
    })
    expect((await applicant.goto(fixture.url))?.status()).toBe(401)
    await applicant.getByRole('button', { name: '申请配对', exact: true }).click()
    await applicant.locator('#auth-pair-code').waitFor()
    const previousCode = await applicant.locator('#auth-pair-code').innerText()
    await approvals.getByText(previousCode, { exact: true }).waitFor()
    const countdown = applicant.locator('#auth-pair-countdown')
    const initialCountdown = await countdown.innerText()
    await expect.poll(() => countdown.innerText()).not.toBe(initialCountdown)

    const pairingListUrl = new URL('api/remoteConnection/pairingRequests', fixture.url).href
    await owner.route(pairingListUrl, route => route.fulfill({ status: 503 }))
    const readFailure = approvals.getByRole('alert')
    await readFailure.waitFor()
    expect(await approvals.getByText(previousCode, { exact: true }).count()).toBe(0)
    expect(await approvals.getByRole('note').count()).toBe(0)
    expect(await approvals.getByRole('status').count()).toBe(0)
    const retry = approvals.getByRole('button', { name: '重试', exact: true })
    expect(await retry.isEnabled()).toBe(true)
    await compareOrRefreshGolden(
      fileURLToPath(new URL('./expected/device-pairing/approval-refresh-failed.expected.md', import.meta.url)),
      await approvals.ariaSnapshot(), webSnapshotMode(),
    )

    const [replacementResponse] = await Promise.all([
      applicant.waitForResponse(response => new URL(response.url()).pathname.endsWith('/pairing/request')),
      applicant.getByRole('button', { name: '重新申请', exact: true }).click(),
    ])
    await applicant.locator('#auth-pair-panel[data-state="waiting"]').waitFor()
    await expect.poll(() => applicant.locator('#auth-pair-code').innerText()).not.toBe(previousCode)
    const code = await applicant.locator('#auth-pair-code').innerText()
    await owner.unroute(pairingListUrl)
    await retry.click()
    await approvals.getByText(code, { exact: true }).waitFor()
    expect(await approvals.getByText(previousCode, { exact: true }).count()).toBe(0)
    expect(await readFailure.count()).toBe(0)
    await approvals.getByRole('note').waitFor()
    expect(await replacementResponse.request().allHeaders()).toMatchObject(spoofedSourceHeaders)
    const ticket: unknown = await replacementResponse.json()
    expect(ticket).toMatchObject({ code: code.replace(' ', ''), sourceIp: '127.0.0.1', authority: new URL(fixture.url).origin })
    await expectObservedSource(approvals, new URL(fixture.url).host)
    expect(await qr.innerHTML()).toBe(qrMarkup)
    expect(await section.getByRole('button', { name: '重新生成', exact: true }).isEnabled()).toBe(true)
    expect(await section.getByRole('button', { name: '取消', exact: true }).isEnabled()).toBe(true)
    expect(await navigation.count()).toBe(1)
    expect(await approvals.getByRole('button').allTextContents()).toEqual(['批准', '拒绝'])
    for (const width of [1440, 390]) {
      await owner.setViewportSize({ width, height: 1000 })
      await approvals.scrollIntoViewIfNeeded()
      const codeBounds = (await approvals.locator('code').boundingBox())!
      const sourceIp = (await approvals.getByText('127.0.0.1', { exact: true }).boundingBox())!
      const approve = (await approvals.getByRole('button', { name: '批准', exact: true }).boundingBox())!
      const deny = (await approvals.getByRole('button', { name: '拒绝', exact: true }).boundingBox())!
      expect(approve.height).toBe(28)
      expect(deny.height).toBe(28)
      if (width === 1440) {
        expect(approve.x).toBeGreaterThan(codeBounds.x + codeBounds.width)
        expect(deny.x).toBeGreaterThan(approve.x + approve.width)
        expect(approve.y).toBe(deny.y)
        const informationCenter = (codeBounds.y + sourceIp.y + sourceIp.height) / 2
        expect(Math.abs(informationCenter - approve.y - approve.height / 2)).toBeLessThanOrEqual(1)
      } else {
        expect(approve.y).toBeGreaterThanOrEqual(sourceIp.y + sourceIp.height)
        expect(deny.y).toBeGreaterThanOrEqual(approve.y + approve.height)
        expect(approve.x).toBe(deny.x)
        expect(approve.width).toBe(deny.width)
      }
    }
    await owner.setViewportSize({ width: 1440, height: 1000 })
    await compareOrRefreshGolden(
      fileURLToPath(new URL('./expected/device-pairing/coexistence.expected.md', import.meta.url)),
      (await captureStableAria(owner, 'section[aria-label="远程连接"]', fixture.root, {
        replacements: [[fixture.authenticatedUrl, '{{access-address}}?token={{login-token}}'], [fixture.url, '{{access-address}}'], [code, '{{pairing-code}}']],
      })).replace(/\d+ 秒后过期/gu, '{{seconds}} 秒后过期'), webSnapshotMode(),
    )

    await approvals.getByRole('button', { name: '批准', exact: true }).click()
    await applicant.waitForFunction(() => '__DSH_BOOT__' in window)
    expect(applicant.url()).toBe(fixture.url)
    expect((await applicant.context().cookies()).some(cookie => cookie.name.startsWith('dsh-remote-') && cookie.httpOnly)).toBe(true)
    expect(await qr.innerHTML()).toBe(qrMarkup)
    expect(await loginLink.innerText()).toBe(fixture.authenticatedUrl)

    const scanning = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 390, height: 844 } })
    const exchanged = scanning.waitForResponse(response => new URL(response.url()).pathname === '/' && new URL(response.url()).searchParams.get('login') === 'qr'
      && response.request().method() === 'POST')
    await scanning.goto(invitation.result.value.url)
    expect((await exchanged).status()).toBe(204)
    await scanning.waitForFunction(() => '__DSH_BOOT__' in window)
    expect(scanning.url()).toBe(fixture.url)
    expect((await scanning.context().cookies()).some(cookie => cookie.name.startsWith('dsh-remote-') && cookie.httpOnly)).toBe(true)
    await section.getByText('二维码已使用，请在手机上确认是否已登录', { exact: true }).waitFor()
    expect(await navigation.count()).toBe(1)
  } finally { await browser.close() }
})

it('shows expiry and lets the applicant start a new request without signing in', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pairing-expiry-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const overlay = join(root, 'pairing.yml')
  await writeFile(overlay, '- id: remote-connection\n  config:\n    pairing:\n      requestTtlMs: 3000\n      pollIntervalMs: 500\n')
  const scaffold = await launchWebScaffold({
    extraOverlayPath: [fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)), overlay],
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  try {
    const applicant = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 390, height: 844 } })
    expect((await applicant.goto(scaffold.baseUrl))?.status()).toBe(401)
    await applicant.getByRole('button', { name: '申请配对', exact: true }).click()
    await applicant.locator('#auth-pair-code').waitFor()
    const expiredCode = await applicant.locator('#auth-pair-code').innerText()
    await applicant.locator('#auth-pair-panel[data-state="expired"]').waitFor()
    expect(await applicant.evaluate(() => '__DSH_BOOT__' in window)).toBe(false)
    expect((await applicant.context().cookies()).filter(cookie => /^dsh-(?:auth|remote)-/u.test(cookie.name))).toEqual([])
    await applicant.getByRole('button', { name: '重新申请', exact: true }).click()
    await applicant.locator('#auth-pair-code').waitFor()
    expect(await applicant.locator('#auth-pair-code').innerText()).not.toBe(expiredCode)
    await applicant.locator('#auth-pair-cancel').click()
    await applicant.getByRole('button', { name: '申请配对', exact: true }).waitFor()
    expect(await applicant.locator('#auth-pair-panel').isHidden()).toBe(true)
  } finally { await browser.close() }
})


it('keeps Token and pairing usable on the same page after a QR exchange fails', async () => {
  const fixture = await launchRemoteConnectionFixture(false)
  onTestFinished(() => fixture.close())
  const browser = await chromium.launch({
    proxy: { server: 'http://127.0.0.1:9', bypass: '*' },
    args: ['--host-resolver-rules=MAP qr-login.test 127.0.0.1'],
  })
  try {
    const applicant = await browser.newPage({ locale: ZH_BROWSER_LOCALE, viewport: { width: 390, height: 844 } })
    const errors: string[] = []
    applicant.on('pageerror', error => errors.push(error.message))
    const target = new URL(fixture.url)
    target.searchParams.set('login', 'qr')
    target.hash = 'a'.repeat(43)
    const exchanged = applicant.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/' && new URL(response.url()).searchParams.get('login') === 'qr')
    expect((await applicant.goto(target.href))?.status()).toBe(200)
    expect((await exchanged).status()).toBe(410)
    const failure = applicant.getByRole('alert').filter({ hasText: '二维码' })
    await failure.waitFor()
    expect(new URL(applicant.url()).hash).toBe('')
    expect(await applicant.evaluate(() => '__DSH_BOOT__' in window)).toBe(false)
    const token = applicant.locator('#token')
    expect(await token.isEnabled()).toBe(true)
    expect(await applicant.locator('#token-submit').isEnabled()).toBe(true)
    expect(await applicant.getByRole('button', { name: '申请配对', exact: true }).isEnabled()).toBe(true)
    const screenshotDirectory = process.env.DSH_PAIRING_SCREENSHOT_DIR
    if (screenshotDirectory !== undefined) await mkdir(screenshotDirectory, { recursive: true })
    for (const scene of [
      { name: 'mobile-light', width: 390, height: 844, colorScheme: 'light' },
      { name: 'mobile-dark', width: 390, height: 844, colorScheme: 'dark' },
      { name: 'desktop-light', width: 1440, height: 1000, colorScheme: 'light' },
    ] as const) {
      await applicant.setViewportSize({ width: scene.width, height: scene.height })
      await applicant.emulateMedia({ colorScheme: scene.colorScheme })
      const layout = await applicant.evaluate(() => {
        const form = document.querySelector<HTMLElement>('#token-form')!
        const pairing = document.querySelector<HTMLElement>('dsh-device-pairing')!
        const notice = document.querySelector<HTMLElement>('#qr-notice')!
        const title = document.querySelector<HTMLElement>('#title')!
        const formBox = form.getBoundingClientRect()
        const pairBox = pairing.getBoundingClientRect()
        return {
          sameContainer: form.parentElement === pairing.parentElement,
          feedbackOutside: notice.parentElement === form.parentElement?.parentElement,
          headingAbove: title.getBoundingClientRect().bottom <= notice.getBoundingClientRect().top,
          feedbackAbove: notice.getBoundingClientRect().bottom <= formBox.top,
          gap: pairBox.top - formBox.bottom,
          xDifference: pairBox.x - formBox.x,
          widthDifference: pairBox.width - formBox.width,
          borders: [form, pairing].map(card => Number.parseFloat(getComputedStyle(card).borderTopWidth)),
          parentBorder: Number.parseFloat(getComputedStyle(form.parentElement!).borderTopWidth),
          overflows: document.documentElement.scrollWidth > innerWidth,
        }
      })
      expect(layout).toMatchObject({
        sameContainer: true, feedbackOutside: true, headingAbove: true, feedbackAbove: true, overflows: false,
      })
      expect(Math.abs(layout.gap - 24)).toBeLessThanOrEqual(1)
      expect(Math.abs(layout.xDifference)).toBeLessThanOrEqual(1)
      expect(Math.abs(layout.widthDifference)).toBeLessThanOrEqual(1)
      expect(layout.borders.every(border => border > 0)).toBe(true)
      expect(layout.parentBorder).toBe(0)
      if (screenshotDirectory !== undefined) {
        await applicant.screenshot({
          path: join(screenshotDirectory, `qr-rejected-options-${scene.name}.png`), fullPage: true,
        })
      }
    }
    await applicant.setViewportSize({ width: 390, height: 844 })
    await applicant.getByRole('button', { name: '申请配对', exact: true }).click()
    await applicant.locator('#auth-pair-code').waitFor()
    expect(await applicant.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (screenshotDirectory !== undefined) {
      for (const colorScheme of ['light', 'dark'] as const) {
        await applicant.emulateMedia({ colorScheme })
        await applicant.screenshot({
          path: join(screenshotDirectory, `pairing-waiting-mobile-${colorScheme}.png`), fullPage: true,
        })
      }
    }
    expect(await token.isEnabled()).toBe(true)
    const launchToken = new URL(fixture.authenticatedUrl).searchParams.get('token')
    if (launchToken === null) throw new Error('Token entry did not publish a startup credential')
    await token.fill(launchToken)
    await applicant.locator('#token-submit').click()
    await applicant.waitForFunction(() => '__DSH_BOOT__' in window)
    expect(applicant.url()).toBe(fixture.url)
    expect((await applicant.context().cookies()).some(cookie => cookie.name.startsWith('dsh-auth-') && cookie.httpOnly)).toBe(true)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
  }
})
