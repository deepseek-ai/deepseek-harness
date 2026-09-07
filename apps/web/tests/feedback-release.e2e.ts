// Recorded model replay drives the shipped feedback UI and canonical log.
// The loopback collector must receive each authorized suffix before the next UI action.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { gunzipSync } from 'node:zlib'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureExpandedTurnProcessAria, captureStableAria,
  compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, readPersistedEvents, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/feedback-release', import.meta.url))
// Both routes borrow the same settled turn; this manifest references its owner.
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/feedback-command/session.v2.jsonl', import.meta.url))
const ACK_EXPECTED = join(SNAPSHOT_DIR, 'ack.expected.md')
const ACK_EXPANDED_EXPECTED = join(SNAPSHOT_DIR, 'ack-expanded.expected.md')
const RELEASE_EXPECTED = join(SNAPSHOT_DIR, 'feedback-release.expected.json')
const MODE = webSnapshotMode()

interface OtlpCapture {
  resourceLogs: { scopeLogs: { logRecords: {
    attributes: { key: string; value: { stringValue?: string; intValue?: number | string } }[]
  }[] }[] }[]
}

const PROMPT = 'Reply with the single word LIGHTHOUSE and stop.'

describe.each(MODE === 'record' ? ['deepseek-official'] : ['deepseek-official', 'feedback-mock'])('web e2e: feedback release for %s', (provider) => {
  const official = provider === 'deepseek-official'
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let collector: Server
  let sessionId: SessionId
  let authorized: readonly SessionEvent[] = []
  let releasedCount = 0
  const suffixes: string[][] = []
  const uploads: string[] = []
  let headerlessExpected: [string, number, string][] = []

  function captured(): [string | undefined, number, string | undefined][] {
    return uploads.flatMap((upload) => {
      const capture = JSON.parse(upload) as OtlpCapture
      return capture.resourceLogs.flatMap(resource => resource.scopeLogs.flatMap(scope =>
        scope.logRecords.map((record) => {
          const attribute = (key: string) => record.attributes.find(value => value.key === key)?.value
          return [attribute('session.id')?.stringValue, Number(attribute('event.seq')?.intValue),
            attribute('event.type')?.stringValue] as [string | undefined, number, string | undefined]
        })))
    })
  }

  async function expectFeedbackRelease(type: SessionEvent['type'], count: number): Promise<void> {
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('feedback session has no active agent')
    await scaffold.ctx.sessions.flush(agent.session)
    const events = await readPersistedEvents(scaffold, sessionId)
    const feedback = events.filter(event => event.type === type)
    expect(feedback).toHaveLength(count)
    const boundary = feedback.at(-1)!
    authorized = events.filter(event => event.seq <= boundary.seq)
    const expected = authorized.map(event => [sessionId, event.seq, event.type])
    // No teardown, flush hook, or subsequent interaction may cause this delivery.
    await expect.poll(captured, { timeout: 10_000 }).toEqual(expected)
    suffixes.push(authorized.slice(releasedCount).map(event => event.type))
    releasedCount = authorized.length
    expect(scaffold.ctx.agents.get(sessionId)).toBe(agent)
  }

  async function selectModel(name: string): Promise<void> {
    const trigger = page.getByRole('button', { name: /^Select model, current/ })
    await trigger.click()
    await page.getByRole('menuitem', { name: /^Model\b/ }).click()
    await page.getByRole('menuitemradio', { name, exact: true }).click()
    await expect.poll(() => trigger.getAttribute('aria-label')).toContain(name)
  }

  beforeAll(async () => {
    collector = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk as Buffer))
      request.on('end', () => {
        const raw = Buffer.concat(chunks)
        uploads.push((request.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString())
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      })
    })
    collector.listen(0, '127.0.0.1')
    await once(collector, 'listening')
    const address = collector.address()
    if (address === null || typeof address === 'string') throw new Error('collector has no port')
    scaffold = await launchWebScaffold({
      telemetryUrl: `http://127.0.0.1:${address.port}/v1/logs`,
      telemetryMode: 'FEEDBACK_ONLY',
      telemetryScheduledDelayMillis: 10,
      replayProviders: [
        { id: 'deepseek-official', name: 'DeepSeek', models: [
          { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 128_000 },
        ] },
        { id: 'feedback-mock', name: 'Feedback mock', models: [
          { id: 'feedback-mock', name: 'Feedback mock', contextWindow: 128_000 },
        ] },
      ],
      // The replayed session.v2.jsonl belongs to the feedback-command scenario;
      // comparing (or refreshing) the persisted session here would rewrite
      // that shared source with this lane's feedback events. Persistence and
      // collector assertions belong to this lane.
      compareReplaySession: false,
      ...(MODE === 'record' ? {} : { replayFixture: FIXTURE, paceMs: 5 }),
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    try {
      await browser?.close()
      await scaffold?.close()
      // Shutdown drains any illicitly queued tail too; delivery assertions run in the tests.
      expect(captured()).toEqual([...authorized.map(event => [sessionId, event.seq, event.type]), ...headerlessExpected])
    } finally {
      if (collector?.listening) {
        await new Promise<void>((resolve, reject) => {
          collector.close((error) => {
            if (error) reject(error)
            else resolve()
          })
          collector.closeAllConnections()
        })
      }
    }
  })

  it('drives the recorded prompt to a settled turn (all modes)', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-feedback-release-drive'))
    if (MODE !== 'record') {
      // Drift guard: the shared fixture must carry exactly the drive prompt.
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    }
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })
    if (!official) await selectModel('Feedback mock')
    const settled = scaffold.whenTurnSettled()
    await input.fill(PROMPT)
    await input.press('Enter')
    sessionId = await settled
    const agent = scaffold.ctx.agents.get(sessionId)
    expect(agent?.session.requestHeader()?.config.provider).toBe(provider)
    expect(uploads).toEqual([])
    // Both routes render the same composer without changing the actual request header.
    if (MODE !== 'record') {
      await selectModel('Feedback mock')
      await selectModel('DeepSeek-V4-Flash')
    }
    expect(agent?.session.requestHeader()?.config.provider).toBe(provider)
    expect(uploads).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('records feedback locally and acknowledges its session and anonymous user ids', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-feedback-release'))
    await page.getByText('LIGHTHOUSE', { exact: true }).waitFor({ timeout: 15_000 })
    expect(uploads).toEqual([])
    const input = page.locator('[data-composer-input]').first()
    await input.fill('/feedback the diff view is unreadable')
    await input.press('Enter')

    await page.getByText(/Feedback recorded for session/).waitFor({ timeout: 10_000 })
    expect(await page.getByText(/Anonymous user: [0-9a-f-]+\.$/i).count()).toBe(1)
    await expectFeedbackRelease('feedback/record', 1)

    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(ACK_EXPECTED, snapshot, MODE)
    const expanded = await captureExpandedTurnProcessAria(
      page,
      '[class*="centerCol"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(ACK_EXPANDED_EXPECTED, expanded, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('does not release command tails, provider changes, or browser reloads', async () => {
    const events = await readPersistedEvents(scaffold, sessionId)
    expect(events.at(-1)?.type).toBe('command/done')
    expect(events.at(-1)!.seq).toBeGreaterThan(authorized.at(-1)!.seq)
    await selectModel('Feedback mock')
    await selectModel('DeepSeek-V4-Flash')
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await page.getByText('LIGHTHOUSE', { exact: true }).waitFor({ timeout: 15_000 })
    expect(captured()).toHaveLength(releasedCount)
  })

  it.skipIf(MODE === 'record')('persists text, ratings, notes, and retractions in the canonical session', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-feedback-release-suffix'))
    const input = page.locator('[data-composer-input]').first()
    await input.fill('/feedback the second remark')
    await input.press('Enter')
    await expect.poll(() => page.getByText(/Feedback recorded for session/).count()).toBe(2)
    await expectFeedbackRelease('feedback/record', 2)
    const like = page.getByRole('button', { name: 'Good response' })
    await like.hover()
    await like.click()
    const rated = page.getByRole('button', { name: 'Remove rating' })
    await expect.poll(() => rated.getAttribute('aria-pressed')).toBe('true')
    await expectFeedbackRelease('feedback/message-put', 1)
    await page.getByRole('button', { name: 'Add a note' }).click()
    await page.getByRole('textbox', { name: 'Feedback note' }).fill('Read both files before answering.')
    expect(captured()).toHaveLength(releasedCount)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByText('Read both files before answering.', { exact: true }).waitFor()
    await expectFeedbackRelease('feedback/message-put', 2)
    await rated.click()
    await expect.poll(() => like.getAttribute('aria-pressed')).toBe('false')
    await expectFeedbackRelease('feedback/message-delete', 1)
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('feedback session has no active agent')
    await scaffold.ctx.sessions.flush(agent.session)
    const events = await readPersistedEvents(scaffold, sessionId)
    expect(events.filter(event => event.type === 'feedback/record')).toMatchObject([
      { data: { text: 'the diff view is unreadable' } },
      { data: { text: 'the second remark' } },
    ])
    expect(events.filter(event => event.type === 'feedback/message-put')).toMatchObject([
      { data: { sessionId, item: { rating: 'positive' } } },
      { data: { sessionId, item: { rating: 'positive', note: 'Read both files before answering.' } } },
    ])
    expect(events.filter(event => event.type === 'feedback/message-delete')).toMatchObject([{ data: { sessionId } }])
    expect(events.filter(event => event.type === 'turn/end')).toHaveLength(1)
    expect(agent.session.requestHeader()?.config.provider).toBe(provider)
    expect(captured()).toHaveLength(releasedCount)
    const wire = uploads.join('\n')
    for (const text of ['the diff view is unreadable', 'the second remark',
      'Read both files before answering.']) expect(wire).toContain(text)
    const feedback = events.flatMap<Record<string, string | undefined>>((event) => {
      switch (event.type) {
        case 'feedback/record': return [{ type: event.type, text: event.data.text }]
        case 'feedback/message-put': return [{ type: event.type, rating: event.data.item.rating, note: event.data.item.note }]
        case 'feedback/message-delete': return [{ type: event.type }]
        default: return []
      }
    })
    await compareOrRefreshGolden(RELEASE_EXPECTED, JSON.stringify({
      mode: 'FEEDBACK_ONLY', feedback,
      // The prefix is compared with each provider's actual canonical log above.
      laterSubmissionSuffixes: suffixes.slice(1),
    }, null, 2), MODE)
  }, 60_000)

  it.skipIf(MODE === 'record')('releases headerless feedback without capturing another session’s provider-change tail', async () => {
    await selectModel('Feedback mock')
    await selectModel('DeepSeek-V4-Flash')
    expect(captured()).toHaveLength(releasedCount)
    await page.getByRole('button', { name: 'New session', exact: true }).last().click()
    const input = page.locator('[data-composer-input][contenteditable="true"][data-placeholder="Describe what you want to build... / commands, @ files or sessions"]')
    await input.waitFor({ timeout: 15_000 })
    await input.fill('/feedback Feedback before any model request.')
    expect(captured()).toHaveLength(releasedCount)
    await input.press('Enter')
    const findHeaderless = () => scaffold.ctx.sessions.list().find(session => session.id !== sessionId
      && session.snapshotEvents().some(event => event.type === 'feedback/record'))
    // A command-only session keeps the hero view; its durable event confirms submission.
    await expect.poll(findHeaderless, { timeout: 10_000 }).toBeDefined()
    const headerless = findHeaderless()
    if (headerless === undefined) throw new Error('headerless feedback session not found')
    expect(headerless.requestHeader()).toBeUndefined()
    await scaffold.ctx.sessions.flush(headerless)
    const events = await readPersistedEvents(scaffold, headerless.id)
    const feedback = events.find(event => event.type === 'feedback/record')!
    headerlessExpected = events.filter(event => event.seq <= feedback.seq)
      .map(event => [headerless.id, event.seq, event.type])
    await expect.poll(captured, { timeout: 10_000 }).toEqual([
      ...authorized.map(event => [sessionId, event.seq, event.type]), ...headerlessExpected,
    ])
    expect(uploads.join('\n')).toContain('Feedback before any model request.')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ack.expected.md', 'ack-expanded.expected.md', 'feedback-release.expected.json'])
  })
})
