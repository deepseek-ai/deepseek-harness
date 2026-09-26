// Real-composition acceptance for the user-side bonus notice. The scaffold boots the
// shipped Web Loader tree, so the real account provider issues the bonus HTTP requests
// and the real client renders the card in a real Chromium. The loopback Platform double
// is the observation point: the scenario asserts what the product sent and what the user
// could read on screen.
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { openSettings, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/bonus-notice', import.meta.url))
const OVERLAY_TEMPLATE = fileURLToPath(new URL('./fixtures/bonus-notice/cordis.patch.yml', import.meta.url))
const MODE = webSnapshotMode()

const TOKEN = 'dsh_bonus_notice_test'
const ACCOUNT_ID = 'bonus-user'
const ORDER_FIRST = '22222222-2222-4222-8222-222222222222'
const ORDER_LATER = '33333333-3333-4333-8333-333333333333'
const ORDER_EN = '44444444-4444-4444-8444-444444444444'
const ORDER_RETRY = '55555555-5555-4555-8555-555555555555'
const ORDER_REPEAT = '66666666-6666-4666-8666-666666666666'
const ORDER_TOPUP = '77777777-7777-4777-8777-777777777777'

const CLAIM_DAYS = 30

/** Eligibility window the double reports; neither the card nor the golden renders a date. */
function expiresAt(): string {
  return new Date(Date.now() + CLAIM_DAYS * 86_400_000).toISOString()
}

interface Granted {
  readonly orderId: string
  readonly amount: string
  readonly zh_CN: string
  readonly en_US: string
}

interface GetRecord {
  readonly locale: string | undefined
  readonly query: string
}

interface AckRecord {
  readonly method: string
  readonly path: string
  readonly locale: string | undefined
  readonly orderId: string | null
  readonly body: string
  readonly query: string
  readonly contentType: string | undefined
  /** Monotonic arrival time, so the backoff gap cannot be distorted by a wall-clock jump. */
  readonly at: number
}

/** Loopback Platform double: auth gate, profile, wallets, unnotified bonuses, and the acknowledgement. */
async function mockPlatform() {
  const unnotified: Granted[] = []
  const gets: GetRecord[] = []
  /** Reads already answered; a request the client is still awaiting is not evidence of a delivered response. */
  const served: GetRecord[] = []
  const acks: AckRecord[] = []
  /** Wallet reads, one per balance refresh the settings panel performs. */
  const summaries: GetRecord[] = []
  let normalBalance = '12.34'
  let bonusBalance = '5.00'
  /** Order whose acknowledgement attempts the double fails, and how many failures it still owes. */
  let ackFailure: { orderId: string; remaining: number } | undefined
  /** Whether an acknowledged order stays unnotified, as a backend that has not applied the acknowledgement would serve it. */
  let keepUnnotified = false
  /** Refuse the wallet read, which is how a Platform outage or an unparsable payload reaches the client. */
  let failSummary = false
  /** Reply held back while the test controls when a read can answer. */
  let heldReply: (() => void) | undefined
  const grant = (orderId: string, amount: string): void => {
    unnotified.unshift({
      orderId, amount,
      zh_CN: `已赠送您 ${amount} 元 DSH 体验赠金。`,
      en_US: `You received a CNY ${amount} DSH trial credit.`,
    })
  }
  /** @param value - granted bonus. @param locale - request language. @returns its wire fields. */
  const wire = (value: Granted, locale: string | undefined): unknown => ({
    order_id: value.orderId, campaign: 'dsh_login_bonus', amount: value.amount, currency: 'CNY',
    granted_at: new Date().toISOString(), expires_at: expiresAt(),
    msg: locale === 'en_US' ? value.en_US : value.zh_CN,
  })
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const header = req.headers['x-client-locale']
    const locale = typeof header === 'string' ? header : undefined
    const reply = (payload: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (req.headers['x-dsh-auth-token'] !== TOKEN) { res.writeHead(401).end(); return }
    if (url.pathname === '/auth-api/v0/users/current') {
      // `email` is required by the provider's profile schema even when the account has none.
      reply({ code: 0, data: { biz_code: 0, biz_data: {
        id: ACCOUNT_ID, email: '', id_profile: { name: 'Bonus User', picture: null },
      } } })
      return
    }
    if (url.pathname === '/api/v0/users/get_user_summary') {
      summaries.push({ locale, query: url.search })
      if (failSummary) { res.writeHead(500, { 'content-type': 'text/plain' }).end('Internal Server Error'); return }
      reply({ code: 0, data: { biz_code: 0, biz_data: {
        normal_wallets: [{ currency: 'CNY', balance: normalBalance }],
        bonus_wallets: [{ currency: 'CNY', balance: bonusBalance }],
      } } })
      return
    }
    if (url.pathname === '/api/v0/users/get_unnotified_bonuses') {
      const record = { locale, query: url.search }
      gets.push(record)
      const payload = { code: 0, data: { biz_code: 0, biz_data: unnotified.map(value => wire(value, locale)) } }
      const answer = (): void => { served.push(record); reply(payload) }
      if (heldReply === undefined) { answer(); return }
      heldReply = answer
      return
    }
    if (url.pathname === '/api/v0/users/ack_bonus_notified' && req.method === 'POST') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => { body += chunk })
      req.on('end', () => {
        const payload: unknown = JSON.parse(body)
        const orderId = typeof payload === 'object' && payload !== null && 'order_id' in payload
          && typeof payload.order_id === 'string' ? payload.order_id : null
        acks.push({ method: req.method ?? '', path: url.pathname, locale, orderId, body,
          query: url.search, contentType: req.headers['content-type'], at: performance.now() })
        if (ackFailure !== undefined && ackFailure.orderId === orderId && ackFailure.remaining > 0) {
          ackFailure.remaining--
          // A transient gateway failure: the client retries it after its backoff.
          res.writeHead(502, { 'content-type': 'text/plain' }).end('Internal Server Error')
          return
        }
        if (orderId === null) {
          reply({ code: 0, msg: '', data: { biz_code: 1, biz_msg: 'BONUS_ORDER_NOT_FOUND', biz_data: null } }); return
        }
        const index = unnotified.findIndex(value => value.orderId === orderId)
        if (index >= 0 && !keepUnnotified) unnotified.splice(index, 1)
        reply({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: null } })
      })
      return
    }
    if (url.pathname === '/auth-api/v0/users/logout') { reply({ code: 0, data: { biz_code: 0, biz_data: null } }); return }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('bonus notice: missing mock listener')
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    grant, gets, served, acks, summaries,
    /** @param value - recharge balance the settings page reads next. */
    setNormalBalance: (value: string): void => { normalBalance = value },
    /** @param value - bonus balance the settings page reads next. */
    setBonusBalance: (value: string): void => { bonusBalance = value },
    /** @param value - whether the wallet read fails. */
    setFailSummary: (value: boolean): void => { failSummary = value },
    /** Drop every unnotified grant, so a later scenario starts from a server with nothing to show. */
    clearUnnotified: (): void => { unnotified.length = 0 },
    /** @param value - whether acknowledged orders keep arriving in the unnotified read. */
    setKeepUnnotified: (value: boolean): void => { keepUnnotified = value },
    /** @param orderId - order to refuse. @param count - its acknowledgement attempts that fail before one succeeds. */
    failNextAcks: (orderId: string, count: number): void => { ackFailure = { orderId, remaining: count } },
    /** Hold the next unnotified-bonus read so the test can observe the in-flight state. */
    holdNextGet: (): void => { heldReply = () => undefined },
    releaseGet: (): void => { const held = heldReply; heldReply = undefined; held?.() },
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }),
  }
}

/** @param page - page under test. @returns every rendered bonus notice card. */
function noticeCards(page: Page): Locator {
  return page.locator('aside').filter({ hasText: '赠金已到账' })
}

/** @param card - a rendered notice card. @returns its non-empty visible lines joined for the golden. */
async function cardText(card: Locator): Promise<string> {
  return (await card.innerText()).split('\n').map(line => line.trim()).filter(line => line !== '').join(' / ')
}

/** Wait for the card carrying this copy, then return the text the user could read from it. */
async function shownNotice(page: Page, copy: string): Promise<string> {
  const card = noticeCards(page).filter({ hasText: copy })
  await card.waitFor({ state: 'visible', timeout: 30_000 })
  return cardText(card)
}

/** Wait for the double to answer this many acknowledgements, then return the order ids in arrival order. */
async function acked(platform: { acks: AckRecord[] }, count: number): Promise<string> {
  await expect.poll(() => platform.acks.length, { timeout: 30_000 }).toBe(count)
  return platform.acks.map(item => String(item.orderId)).join(',')
}

/**
 * Native Platform bridge calls recorded in one page. `setBounds` is resize-driven and is
 * deliberately not recorded, so the calls here are the opens and closes a user caused.
 * @param page - page under test.
 * @returns the recorded call log in order.
 */
async function platformCalls(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => (globalThis as typeof globalThis & { __bonusPlatformCalls?: readonly string[] })
    .__bonusPlatformCalls ?? [])
}

describe.skipIf(MODE === 'record')('web e2e: bonus notice', () => {
  let root: string | undefined
  let scaffold: WebScaffold
  let browser: Browser
  let platform: Awaited<ReturnType<typeof mockPlatform>>
  const tripwires: ReturnType<typeof watchConsole>[] = []

  /** @param locale - browser language driving the requested notice locale. @returns a desktop-renderer page. */
  const openDesktopPage = async (locale: string): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale })
    const opened = await context.newPage()
    tripwires.push(watchConsole(opened))
    await opened.addInitScript(() => {
      Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } })
      // The embedded Platform view is a native child window owned by the Desktop shell.
      // The double answers immediately and records the calls, so the scenario observes
      // which page was opened and that returning destroyed the view.
      const calls: string[] = []
      Object.defineProperty(globalThis, '__bonusPlatformCalls', { value: calls })
      Object.defineProperty(globalThis, 'dshPlatform', {
        value: {
          open: (page: string) => { calls.push(`open:${page}`); return Promise.resolve() },
          setBounds: () => Promise.resolve(),
          close: () => { calls.push('close'); return Promise.resolve() },
        },
      })
    })
    return opened
  }

  beforeAll(async () => {
    platform = await mockPlatform()
    platform.grant(ORDER_FIRST, '5.00')
    root = await mkdtemp(join(tmpdir(), 'dsh-bonus-notice-'))
    const home = join(root, 'home')
    await mkdir(home, { recursive: true })
    // A stored grant bound to the double's origin starts the account credential-stored
    // without driving the browser sign-in flow.
    await writeFile(join(home, '.credentials.yaml'),
      `version: 1\nrefs: {}\nrecords:\n  deepseek-account-platform/default:\n    kind: grant\n    payload:\n      version: 1\n      token: ${TOKEN}\n      issuer: ${platform.origin}\n`,
      { mode: 0o600 })
    const overlay = join(root, 'bonus-notice.overlay.yml')
    await writeFile(overlay, (await readFile(OVERLAY_TEMPLATE, 'utf8')).replaceAll('{{origin}}', platform.origin))
    scaffold = await launchWebScaffold({ harnessHome: home, extraOverlayPath: overlay })
    // Resolve the signed-in identity before opening the renderer. First profile discovery
    // emits another account frame, which would supersede the held startup bonus read.
    expect(await scaffold.ctx.deepseekAccount.getProfile({
      version: 'test', locale: 'zh-CN', timezoneOffsetSeconds: 28_800,
    })).toMatchObject({ status: 'ready', value: { id: ACCOUNT_ID } })
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await platform?.close()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  })

  it('acknowledges a notice shown under settings, refreshes once per entry, and localizes the request', async () => {
    const zhFirst = '已赠送您 5.00 元 DSH 体验赠金。'
    const zhLater = '已赠送您 8.00 元 DSH 体验赠金。'
    const enBonus = 'You received a CNY 9.00 DSH trial credit.'
    const observations: string[] = []
    const page = await openDesktopPage('zh-CN')
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bonus-notice'))
    /** @returns every browser storage key of the started page, so a baseline can be taken before a notice shows. */
    const storageKeys = (): Promise<string[]> => page.evaluate(() => Object.keys(localStorage).sort())

    // A read the renderer never received cannot become a displayed notice: while the
    // response is held there is no card and no acknowledgement.
    platform.holdNextGet()
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await expect.poll(() => platform.gets.length, { timeout: 30_000 }).toBe(1)
    observations.push(`startup.held cards=${String(await noticeCards(page).count())} acks=${String(platform.acks.length)}`)
    expect(await noticeCards(page).count()).toBe(0)
    expect(platform.acks).toEqual([])
    platform.releaseGet()

    // Startup signs in and reads the notice; the card shows it and only then is it acknowledged.
    observations.push(`startup.notice=${await shownNotice(page, zhFirst)}`)
    observations.push(`startup.ack orders=${await acked(platform, 1)}`)
    const get = platform.gets[0]!
    const ack = platform.acks[0]!
    observations.push(`startup.get locale=${String(get.locale)} query=${get.query}`)
    observations.push(`startup.ack method=${ack.method} path=${ack.path} locale=${String(ack.locale)} order_id=${String(ack.orderId)} body=${JSON.stringify(ack.body)}`)
    expect(get.locale).toBe('zh_CN')
    expect(get.query).toBe('')
    expect(ack).toMatchObject({
      method: 'POST', path: '/api/v0/users/ack_bonus_notified', locale: 'zh_CN', orderId: ORDER_FIRST,
      body: JSON.stringify({ order_id: ORDER_FIRST }), query: '', contentType: 'application/json',
    })

    // Closing the card only hides it; the acknowledgement already sent is not repeated.
    await noticeCards(page).getByRole('button', { name: '关闭', exact: true }).click()
    expect(await noticeCards(page).count()).toBe(0)
    expect(platform.acks).toHaveLength(1)

    // A new grant and balance arrive before settings opens; one panel entry refreshes both once.
    platform.grant(ORDER_LATER, '8.00')
    platform.setBonusBalance('13.00')
    const getsBefore = platform.gets.length
    const summariesBefore = platform.summaries.length
    // Hold the panel's notice read so the test observes its in-flight state instead of
    // racing a fast local response.
    platform.holdNextGet()
    await openSettings(page, 'zh')
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.waitFor()
    await expect.poll(() => platform.gets.length, { timeout: 30_000 }).toBe(getsBefore + 1)
    // One open, one read: no control in the panel drives a second one.
    expect(await settings.getByRole('button', { name: '刷新余额', exact: true }).count()).toBe(0)
    observations.push(`open.held cards=${String(await noticeCards(page).count())} acks=${String(platform.acks.length)} gets=${String(platform.gets.length - getsBefore)}`)
    expect(await noticeCards(page).count()).toBe(0)
    expect(platform.acks).toHaveLength(1)
    expect(platform.summaries.length).toBeGreaterThan(summariesBefore)
    platform.releaseGet()
    // The answered notice is displayed and acknowledged while the panel stays open.
    const openNotice = await shownNotice(page, zhLater)
    observations.push(`open.shown notice=${openNotice}`)
    observations.push(`open.shown ack orders=${await acked(platform, 2)}`)
    // Hit-testing the card's own point proves the settings layer paints above it.
    const paintedUnderOverlay = await noticeCards(page).filter({ hasText: zhLater }).evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 20)
      return hit !== null && !element.contains(hit) && hit.closest('[role="presentation"]') !== null
    })
    observations.push(`open.shown painted-under-settings=${String(paintedUnderOverlay)} cards=${String(await noticeCards(page).count())} acks=${String(platform.acks.length)}`)
    expect(paintedUnderOverlay).toBe(true)
    await expect.poll(async () => (await settings.textContent()) ?? '', { timeout: 30_000 }).toContain('¥13.00')
    // Still one read after the refresh settled.
    expect(platform.gets.length).toBe(getsBefore + 1)

    const openGet = platform.served.at(-1)!
    const panel = (await settings.textContent()) ?? ''
    const usage = await settings.getByRole('link', { name: '查询用量', exact: true }).getAttribute('href')
    observations.push(`open.get locale=${String(openGet.locale)} query=${openGet.query} served=true gets=${String(platform.gets.length - getsBefore)}`)
    observations.push(`open.balance bonus-row=${String(panel.includes('赠金余额'))} amount=${String(panel.includes('¥13.00'))} dated=${String(/\d{4}-\d{2}-\d{2}/.test(panel))}`)
    observations.push(`open.cards-while-open=${String(await noticeCards(page).count())} acks=${String(platform.acks.length)}`)
    observations.push(`open.usage-link=${String(usage).replace(platform.origin, '{{origin}}')}`)
    expect(openGet.locale).toBe('zh_CN')
    expect(openGet.query).toBe('')
    expect(panel).toContain('赠金余额')
    expect(panel).toContain('¥13.00')
    expect(panel).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(usage).toBe(`${platform.origin}/usage`)
    expect(await noticeCards(page).count()).toBe(1)
    expect(platform.acks).toHaveLength(2)

    // Closing settings repeats no acknowledgement and leaves the card on the sidebar.
    const launcher = page.getByRole('button', { name: '账号菜单', exact: true })
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'detached', timeout: 30_000 })
    // The shell restores focus to the launcher once the close commits.
    await expect.poll(() => launcher.evaluate(element => element === document.activeElement), { timeout: 30_000 }).toBe(true)
    observations.push(`open.closed settings cards=${String(await noticeCards(page).count())} acks=${String(platform.acks.length)}`)
    expect(await noticeCards(page).count()).toBe(1)
    expect(platform.acks).toHaveLength(2)
    // Closing the card hides it; the double already stopped serving this acknowledged order.
    await noticeCards(page).getByRole('button', { name: '关闭', exact: true }).click()
    expect(await noticeCards(page).count()).toBe(0)
    expect(platform.acks).toHaveLength(2)
    observations.push(`open.dismissed cards=0 acks=${String(platform.acks.length)}`)

    // The next entry refreshes once more; switching sections inside one open is not an entry.
    const reopenGetsBefore = platform.gets.length
    const reopenSummariesBefore = platform.summaries.length
    await openSettings(page, 'zh')
    const reopened = page.getByRole('dialog', { name: '设置', exact: true })
    await reopened.waitFor()
    await expect.poll(() => platform.gets.length, { timeout: 30_000 }).toBe(reopenGetsBefore + 1)
    await expect.poll(() => platform.summaries.length, { timeout: 30_000 }).toBe(reopenSummariesBefore + 1)
    observations.push(`reopen.open gets=${String(platform.gets.length - reopenGetsBefore)} summaries=${String(platform.summaries.length - reopenSummariesBefore)} cards=${String(await noticeCards(page).count())} acks=${String(platform.acks.length)}`)
    expect(await noticeCards(page).count()).toBe(0)
    expect(platform.acks).toHaveLength(2)
    // Arm the hold so a read triggered by navigation would be recorded and observed rather
    // than racing this assertion.
    const sectionGetsBefore = platform.gets.length
    const sectionSummariesBefore = platform.summaries.length
    platform.holdNextGet()
    const nav = reopened.locator('nav')
    await nav.getByRole('button', { name: '模型', exact: true }).click()
    await expect.poll(async () => nav.getByRole('button', { name: '模型', exact: true }).getAttribute('aria-current'), { timeout: 30_000 }).toBe('true')
    await nav.getByRole('button', { name: '账号与余额', exact: true }).click()
    await expect.poll(async () => nav.getByRole('button', { name: '账号与余额', exact: true }).getAttribute('aria-current'), { timeout: 30_000 }).toBe('true')
    platform.releaseGet()
    const sectionPanel = (await reopened.textContent()) ?? ''
    observations.push(`reopen.section-switch gets=${String(platform.gets.length - sectionGetsBefore)} summaries=${String(platform.summaries.length - sectionSummariesBefore)} amount=${String(sectionPanel.includes('¥13.00'))} cards=${String(await noticeCards(page).count())} acks=${String(platform.acks.length)}`)
    expect(platform.gets.length).toBe(sectionGetsBefore)
    expect(platform.summaries.length).toBe(sectionSummariesBefore)
    expect(sectionPanel).toContain('¥13.00')
    await page.keyboard.press('Escape')
    await reopened.waitFor({ state: 'detached', timeout: 30_000 })
    await expect.poll(() => launcher.evaluate(element => element === document.activeElement), { timeout: 30_000 }).toBe(true)
    observations.push(`reopen.closed cards=${String(await noticeCards(page).count())} acks=${String(platform.acks.length)}`)
    expect(await noticeCards(page).count()).toBe(0)
    expect(platform.acks).toHaveLength(2)

    // Returning from the native top-up view refreshes balance and notice once each, without
    // holding the panel open.
    const zhTopUp = '已赠送您 11.00 元 DSH 体验赠金。'
    const topUpGetsBefore = platform.gets.length
    const topUpSummariesBefore = platform.summaries.length
    await openSettings(page, 'zh')
    const topUpSettings = page.getByRole('dialog', { name: '设置', exact: true })
    await topUpSettings.waitFor()
    await expect.poll(() => platform.gets.length, { timeout: 30_000 }).toBe(topUpGetsBefore + 1)
    await expect.poll(() => platform.summaries.length, { timeout: 30_000 }).toBe(topUpSummariesBefore + 1)
    observations.push(`topup.open gets=${String(platform.gets.length - topUpGetsBefore)} summaries=${String(platform.summaries.length - topUpSummariesBefore)}`)
    const callsBefore = (await platformCalls(page)).length
    await topUpSettings.getByRole('link', { name: '充值', exact: true }).click()
    const topUpOverlay = page.getByRole('dialog', { name: '返回 DeepSeek Harness', exact: true })
    await topUpOverlay.waitFor()
    // Opening the native view reads nothing by itself.
    expect(platform.gets.length).toBe(topUpGetsBefore + 1)
    expect(platform.summaries.length).toBe(topUpSummariesBefore + 1)
    // The user pays while the view is open; Platform reports both balances in scientific
    // notation, so the refresh must render plain currency.
    platform.setNormalBalance('0E-16')
    platform.setBonusBalance('2.4E+1')
    platform.grant(ORDER_TOPUP, '11.00')
    // Holding the notice read proves the return does not wait for the refresh it starts.
    platform.holdNextGet()
    await topUpOverlay.getByRole('button', { name: '返回 DeepSeek Harness', exact: true }).click()
    await topUpOverlay.waitFor({ state: 'detached', timeout: 30_000 })
    const topUpCalls = (await platformCalls(page)).slice(callsBefore).join(',')
    observations.push(`topup.returned bridge=${topUpCalls} cards=${String(await noticeCards(page).count())}`)
    expect(topUpCalls).toBe('open:top-up,close')
    expect(await noticeCards(page).count()).toBe(0)
    platform.releaseGet()
    observations.push(`topup.notice=${await shownNotice(page, zhTopUp)}`)
    const topUpAttempts = (): AckRecord[] => platform.acks.filter(item => item.orderId === ORDER_TOPUP)
    await expect.poll(() => topUpAttempts().length, { timeout: 30_000 }).toBe(1)
    await expect.poll(() => platform.gets.length, { timeout: 30_000 }).toBe(topUpGetsBefore + 2)
    await expect.poll(() => platform.summaries.length, { timeout: 30_000 }).toBe(topUpSummariesBefore + 2)
    const topUpPanel = (await topUpSettings.textContent()) ?? ''
    const topUpAmounts = { recharge: topUpPanel.includes('¥0.00'), bonus: topUpPanel.includes('¥24.00') }
    observations.push(`topup.refresh gets=${String(platform.gets.length - topUpGetsBefore)} summaries=${String(platform.summaries.length - topUpSummariesBefore)} acks=${String(topUpAttempts().length)} recharge=${String(topUpAmounts.recharge)} bonus=${String(topUpAmounts.bonus)}`)
    expect(topUpAmounts).toEqual({ recharge: true, bonus: true })
    expect(await topUpSettings.getByRole('button', { name: '刷新余额', exact: true }).count()).toBe(0)
    // The card survives closing the panel, and the acknowledgement is not repeated.
    await page.keyboard.press('Escape')
    await topUpSettings.waitFor({ state: 'detached', timeout: 30_000 })
    observations.push(`topup.closed cards=${String(await noticeCards(page).count())} acks=${String(topUpAttempts().length)}`)
    expect(await noticeCards(page).count()).toBe(1)
    expect(topUpAttempts()).toHaveLength(1)
    await noticeCards(page).getByRole('button', { name: '关闭', exact: true }).click()
    expect(await noticeCards(page).count()).toBe(0)

    // A transient acknowledgement failure keeps the card and retries the same order after
    // the backoff; the pending retry is page state, not browser storage.
    const zhRetry = '已赠送您 6.00 元 DSH 体验赠金。'
    platform.grant(ORDER_RETRY, '6.00')
    platform.failNextAcks(ORDER_RETRY, 1)
    await openSettings(page, 'zh')
    const retryDialog = page.getByRole('dialog', { name: '设置', exact: true })
    await retryDialog.waitFor()
    observations.push(`retry.notice=${await shownNotice(page, zhRetry)}`)
    const retryAttempts = (): AckRecord[] => platform.acks.filter(item => item.orderId === ORDER_RETRY)
    await expect.poll(() => retryAttempts().length, { timeout: 30_000 }).toBe(1)
    // The failed attempt does not withdraw the card the user is reading.
    expect(await noticeCards(page).count()).toBe(1)
    await expect.poll(() => retryAttempts().length, { timeout: 30_000 }).toBe(2)
    const attempts = retryAttempts()
    // The first retry follows the configured first delay rather than arriving immediately.
    // Only the lower bound is asserted: load can widen the observed gap, never shorten it
    // below the timer's own 1s first step.
    const retryGapMs = attempts[1]!.at - attempts[0]!.at
    const retryBodyKept = attempts.every(item => item.body === JSON.stringify({ order_id: ORDER_RETRY })
      && item.query === '' && item.contentType === 'application/json')
    observations.push(`retry.attempts=${String(attempts.length)} backoff=${String(retryGapMs >= 900)} body-kept=${String(retryBodyKept)} cards=${String(await noticeCards(page).count())}`)
    expect(retryGapMs).toBeGreaterThanOrEqual(900)
    expect(retryBodyKept).toBe(true)
    await page.keyboard.press('Escape')
    await retryDialog.waitFor({ state: 'detached', timeout: 30_000 })
    await noticeCards(page).getByRole('button', { name: '关闭', exact: true }).click()

    // Display follows each response: the double keeps serving an acknowledged order, which
    // is what makes a second display of the same order observable.
    const zhRepeat = '已赠送您 7.00 元 DSH 体验赠金。'
    const storedBeforeShown = await storageKeys()
    platform.setKeepUnnotified(true)
    platform.grant(ORDER_REPEAT, '7.00')
    const repeatAttempts = (): AckRecord[] => platform.acks.filter(item => item.orderId === ORDER_REPEAT)
    await openSettings(page, 'zh')
    const repeatDialog = page.getByRole('dialog', { name: '设置', exact: true })
    await repeatDialog.waitFor()
    observations.push(`repeat.first=${await shownNotice(page, zhRepeat)}`)
    await expect.poll(() => repeatAttempts().length, { timeout: 30_000 }).toBe(1)
    // The mask owns pointer input, so the panel closes before the sidebar card is dismissed.
    await page.keyboard.press('Escape')
    await repeatDialog.waitFor({ state: 'detached', timeout: 30_000 })
    expect(await noticeCards(page).count()).toBe(1)
    await noticeCards(page).getByRole('button', { name: '关闭', exact: true }).click()
    // Displaying and acknowledging a notice writes nothing, so the key set is unchanged
    // against the baseline taken before it was shown.
    const shownAdded = (await storageKeys()).filter(key => !storedBeforeShown.includes(key))
    expect(shownAdded).toEqual([])
    // Restarting replays whatever the server still offers.
    await page.reload({ waitUntil: 'load' })
    observations.push(`repeat.reload=${await shownNotice(page, zhRepeat)}`)
    await expect.poll(() => repeatAttempts().length, { timeout: 30_000 }).toBe(2)
    const reloadAdded = (await storageKeys()).filter(key => !storedBeforeShown.includes(key))
    observations.push(`repeat.shown added-storage-keys=${String(shownAdded.length)} reload-added=${String(reloadAdded.length)} acks=${String(repeatAttempts().length)} cards=${String(await noticeCards(page).count())}`)
    expect(reloadAdded).toEqual([])
    await noticeCards(page).getByRole('button', { name: '关闭', exact: true }).click()

    // A failed wallet read still leaves both balance rows reaching the Platform entry.
    platform.setKeepUnnotified(false)
    platform.clearUnnotified()
    platform.setFailSummary(true)
    const failedGetsBefore = platform.gets.length
    const failedSummariesBefore = platform.summaries.length
    const failedUsagesBefore = (await platformCalls(page)).filter(call => call === 'open:usage').length
    await openSettings(page, 'zh')
    const failedSettings = page.getByRole('dialog', { name: '设置', exact: true })
    await failedSettings.waitFor()
    const failedLinks = failedSettings.getByRole('link', { name: '前往开放平台查看', exact: true })
    await expect.poll(() => failedLinks.count(), { timeout: 30_000 }).toBe(2)
    await expect.poll(() => platform.summaries.length, { timeout: 30_000 }).toBe(failedSummariesBefore + 1)
    const failedHrefs = (await failedLinks.evaluateAll(nodes => nodes.map(node => node.getAttribute('href'))))
      .map(href => String(href).replace(platform.origin, '{{origin}}'))
    observations.push(`failed.links count=${String(await failedLinks.count())} hrefs=${failedHrefs.join(',')}`)
    expect(failedHrefs).toEqual(['{{origin}}/usage', '{{origin}}/usage'])
    // Returning from usage refreshes nothing, because only a payment changes the account.
    for (const index of [0, 1]) {
      await failedLinks.nth(index).click()
      const usageOverlay = page.getByRole('dialog', { name: '返回 DeepSeek Harness', exact: true })
      await usageOverlay.waitFor()
      await usageOverlay.getByRole('button', { name: '返回 DeepSeek Harness', exact: true }).click()
      await usageOverlay.waitFor({ state: 'detached', timeout: 30_000 })
    }
    const failedUsages = (await platformCalls(page)).filter(call => call === 'open:usage').length - failedUsagesBefore
    observations.push(`failed.reached usages=${String(failedUsages)} gets=${String(platform.gets.length - failedGetsBefore)} summaries=${String(platform.summaries.length - failedSummariesBefore)}`)
    expect(failedUsages).toBe(2)
    expect(platform.gets.length).toBe(failedGetsBefore + 1)
    expect(platform.summaries.length).toBe(failedSummariesBefore + 1)
    platform.setFailSummary(false)
    await page.keyboard.press('Escape')
    await failedSettings.waitFor({ state: 'detached', timeout: 30_000 })
    await page.close()

    // Another device in another language gets the copy the server localized for it.
    platform.grant(ORDER_EN, '9.00')
    const enPage = await openDesktopPage('en-US')
    await enPage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const enCard = enPage.locator('aside').filter({ hasText: 'Bonus credited' }).filter({ hasText: enBonus })
    await enCard.waitFor({ state: 'visible', timeout: 30_000 })
    observations.push(`en.notice=${await cardText(enCard)}`)
    const enGet = platform.gets.find(entry => entry.locale === 'en_US')!
    observations.push(`en.get locale=${String(enGet.locale)} query=${enGet.query}`)
    expect(enGet.locale).toBe('en_US')
    expect(enGet.query).toBe('')

    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'notice-flow.expected.md'), observations.join('\n'), MODE)
    for (const tripwire of tripwires) {
      expect(tripwire.warnings).toEqual([])
      expect(tripwire.pageErrors).toEqual([])
    }
    await assertFixtureInventory(SNAPSHOT_DIR, ['notice-flow.expected.md'])
  }, 180_000)
})
