// Web e2e scenario: generic file upload round trip. A real chromium picks a
// file through the composer paperclip input; the upload RPC stores the exact
// bytes below the scaffold's isolated DSH_HOME, the prompt cites the staged
// reference, request assembly projects the file block to handle text, and the
// model (replayed or live) reads the saved copy with the REAL read tool. The
// content-addressed store makes the saved path identical across record and
// replay once the workspace cwd is tokenized, so the recorded read arguments
// replay verbatim against a freshly re-uploaded object.
// Record: DSH_SNAPSHOT=record rewrites session.v2.jsonl, then a keyless
// DSH_SNAPSHOT=refresh regenerates ui.expected.md.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/file-upload-round', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/file-upload-round/session.v2.jsonl', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/file-upload-round/ui.expected.md', import.meta.url))
const TRAJECTORY_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/file-upload-round/trajectory.expected.md', import.meta.url))
const OVERRIDE = fileURLToPath(new URL('../../../snapshots/web/file-upload-round/replay.override.json', import.meta.url))
const DRAFT_EXPECTED = fileURLToPath(new URL('./expected/file-upload-round/draft.expected.md', import.meta.url))
const HISTORY_EXPECTED = fileURLToPath(new URL('./expected/file-upload-round/history.expected.md', import.meta.url))
const IMAGE_FIXTURE = fileURLToPath(new URL('../../../snapshots/session/read-image/workspace/red.png', import.meta.url))
const MODE = webSnapshotMode()

/** The uploaded fixture file: constant bytes so record and replay share one content digest. */
const FILE_NAME = 'poem.txt'
const FILE_TEXT = 'UPLOAD_ROUND_OK\n'
const PROMPT = 'Read the attached file with the read tool, reply with exactly the single word it contains, and stop.'
const IMAGE_NAMES = Array.from({ length: 10 }, (_unused, index) => `reference-${String(index + 1)}.png`)

/** Browser-measured relations for the mixed composer attachment rail. */
interface DraftRailGeometry {
  readonly order: readonly string[]
  readonly oneGroup: boolean
  readonly oneRow: boolean
  readonly equalHeight: boolean
  readonly fileWider: boolean
  readonly horizontalOverflow: boolean
  readonly noWrap: boolean
}

/** Render stable relations instead of platform-dependent absolute coordinates. */
function renderDraftRailGeometry(geometry: DraftRailGeometry): string {
  return [
    '# Mixed composer attachment rail',
    '',
    `- selection order: ${geometry.order.join(' > ')}`,
    `- one attachment group: ${String(geometry.oneGroup)}`,
    `- all cards share one row: ${String(geometry.oneRow)}`,
    `- every card is 64px high: ${String(geometry.equalHeight)}`,
    `- the file card is wider than an image: ${String(geometry.fileWider)}`,
    `- overflowing cards scroll horizontally: ${String(geometry.horizontalOverflow)}`,
    `- the rail does not wrap: ${String(geometry.noWrap)}`,
  ].join('\n')
}

/** Browser-measured relations for one durable mixed-attachment message. */
interface HistoryAttachmentGeometry {
  readonly order: readonly string[]
  readonly oneGroup: boolean
  readonly oneRow: boolean
  readonly equalHeight: boolean
  readonly imageIsTile: boolean
  readonly fileWider: boolean
  readonly wrapsWhenNeeded: boolean
  readonly rightAligned: boolean
}

/** Render stable history-layout relations instead of absolute coordinates. */
function renderHistoryAttachmentGeometry(geometry: HistoryAttachmentGeometry): string {
  return [
    '# Mixed history attachment flow',
    '',
    `- source order: ${geometry.order.join(' > ')}`,
    `- one attachment group: ${String(geometry.oneGroup)}`,
    `- file and image share one row: ${String(geometry.oneRow)}`,
    `- both cards are 64px high: ${String(geometry.equalHeight)}`,
    `- the image is a 64px tile: ${String(geometry.imageIsTile)}`,
    `- the file card is wider than the image: ${String(geometry.fileWider)}`,
    `- the group wraps when needed: ${String(geometry.wrapsWhenNeeded)}`,
    `- the group is right-aligned: ${String(geometry.rightAligned)}`,
  ].join('\n')
}

describe('web e2e: generic file upload through the real assembly', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      compareReplaySession: true,
      // The override rescripts the recorded read arguments with a
      // `{{fromRequest:…}}` placeholder: the saved-copy path differs per run,
      // and the live handle line in the request carries the current one.
      ...(MODE === 'record' ? {} : { replayFixture: FIXTURE, replayOverride: OVERRIDE, paceMs: 15 }),
    })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.setViewportSize({ width: 900, height: 900 })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('uploads on pick, gates send on the staged receipt, and settles the turn (all modes)', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-file-upload-drive'))
    if (MODE !== 'record') {
      // Drift guard: the committed fixture must carry exactly the drive prompt.
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    }
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })
    const modelTrigger = page.getByRole('button', { name: /^Select model, current/ })
    await modelTrigger.click()
    await page.getByRole('menuitem', { name: /^Model\b/ }).click()
    await page.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash-Vision-Exp' }).click()
    await expect.poll(() => modelTrigger.getAttribute('aria-label'), { timeout: 10_000 })
      .toContain('DeepSeek-V4-Flash-Vision-Exp')
    const imageBytes = await readFile(IMAGE_FIXTURE)
    // Pick through the composer's hidden file input: the upload RPC runs
    // immediately and the pending card appears before any prompt is typed.
    await page.locator('input[type="file"]').setInputFiles([
      { name: FILE_NAME, mimeType: 'text/plain', buffer: Buffer.from(FILE_TEXT) },
      ...IMAGE_NAMES.map(name => ({ name, mimeType: 'image/png', buffer: imageBytes })),
    ])
    await page.getByTitle(FILE_NAME).waitFor({ timeout: 10_000 })
    const rail = page.getByRole('group', { name: 'Pending attachments' })
    await expect.poll(() => rail.locator(':scope > *').count(), { timeout: 10_000 })
      .toBe(IMAGE_NAMES.length + 1)
    const geometry = await rail.evaluate((element): DraftRailGeometry => {
      const cards = [...element.children] as HTMLElement[]
      const boxes = cards.map(card => card.getBoundingClientRect())
      const imageWidth = boxes[cards.findIndex(card => card.querySelector('img') !== null)]?.width ?? 0
      const fileWidth = boxes[cards.findIndex(card => card.querySelector('[title="poem.txt"]') !== null)]?.width ?? 0
      return {
        order: cards.map(card => card.querySelector('img')?.getAttribute('alt')
          ?? card.querySelector<HTMLElement>('[title]')?.title ?? ''),
        oneGroup: document.querySelectorAll('[role="group"][aria-label="Pending attachments"]').length === 1,
        oneRow: boxes.every(box => Math.abs(box.top - (boxes[0]?.top ?? box.top)) < 0.5),
        equalHeight: boxes.every(box => Math.abs(box.height - 64) < 0.5),
        fileWider: fileWidth > imageWidth,
        horizontalOverflow: element.scrollWidth > element.clientWidth,
        noWrap: getComputedStyle(element).flexWrap === 'nowrap',
      }
    })
    await compareOrRefreshGolden(DRAFT_EXPECTED, renderDraftRailGeometry(geometry), MODE)
    for (const name of IMAGE_NAMES.slice(1)) {
      await page.getByRole('button', { name: `Remove image ${name}` }).click({ force: true })
    }
    await expect.poll(() => rail.locator(':scope > *').count(), { timeout: 10_000 }).toBe(2)
    await input.fill(PROMPT)
    // Send unlocks only after the upload receipt lands (the staged file gate).
    const send = page.getByRole('button', { name: 'Send message' })
    await send.waitFor({ state: 'visible', timeout: 15_000 })
    await expect.poll(() => send.isEnabled(), { timeout: 15_000 }).toBe(true)
    const settled = scaffold.whenTurnSettled()
    await send.click()
    const restoreDeadline = Date.now() + 10_000
    let retainedCards = 0
    while (retainedCards === 0
      && !sessionEvents.some(event => event.type === 'turn/start')
      && Date.now() < restoreDeadline) {
      await page.waitForTimeout(100)
      retainedCards = await rail.locator(':scope > *').count()
    }
    if (retainedCards !== 0) {
      const feedback = await page.locator('[role="alert"], [role="status"]').allTextContents()
      throw new Error(`submission retained ${String(retainedCards)} draft cards; feedback=${JSON.stringify(feedback)}; events=${sessionEvents.map(event => event.type).join(',')}`)
    }
    const sessionId = await settled
    if (MODE === 'record') await recordFixture(scaffold, sessionId, FIXTURE)
  }, 200_000)

  it.skipIf(MODE === 'record')('persists the file block and reads the stored copy with the real read tool', () => {
    const userMessage = sessionEvents.find(
      (event): event is Extract<SessionEvent, { type: 'user/message' }> =>
        event.type === 'user/message' && event.data.source.kind === 'user',
    )
    if (userMessage === undefined) throw new Error('the replayed turn recorded no user message')
    const fileBlock = userMessage.data.content.find(block => block.type === 'file')
    if (fileBlock?.type !== 'file') throw new Error('the user message carries no file block')
    expect(fileBlock.attachment.name).toBe(FILE_NAME)
    expect(fileBlock.attachment.bytes).toBe(Buffer.byteLength(FILE_TEXT))
    expect(String(fileBlock.attachment.attachmentId)).toMatch(/^sha256:[0-9a-f]{64}$/)

    const readCall = sessionEvents.find(
      (event): event is Extract<SessionEvent, { type: 'tool/call' }> =>
        event.type === 'tool/call' && event.data.name === 'read',
    )
    if (readCall === undefined) throw new Error('the replayed turn did not call the read tool')
    expect(readCall.data.arguments).toContain(FILE_NAME)
    const readResult = sessionEvents.find(
      (event): event is Extract<SessionEvent, { type: 'tool/result' }> =>
        event.type === 'tool/result' && event.data.message.source.callId === readCall.data.callId,
    )
    if (readResult === undefined) throw new Error('the read call produced no durable result')
    const content = readResult.data.message.content[0]
    expect(content.isError).toBe(false)
    expect(content.content.filter(block => block.type === 'text').map(block => block.text).join(''))
      .toContain('UPLOAD_ROUND_OK')

    const turnEnds = sessionEvents.filter(event => event.type === 'turn/end')
    expect(turnEnds.length).toBe(1)
    expect((turnEnds[0] as SessionEvent & { data: { reason: { kind: string } } }).data.reason.kind).toBe('completed')
  })

  it.skipIf(MODE === 'record')('renders the durable file card beside the settled answer', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-file-upload-aria'))
    await expect.poll(() => page.getByText('UPLOAD_ROUND_OK', { exact: false }).count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1)
    await page.getByTitle(FILE_NAME).first().waitFor({ timeout: 10_000 })
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
  })

  it.skipIf(MODE === 'record')('keeps a mixed durable message in one ordered wrapping attachment flow', async () => {
    const groups = page.locator('[data-message-attachments]')
    await expect.poll(() => groups.count(), { timeout: 10_000 }).toBe(1)
    const geometry = await groups.first().evaluate((element): HistoryAttachmentGeometry => {
      const cards = [...element.children] as HTMLElement[]
      const renderedCards = cards.map((card) => {
        const box = card.getBoundingClientRect()
        return box.width === 0 && box.height === 0 && card.firstElementChild instanceof HTMLElement
          ? card.firstElementChild
          : card
      })
      const boxes = renderedCards.map(card => card.getBoundingClientRect())
      const imageIndex = cards.findIndex(card => card.querySelector('img') !== null)
      const fileIndex = cards.findIndex(card => card.getAttribute('title') === 'poem.txt')
      const imageBox = boxes[imageIndex]
      const fileBox = boxes[fileIndex]
      return {
        order: cards.map(card => card.getAttribute('title') ?? card.querySelector('img')?.getAttribute('alt') ?? ''),
        oneGroup: document.querySelectorAll('[data-message-attachments]').length === 1,
        oneRow: boxes.every(box => Math.abs(box.top - (boxes[0]?.top ?? box.top)) < 0.5),
        equalHeight: boxes.every(box => Math.abs(box.height - 64) < 0.5),
        imageIsTile: imageBox !== undefined && Math.abs(imageBox.width - 64) < 0.5,
        fileWider: fileBox !== undefined && imageBox !== undefined && fileBox.width > imageBox.width,
        wrapsWhenNeeded: getComputedStyle(element).flexWrap === 'wrap',
        rightAligned: getComputedStyle(element).justifyContent === 'flex-end',
      }
    })
    await compareOrRefreshGolden(HISTORY_EXPECTED, renderHistoryAttachmentGeometry(geometry), MODE)
  })

  it.skipIf(MODE === 'record')('marks the durable file in Trajectory without copying the Chat card', async () => {
    await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
    await page.getByLabel('Trajectory timeline').waitFor({ timeout: 30_000 })
    await page.getByRole('row', { name: /Files ×1/ }).waitFor({ timeout: 10_000 })
    const snapshot = await captureStableAria(
      page,
      '[data-trajectory-row-key][aria-label*="Files ×1"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(TRAJECTORY_EXPECTED, snapshot, MODE)
  })

  it.skipIf(MODE === 'record')('stayed clean and kept the exact fixture inventory', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'session.v2.jsonl', 'replay.override.json', 'ui.expected.md', 'trajectory.expected.md',
    ])
  })
})
