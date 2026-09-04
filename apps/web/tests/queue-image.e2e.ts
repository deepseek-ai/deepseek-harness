// Keyless browser coverage for image attachments submitted while a turn is
// running, through the shipped Web composition and real HTTP/SSE wire. A
// text-plus-image submission queues as one occurrence whose dock row renders
// the durable thumbnail, survives a stop as parked work, and delivers as the
// next turn's user message with its image intact — while the session log holds
// only durable attachment references, never base64.
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { deriveReplayScript, parseSessionLog, type ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/queued-image', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/live-interactions/session.v2.jsonl', import.meta.url))
const PNG = fileURLToPath(new URL('../../../snapshots/session/read-image/workspace/red.png', import.meta.url))
const QUEUED_EXPECTED = join(SNAPSHOT_DIR, 'queued.expected.md')
const DELIVERED_EXPECTED = join(SNAPSHOT_DIR, 'delivered.expected.md')
const MODE = webSnapshotMode()

const ACTIVE_PROMPT = 'Reply with a one-sentence description of event sourcing, then stop.'
const QUEUED_TEXT = 'Compare with this screenshot'

/** Paste one real PNG into the composer through a genuine clipboard event. */
async function pasteImage(page: Page, bytes: Uint8Array): Promise<void> {
  await page.locator('[data-composer-input]').first().evaluate((surface, data) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array(data)], 'queued.png', { type: 'image/png' }))
    surface.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: transfer, bubbles: true, cancelable: true,
    }))
  }, [...bytes])
}

describe('web e2e: queued image submission', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  let overrideDir: string | undefined

  afterEach(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    browser = undefined
    const closing = scaffold
    scaffold = undefined
    await closing?.close().catch((error: unknown) => failures.push(error))
    if (overrideDir !== undefined) {
      await rm(overrideDir, { recursive: true, force: true })
        .catch((error: unknown) => failures.push(error))
    }
    overrideDir = undefined
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'queued-image teardown failed')
  })

  it.skipIf(MODE === 'record')('queues a text-plus-image submission with a thumbnail and delivers it as the next turn', async () => {
    overrideDir = await mkdtemp(join(tmpdir(), 'dsh-web-queued-image-'))
    const readyFile = join(overrideDir, '.hang-ready')
    const overridePath = join(overrideDir, 'replay.override.json')
    const recorded = deriveReplayScript(parseSessionLog(await readFile(FIXTURE, 'utf8')))
    expect(recorded).toHaveLength(1)
    const replay: ReplayEntry[] = [
      { kind: 'hang', readyFile },
      recorded[0]!,
      recorded[0]!,
    ]
    await writeFile(overridePath, JSON.stringify(replay))

    const sessionEvents: SessionEvent[] = []
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE, replayOverride: overridePath, compareReplaySession: false })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-queued-image'))

    const input = page.locator('[data-composer-input]').first()
    const firstSettled = scaffold.whenTurnSettled()
    await input.fill(ACTIVE_PROMPT)
    await input.press('Enter')
    await expect.poll(() => existsSync(readyFile), { timeout: 15_000 }).toBe(true)

    // A just-submitted composer is read-only for the prompt round-trip.
    await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor({ timeout: 10_000 })
    await pasteImage(page, await readFile(PNG))
    await page.getByRole('img', { name: 'queued.png' }).waitFor({ timeout: 10_000 })
    await input.fill(QUEUED_TEXT)
    await input.press('Enter')

    // The queued row renders the durable thumbnail beside the text preview.
    const dockThumb = page.locator('[data-queue-dock] img[alt="Queued message image"]')
    await dockThumb.waitFor({ timeout: 15_000 })
    await expect.poll(() => dockThumb.getAttribute('src')).toMatch(/^blob:/)
    await page.getByText(QUEUED_TEXT, { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Remove queued message' }).waitFor({ timeout: 15_000 })
    const queuedSnapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(QUEUED_EXPECTED, queuedSnapshot, MODE)

    // Stop parks the accepted queue; the next waking send delivers the image
    // message first (FIFO), then its own text as the following turn.
    await page.getByRole('button', { name: 'Stop generating' }).click()
    await firstSettled
    await expect.poll(() => page.getByRole('button', { name: 'Stop generating' }).count()).toBe(0)
    await dockThumb.waitFor({ timeout: 10_000 })

    const settled = scaffold.whenTurnSettled()
    await input.fill('Continue with the queued comparison')
    await input.press('Enter')
    await settled
    // The queued image message and the waking text run as two further turns;
    // wait for both to end so the final snapshot never captures a mid-reply
    // frame (the aborted first turn precedes them).
    await expect.poll(
      () => sessionEvents.flatMap(event => event.type === 'turn/end' ? [event.data.reason.kind] : []),
      { timeout: 15_000 },
    ).toEqual(['aborted', 'completed', 'completed'])

    // The delivered user message renders its image in Chat from the durable
    // reference, and the dock row is gone.
    await expect.poll(
      () => page.locator('[data-queue-dock]').count(),
      { timeout: 15_000 },
    ).toBe(0)
    const chatImage = page.locator('[class*="userRow"] img')
    await chatImage.first().waitFor({ timeout: 15_000 })
    const deliveredSnapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(DELIVERED_EXPECTED, deliveredSnapshot, MODE)

    // Model-visible means logged: the delivered message carries the durable
    // reference (never base64), in the composer's canonical images-then-text order.
    const delivered = sessionEvents.find(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'image'))
    expect(delivered?.type === 'user/message' && delivered.data.content.map(block => block.type)).toEqual(['image', 'text'])
    const imageBlock = delivered?.type === 'user/message'
      ? delivered.data.content.find(block => block.type === 'image')
      : undefined
    expect(imageBlock?.type === 'image' && imageBlock.attachment.name).toBe('queued.png')
    expect(JSON.stringify(sessionEvents)).not.toContain('base64')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)
})
