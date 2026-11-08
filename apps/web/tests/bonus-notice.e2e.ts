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
const ORDER_FIRST = 'notice-first'
const ORDER_LATER = 'notice-later'
const ORDER_EN = '44444444-4444-4444-8444-444444444444'
const ORDER_FAILED_EVENT = '55555555-5555-4555-8555-555555555555'
const ORDER_REPEAT = '66666666-6666-4666-8666-666666666666'
const ORDER_TOPUP = '77777777-7777-4777-8777-777777777777'
const ORDER_WEB = '99999999-9999-4999-8999-999999999999'

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
  const contentReads: { id: string | null; locale: string | undefined }[] = []
  const contents = new Map<string, Granted>()
  /** Reads already answered; a request the client is still awaiting is not evidence of a delivered response. */
  const served: GetRecord[] = []
  const acks: AckRecord[] = []
  const dismissals: AckRecord[] = []
  const clicks: AckRecord[] = []
  let includeUnsupportedNotification = false
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
  let holdProfile = false
  const pendingProfiles: (() => void)[] = []
  const releaseProfiles = (): void => { holdProfile = false; for (const reply of pendingProfiles.splice(0)) reply() }
  /** Reply held back while the test controls when a read can answer. */
  let heldReply: (() => void) | undefined
  const grant = (orderId: string, amount: string, extraCopy = ''): void => {
    const value = {
      orderId, amount,
      zh_CN: `已赠送您 ${amount} 元 DSH 体验赠金。${extraCopy}`,
      en_US: `You received a CNY ${amount} DSH trial credit.${extraCopy}`,
    }
    unnotified.unshift(value)
    contents.set(orderId, value)
  }
  /** @param value - granted bonus. @param locale - request language. @returns its wire fields. */
  const wire = (value: Granted, locale: string | undefined): unknown => ({
    id: value.orderId, created_at: '2026-10-21T08:00:00Z',
    display_until: value.orderId === ORDER_FIRST ? null : expiresAt(),
    title: value.orderId === ORDER_FIRST ? (locale === 'en_US' ? 'Platform notice' : '平台通知')
      : locale === 'en_US' ? 'Bonus credited' : '赠金已到账',
    body: locale === 'en_US' ? value.en_US : value.zh_CN,
    actions: value.orderId === 'b1111111-1111-4111-8111-111111111111' ? [
      { label: locale === 'en_US' ? 'View balance' : '查看余额', style: 'primary', target: { type: 'app_route', name: 'account' } },
      { label: locale === 'en_US' ? 'Got it' : '知道了', style: 'secondary', target: { type: 'dismiss' } },
    ] : [],
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
      const answer = (): void => {
        // `email` is required by the provider's profile schema even when the account has none.
        reply({ code: 0, data: { biz_code: 0, biz_data: {
          id: ACCOUNT_ID, email: '', id_profile: { name: 'Bonus User', picture: null },
        } } })
      }
      if (holdProfile) pendingProfiles.push(answer)
      else answer()
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
    if (url.pathname === '/api/v0/users/notifications/list') {
      const record = { locale, query: url.search }
      gets.push(record)
      const payload = { code: 0, data: { biz_code: 0, biz_data: {
        next_poll_after: 3600, notifications: [
          ...includeUnsupportedNotification ? [{
            id: 'unsupported-action', created_at: '2026-10-21T00:00:00Z', display_until: null,
            title: 'Unsupported action', body: 'Not supported by this client',
            actions: [{ label: 'Open', style: 'primary', target: { type: 'future' } }],
          }] : [],
          ...unnotified.map(value => wire(value, locale)),
        ],
      } } }
      const answer = (): void => { served.push(record); reply(payload) }
      if (heldReply === undefined) { answer(); return }
      heldReply = answer
      return
    }
    if (url.pathname === '/api/v0/users/notifications/content') {
      const id = url.searchParams.get('id')
      contentReads.push({ id, locale })
      const value = id === null ? undefined : contents.get(id)
      if (value === undefined) { res.writeHead(404).end(); return }
      reply({ code: 0, data: { biz_code: 0, biz_data: wire(value, locale) } })
      return
    }
    if (url.pathname === '/api/v0/users/notifications/events' && req.method === 'POST') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => { body += chunk })
      req.on('end', () => {
        const payload: unknown = JSON.parse(body)
        const orderId = typeof payload === 'object' && payload !== null && 'notification_id' in payload
          && typeof payload.notification_id === 'string' ? payload.notification_id : null
        const event = typeof payload === 'object' && payload !== null && 'type' in payload ? payload.type : null
        if (event !== 'displayed' && event !== 'cta_clicked' && event !== 'dismissed') { res.writeHead(400).end(); return }
        const records = event === 'displayed' ? acks : event === 'cta_clicked' ? clicks : dismissals
        records.push({ method: req.method ?? '', path: url.pathname, locale, orderId, body,
          query: url.search, contentType: req.headers['content-type'], at: performance.now() })
        if (event === 'displayed' && ackFailure !== undefined && ackFailure.orderId === orderId && ackFailure.remaining > 0) {
          ackFailure.remaining--
          // The event is lost; a later notification read can offer this order again.
          res.writeHead(502, { 'content-type': 'text/plain' }).end('Internal Server Error')
          return
        }
        if (orderId === null) {
          reply({ code: 0, msg: '', data: { biz_code: 1, biz_msg: 'BONUS_ORDER_NOT_FOUND', biz_data: null } }); return
        }
        const index = unnotified.findIndex(value => value.orderId === orderId)
        if (index >= 0 && !keepUnnotified && event !== 'cta_clicked') unnotified.splice(index, 1)
        reply({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { acked: true } } })
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
    grant, gets, served, acks, clicks, dismissals, summaries, contentReads,
    setUnsupportedNotification: (value: boolean): void => { includeUnsupportedNotification = value },
    holdProfiles: (): void => { holdProfile = true },
    pendingProfileResponses: (): number => pendingProfiles.length,
    releaseProfiles,
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
    close: () => new Promise<void>((resolve) => { releaseProfiles(); server.close(() => { resolve() }); server.closeAllConnections() }),
  }
}

/** @param page - page under test. @returns every rendered bonus notice card. */
function noticeCards(page: Page): Locator {
  return page.locator('aside[data-front]')
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
    platform.holdProfiles()
    platform.setUnsupportedNotification(true)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await expect.poll(() => platform.gets.length, { timeout: 30_000 }).toBe(1)
    observations.push(`startup.held cards=${String(await noticeCards(page).count())} acks=${String(platform.acks.length)}`)
    expect(await noticeCards(page).count()).toBe(0)
    expect(platform.acks).toEqual([])
    platform.releaseGet()

    // Startup signs in and reads the notice; the card shows it and only then is it acknowledged.
    observations.push(`startup.notice=${await shownNotice(page, zhFirst)}`)
    observations.push(`startup.ack orders=${await acked(platform, 1)}`)
    expect(await noticeCards(page).count()).toBe(1)
    expect(platform.acks.some(record => record.orderId === 'unsupported-action')).toBe(false)
    observations.push('startup.unsupported-action skipped=true valid-card=true displayed=false')
    platform.setUnsupportedNotification(false)
    await expect.poll(platform.pendingProfileResponses).toBeGreaterThan(0)
    observations.push('startup.profile-pending notice=true displayed=1')
    platform.releaseProfiles()
    const get = platform.gets[0]!
    const ack = platform.acks[0]!
    observations.push(`startup.get locale=${String(get.locale)} query=${get.query}`)
    observations.push(`startup.ack method=${ack.method} path=${ack.path} locale=${String(ack.locale)} notification_id=${String(ack.orderId)} body=${JSON.stringify(ack.body)}`)
    expect(get.locale).toBe('zh_CN')
    expect(get.query).toBe('')
    expect(ack).toMatchObject({
      method: 'POST', path: '/api/v0/users/notifications/events', locale: 'zh_CN', orderId: ORDER_FIRST,
      body: JSON.stringify({ notification_id: ORDER_FIRST, type: 'displayed' }), query: '', contentType: 'application/json',
    })

    // Explicit close reports dismissal without repeating the display event.
    await noticeCards(page).getByRole('button', { name: '关闭', exact: true }).click()
    expect(await noticeCards(page).count()).toBe(0)
    expect(platform.acks).toHaveLength(1)
    await expect.poll(() => platform.dismissals.length).toBe(1)
    expect(platform.dismissals[0]).toMatchObject({
      method: 'POST', path: '/api/v0/users/notifications/events', orderId: ORDER_FIRST,
      body: JSON.stringify({ notification_id: ORDER_FIRST, type: 'dismissed' }),
    })
    observations.push('startup.close event=dismissed displayed=1 dismissed=1')

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

    // A failed event leaves the card intact and is not retried in the background.
    const zhFailedEvent = '已赠送您 6.00 元 DSH 体验赠金。'
    platform.grant(ORDER_FAILED_EVENT, '6.00')
    platform.failNextAcks(ORDER_FAILED_EVENT, 1)
    await openSettings(page, 'zh')
    const failedEventDialog = page.getByRole('dialog', { name: '设置', exact: true })
    await failedEventDialog.waitFor()
    observations.push(`event-failed.notice=${await shownNotice(page, zhFailedEvent)}`)
    const failedAttempts = (): AckRecord[] => platform.acks.filter(item => item.orderId === ORDER_FAILED_EVENT)
    await expect.poll(() => failedAttempts().length, { timeout: 30_000 }).toBe(1)
    await page.clock.install()
    await page.clock.fastForward(60_000)
    const attempts = failedAttempts()
    const eventBodyKept = attempts.every(item => item.body === JSON.stringify({ notification_id: ORDER_FAILED_EVENT, type: 'displayed' })
      && item.query === '' && item.contentType === 'application/json')
    observations.push(`event-failed.attempts=${String(attempts.length)} body-kept=${String(eventBodyKept)} cards=${String(await noticeCards(page).count())}`)
    expect(attempts).toHaveLength(1)
    expect(eventBodyKept).toBe(true)
    expect(await noticeCards(page).count()).toBe(1)
    await page.keyboard.press('Escape')
    await failedEventDialog.waitFor({ state: 'detached', timeout: 30_000 })
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

    await enPage.close()
    await page.close()
    platform.clearUnnotified()
    platform.grant(ORDER_WEB, '4.00')
    const webPage = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
    tripwires.push(watchConsole(webPage))
    await webPage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const webNotice = await shownNotice(webPage, '已赠送您 4.00 元 DSH 体验赠金。')
    await expect.poll(() => platform.acks.filter(item => item.orderId === ORDER_WEB).length).toBe(1)
    observations.push(`web.notice=${webNotice} acks=1`)
    await webPage.close()
    platform.clearUnnotified()
    platform.grant('a3333333-3333-4333-8333-333333333333', '23.00')
    platform.grant('a2222222-2222-4222-8222-222222222222', '22.00', '\nMore details'.repeat(8))
    platform.grant('a1111111-1111-4111-8111-111111111111', '21.00')
    const ackStart = platform.acks.length
    const stackPage = await openDesktopPage('zh-CN')
    await stackPage.setViewportSize({ width: 900, height: 960 })
    await stackPage.emulateMedia({ colorScheme: 'light' })
    await stackPage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const cards = noticeCards(stackPage)
    await expect.poll(() => cards.count()).toBe(3)
    expect(await cards.first().isVisible()).toBe(false)
    expect(platform.acks.length).toBe(ackStart)
    observations.push('stack.hidden cards=3 acks=0')
    await stackPage.setViewportSize({ width: 1440, height: 960 })
    await expect.poll(() => cards.first().isVisible()).toBe(true)
    await expect.poll(() => platform.acks.length).toBe(ackStart + 1)
    expect(platform.acks.slice(ackStart).map(ack => ack.orderId)).toEqual(['a1111111-1111-4111-8111-111111111111'])
    expect(await stackPage.getByRole('status').count()).toBe(1)
    const second = cards.filter({ hasText: '22.00' })
    const secondNode = await second.elementHandle()
    const frontBox = await cards.first().boundingBox()
    const backBox = await second.boundingBox()
    expect(frontBox!.x).toBeCloseTo(10, 0)
    expect(frontBox!.width).toBeCloseTo(260, 0)
    expect(frontBox!.x + frontBox!.width).toBeCloseTo(270, 0)
    expect(backBox!.width).toBeCloseTo(252, 0)
    expect(backBox!.y).toBeCloseTo(frontBox!.y - 4, 0)
    const transition = await second.evaluate((element) => {
      const style = getComputedStyle(element)
      return `${style.transitionDuration} ${style.transitionTimingFunction}`
    })
    expect(transition).toBe('0.25s ease-out')
    observations.push(`stack.initial cards=3 acks=stack-first widths=260,252 inset=10 offset=-4 transition=${transition}`)
    for (const [delta, width, edge] of [[80, 280, 360], [-80, 260, 280]] as const) {
      const handle = await stackPage.locator('[data-side="sidebar"]').boundingBox()
      const x = handle!.x + handle!.width / 2
      const y = handle!.y + handle!.height / 2
      await stackPage.mouse.move(x, y)
      await stackPage.mouse.down()
      await stackPage.mouse.move(x + delta, y, { steps: 5 })
      await stackPage.mouse.up()
      await expect.poll(async () => Math.round((await cards.first().boundingBox())!.width)).toBe(width)
      const movedHandle = await stackPage.locator('[data-side="sidebar"]').boundingBox()
      expect(movedHandle!.x + movedHandle!.width / 2).toBeCloseTo(edge, 0)
      const resized = await cards.first().boundingBox()
      expect(resized!.x).toBeCloseTo(10, 0)
      expect(resized!.x + resized!.width).toBeCloseTo(10 + width, 0)
      observations.push(`stack.resized sidebar=${edge} card=${width} left-inset=10`)
    }
    const beforeCollapseAcks = platform.acks.length
    const beforeCollapseDismissals = platform.dismissals.length
    await stackPage.setViewportSize({ width: 900, height: 960 })
    await stackPage.locator('[data-sidebar-collapsed]:not([data-sidebar-drawer])').waitFor()
    await expect.poll(() => cards.first().isVisible()).toBe(false)
    expect(await cards.count()).toBe(3)
    expect(platform.dismissals.length).toBe(beforeCollapseDismissals)
    observations.push('stack.rail cards=3 visible=false dismissed=0')
    await stackPage.setViewportSize({ width: 1440, height: 960 })
    await stackPage.locator('[data-sidebar-collapsed]').waitFor({ state: 'detached' })
    await expect.poll(() => cards.first().isVisible()).toBe(true)
    expect(await cards.count()).toBe(3)
    expect(await second.evaluate((element, previous) => element === previous, secondNode)).toBe(true)
    expect(await cardText(cards.first())).toContain('21.00')
    expect(platform.acks.length).toBe(beforeCollapseAcks)
    expect(platform.dismissals.length).toBe(beforeCollapseDismissals)
    observations.push('stack.expanded cards=3 duplicate-acks=0 dismissed=0')
    const artifactDir = fileURLToPath(new URL('../../../.artifacts', import.meta.url))
    await mkdir(artifactDir, { recursive: true })
    await stackPage.screenshot({ path: join(artifactDir, 'bonus-notice-stack-light.png') })
    await stackPage.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => stackPage.locator('body').getAttribute('data-ds-dark-theme')).not.toBeNull()
    await stackPage.screenshot({ path: join(artifactDir, 'bonus-notice-stack-dark.png') })
    const promotion = await stackPage.evaluate(() => {
      const front = document.querySelector<HTMLElement>('aside[data-front="true"]')!
      const next = front.nextElementSibling as HTMLElement
      const before = next.getBoundingClientRect()
      front.querySelector('button')!.click()
      const animation = next.getAnimations()[0]!
      animation.pause()
      animation.currentTime = 0
      const start = next.getBoundingClientRect()
      animation.currentTime = 125
      const middle = next.getBoundingClientRect()
      animation.finish()
      const end = next.getBoundingClientRect()
      return { before: { y: before.y, height: before.height }, start: { y: start.y, height: start.height },
        middle: { y: middle.y, height: middle.height }, end: { y: end.y, height: end.height } }
    })
    expect(promotion.start.y).toBeCloseTo(promotion.before.y, 0)
    expect(promotion.start.height).toBeCloseTo(promotion.before.height, 0)
    expect(promotion.end.height).toBeGreaterThan(promotion.start.height + 100)
    expect(promotion.middle.height).toBeGreaterThan(promotion.start.height)
    expect(promotion.middle.height).toBeLessThan(promotion.end.height)
    expect(promotion.middle.y).toBeLessThan(promotion.start.y)
    expect(promotion.middle.y).toBeGreaterThan(promotion.end.y)
    await expect.poll(() => cards.count()).toBe(2)
    await expect.poll(async () => Math.round((await second.boundingBox())!.width)).toBe(260)
    expect(await second.evaluate((element, previous) => element === previous, secondNode)).toBe(true)
    expect(await second.getAttribute('data-front')).toBe('true')
    await expect.poll(() => platform.acks.length).toBe(ackStart + 2)
    expect(platform.acks.slice(ackStart).map(ack => ack.orderId)).toEqual(['a1111111-1111-4111-8111-111111111111', 'a2222222-2222-4222-8222-222222222222'])
    observations.push('stack.promoted cards=2 acks=stack-first,stack-second width=260 same-node=true')
    await second.getByRole('button', { name: '关闭', exact: true }).click()
    await expect.poll(() => platform.acks.length).toBe(ackStart + 3)
    expect(platform.acks.slice(ackStart).map(ack => ack.orderId)).toEqual(['a1111111-1111-4111-8111-111111111111', 'a2222222-2222-4222-8222-222222222222', 'a3333333-3333-4333-8333-333333333333'])
    await cards.filter({ hasText: '23.00' }).getByRole('button', { name: '关闭', exact: true }).click()
    await expect.poll(() => cards.count()).toBe(0)
    await expect.poll(() => platform.dismissals.filter(record => record.orderId?.startsWith('a')).length).toBe(3)
    const stackDismissals = platform.dismissals.filter(record => record.orderId?.startsWith('a'))
    expect(stackDismissals.map(record => record.body)).toEqual(stackDismissals.map(record =>
      JSON.stringify({ notification_id: record.orderId, type: 'dismissed' })))
    observations.push('stack.dismissed cards=0 acks=stack-first,stack-second,stack-third')
    await stackPage.close()

    platform.grant('b1111111-1111-4111-8111-111111111111', '31.00')
    const refreshAckStart = platform.acks.length
    const refreshPage = await openDesktopPage('zh-CN')
    await refreshPage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const refreshCards = noticeCards(refreshPage)
    await shownNotice(refreshPage, '已赠送您 31.00 元 DSH 体验赠金。')
    await expect.poll(() => platform.acks.length).toBe(refreshAckStart + 1)
    const firstNode = await refreshCards.first().elementHandle()
    platform.grant('b3333333-3333-4333-8333-333333333333', '33.00')
    platform.grant('b2222222-2222-4222-8222-222222222222', '32.00')
    await openSettings(refreshPage, 'zh')
    await expect.poll(() => refreshCards.count()).toBe(3)
    expect(await cardText(refreshCards.first())).toContain('31.00')
    expect(await refreshCards.first().evaluate((element, previous) => element === previous, firstNode)).toBe(true)
    expect(platform.acks.slice(refreshAckStart).map(ack => ack.orderId)).toEqual(['b1111111-1111-4111-8111-111111111111'])
    observations.push('refresh.retained cards=3 acks=refresh-first same-node=true')
    const localeReads = platform.gets.length
    const localeContents = platform.contentReads.length
    await refreshPage.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '通用设置', exact: true }).click()
    await refreshPage.getByRole('button', { name: '中文', exact: true }).click()
    await refreshPage.getByRole('menuitem', { name: 'English', exact: true }).click()
    await refreshPage.getByRole('dialog', { name: 'Settings', exact: true }).waitFor()
    await expect.poll(() => cardText(refreshCards.first())).toContain('You received a CNY 31.00')
    expect(await refreshCards.first().evaluate((element, previous) => element === previous, firstNode)).toBe(true)
    expect(platform.gets.length).toBe(localeReads)
    expect(platform.acks.length).toBe(refreshAckStart + 1)
    expect(platform.contentReads.slice(localeContents).map(read => read.locale)).toEqual(['en_US', 'en_US', 'en_US'])
    expect(await refreshCards.first().getByRole('button', { name: 'View balance', exact: true }).count()).toBe(1)
    observations.push('refresh.localized locale=en_US content-reads=3 list-reads=0 acks=1 same-node=true')
    await refreshPage.keyboard.press('Escape')
    await refreshPage.getByRole('dialog', { name: 'Settings', exact: true }).waitFor({ state: 'detached' })
    const clicksBeforeAction = platform.clicks.length
    const dismissalsBeforeClick = platform.dismissals.length
    await refreshCards.first().getByRole('button', { name: 'View balance', exact: true }).click()
    await expect.poll(() => platform.clicks.length).toBe(clicksBeforeAction + 1)
    expect(platform.clicks.at(-1)?.body).toBe(JSON.stringify({ notification_id: 'b1111111-1111-4111-8111-111111111111', type: 'cta_clicked' }))
    expect(platform.dismissals.length).toBe(dismissalsBeforeClick)
    expect(await refreshCards.count()).toBe(3)
    const accountSettings = refreshPage.getByRole('dialog', { name: 'Settings', exact: true })
    await accountSettings.waitFor()
    expect(await accountSettings.getByRole('button', { name: 'Account', exact: true }).getAttribute('aria-current')).toBe('true')
    observations.push('refresh.business-action event=cta_clicked cards=3 account-open=true')
    await refreshPage.keyboard.press('Escape')
    await accountSettings.waitFor({ state: 'detached' })
    await refreshPage.setViewportSize({ width: 390, height: 844 })
    await refreshPage.locator('[data-sidebar-drawer][data-sidebar-collapsed]').waitFor()
    await expect.poll(() => refreshCards.first().isVisible()).toBe(false)
    expect(await refreshCards.count()).toBe(3)
    await refreshPage.locator('[data-shell-leading]').getByRole('button', { name: 'Open sidebar', exact: true }).click()
    const drawer = refreshPage.locator('[data-sidebar-drawer]:not([data-sidebar-collapsed])')
    await drawer.waitFor()
    expect(await refreshCards.first().evaluate(element => element.closest('[role="dialog"]')?.getAttribute('aria-label'))).toBe('Navigation')
    await expect.poll(() => drawer.locator('[data-sidebar-mask]').evaluate(element => getComputedStyle(element).opacity)).toBe('1')
    await expect.poll(() => refreshCards.first().getByRole('button', { name: 'Got it', exact: true }).evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
    })).toBe(true)
    observations.push('refresh.drawer width=390 notice-above-sidebar=true')
    const cardBounds = await refreshCards.first().boundingBox()
    const drawerBounds = await drawer.getByRole('dialog', { name: 'Navigation', exact: true }).boundingBox()
    const actionBounds = await refreshCards.first().getByRole('button', { name: 'View balance', exact: true }).boundingBox()
    expect(cardBounds!.x - drawerBounds!.x).toBeCloseTo(10, 0)
    expect(drawerBounds!.width - cardBounds!.width).toBeCloseTo(20, 0)
    expect(cardBounds!.x).toBeGreaterThanOrEqual(0)
    expect(cardBounds!.x + cardBounds!.width).toBeLessThanOrEqual(390)
    expect(actionBounds!.x + actionBounds!.width).toBeLessThanOrEqual(cardBounds!.x + cardBounds!.width)
    const dismissalsBeforeAction = platform.dismissals.length
    await refreshCards.first().getByRole('button', { name: 'Got it', exact: true }).click()
    expect(await drawer.count()).toBe(1)
    await expect.poll(() => platform.dismissals.length).toBe(dismissalsBeforeAction + 1)
    expect(platform.dismissals.at(-1)?.orderId).toBe('b1111111-1111-4111-8111-111111111111')
    expect(platform.clicks.length).toBe(clicksBeforeAction + 1)
    observations.push('refresh.action event=dismissed got-it=true')
    await expect.poll(() => platform.acks.length).toBe(refreshAckStart + 2)
    expect(await cardText(refreshCards.first())).toContain('32.00')
    observations.push('refresh.promoted cards=2 acks=refresh-first,refresh-second')
    await refreshCards.first().getByRole('button', { name: 'Close', exact: true }).click()
    await expect.poll(() => platform.acks.length).toBe(refreshAckStart + 3)
    expect(platform.acks.slice(refreshAckStart).map(ack => ack.orderId)).toEqual(['b1111111-1111-4111-8111-111111111111', 'b2222222-2222-4222-8222-222222222222', 'b3333333-3333-4333-8333-333333333333'])
    await refreshCards.first().getByRole('button', { name: 'Close', exact: true }).click()
    await expect.poll(() => refreshCards.count()).toBe(0)
    observations.push('refresh.dismissed cards=0 acks=refresh-first,refresh-second,refresh-third')
    await refreshPage.close()

    const pollFirst = 'c1111111-1111-4111-8111-111111111111'
    const pollSecond = 'c2222222-2222-4222-8222-222222222222'
    platform.grant(pollFirst, '41.00')
    const pollPage = await openDesktopPage('en-US')
    await pollPage.clock.install()
    await pollPage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await shownNotice(pollPage, 'You received a CNY 41.00 DSH trial credit.')
    await expect.poll(() => platform.acks.at(-1)?.orderId).toBe(pollFirst)
    const pollCards = noticeCards(pollPage)
    const retainedNode = await pollCards.first().elementHandle()
    const pollReads = platform.gets.length
    const pollAcks = platform.acks.length
    platform.grant(pollSecond, '42.00')
    await pollPage.clock.fastForward(3_600_000)
    await expect.poll(() => pollCards.count()).toBe(2)
    expect(platform.gets.length).toBe(pollReads + 1)
    expect(platform.acks.length).toBe(pollAcks)
    expect(await pollCards.first().evaluate((element, previous) => element === previous, retainedNode)).toBe(true)
    await openSettings(pollPage, 'en')
    await expect.poll(() => platform.gets.length).toBe(pollReads + 2)
    expect(await pollCards.count()).toBe(2)
    observations.push('poll.arrival cards=2 list-reads=1 duplicate-acks=0 same-node=true settings-immediate-read=true')
    await pollPage.close()

    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'notice-flow.expected.md'), observations.join('\n'), MODE)
    for (const tripwire of tripwires) {
      expect(tripwire.warnings).toEqual([])
      expect(tripwire.pageErrors).toEqual([])
    }
    await assertFixtureInventory(SNAPSHOT_DIR, ['notice-flow.expected.md'])
  }, 180_000)
})
