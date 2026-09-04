// Keyless assembled-browser coverage for the shipped FEEDBACK_ONLY default
// over the Web bundles and the real host wire. The scaffold mounts the
// shipped telemetry row in FEEDBACK_ONLY mode against this suite's own
// loopback mock collector, so the default release path is real: /feedback
// releases the session records through that event (exactly one OTLP request,
// carrying the drive prompt and the feedback text), the acknowledgement pins
// the feedback-gated disclosure sentence, and a second feedback releases only
// the records since the first handoff — the earlier prompt does not repeat.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { gunzipSync } from 'node:zlib'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureExpandedTurnProcessAria, captureStableAria,
  compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/feedback-release', import.meta.url))
// The release path needs only a settled ordinary turn, so this lane replays
// the feedback-command scenario's recorded session (declared as this
// manifest's `session.source`) instead of recording a duplicate.
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/feedback-command/session.v2.jsonl', import.meta.url))
const ACK_EXPECTED = join(SNAPSHOT_DIR, 'ack.expected.md')
const ACK_EXPANDED_EXPECTED = join(SNAPSHOT_DIR, 'ack-expanded.expected.md')
const MODE = webSnapshotMode()

const PROMPT = 'Reply with the single word LIGHTHOUSE and stop.'

describe('web e2e: feedback-gated release under the shipped default mode', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let collector: Server
  const uploads: string[] = []

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
      // The replayed session.v2.jsonl belongs to the feedback-command scenario;
      // comparing (or refreshing) the persisted session here would rewrite
      // that shared source with this lane's feedback events. The release
      // evidence lives in this lane's golden and collector assertions.
      compareReplaySession: false,
      ...(MODE === 'record' ? {} : { replayFixture: FIXTURE }),
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    collector?.close()
    collector?.closeAllConnections()
  })

  it('drives the recorded prompt to a settled turn (all modes)', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-feedback-release-drive'))
    if (MODE !== 'record') {
      // Drift guard: the shared fixture must carry exactly the drive prompt.
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    }
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled()
    await input.fill(PROMPT)
    await input.press('Enter')
    await settled
  }, 60_000)

  it.skipIf(MODE === 'record')('releases the session records through the feedback and pins the disclosure', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-feedback-release'))
    await page.getByText('LIGHTHOUSE', { exact: true }).waitFor({ timeout: 15_000 })
    expect(uploads).toEqual([])
    const input = page.locator('[data-composer-input]').first()
    await input.fill('/feedback the diff view is unreadable')
    await input.press('Enter')

    await page.getByText(/Feedback recorded for session/).waitFor({ timeout: 10_000 })
    expect(await page.getByText(/recording feedback uploads the session records not yet shared/).count()).toBe(1)

    // FEEDBACK_ONLY releases through the committed feedback event: exactly
    // one request reaches the collector, carrying the whole unshared range.
    await expect.poll(() => uploads.length, { timeout: 15_000 }).toBe(1)
    expect(uploads[0]).toContain('the diff view is unreadable')
    expect(uploads[0]).toContain(PROMPT)

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

  it.skipIf(MODE === 'record')('releases only the records since the last handoff on a second feedback', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-feedback-release-suffix'))
    const input = page.locator('[data-composer-input]').first()
    await input.fill('/feedback the second remark')
    await input.press('Enter')
    await expect.poll(() => uploads.length, { timeout: 15_000 }).toBe(2)
    // Suffix semantics: the second release starts after the first feedback's
    // handoff, so the drive prompt already shared must not repeat.
    expect(uploads[1]).toContain('the second remark')
    expect(uploads[1]).not.toContain(PROMPT)
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ack.expected.md', 'ack-expanded.expected.md'])
  })
})
