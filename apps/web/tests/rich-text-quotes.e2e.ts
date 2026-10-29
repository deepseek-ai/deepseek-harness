/** Keyless real-Web coverage for quote selection, persistence, and uniform reference presentation. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import { SessionId } from '@deepseek-ai/dsh-session'
import { formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference'
import { formatQuoteText } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  parseSeedFixture, renderSeedFixture, seedSession, selectedSessionFixture, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, pinBrowserClock, pinHostClock, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/rich-text-quotes', import.meta.url))
const BORROWED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.jsonl', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/rich-text-quotes/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SESSION_ID = 'rich-text-quotes-web-e2e'
const OTHER_ID = 'rich-text-quotes-other'
const LEGACY_DRAFT_KEY = `dsh.conversation.${SESSION_ID}`
const CURRENT_DRAFT_KEY = `dsh.conversation.${SESSION_ID}`
const LEGACY_DRAFT = JSON.stringify({ draft: 'Imported plain draft', view: 'chat', viewRequest: null })
const SOURCE_TEXT = 'Durable source phrase selected from an earlier message and preserved as structured quote metadata.'
const THINKING_TEXT = 'Settled reasoning source'
const LITERAL_CREDENTIAL = 'sk-1234567890abcdefghijklmnopqrstuvwxyz'
const SESSION_MENTION = formatSessionReferenceMention({ sessionId: SessionId(OTHER_ID), label: 'Quote source' })
const DIRECT_SYNTAX_TEXT = [
  `/quoted-demo ${SESSION_MENTION} ${LITERAL_CREDENTIAL} **literal Markdown**`,
  ...Array.from({ length: 80 }, (_, index) => `Quote line ${String(index + 1)} contains preserved text.`),
  'End of long quote.',
].join('\n')
const SELECTED_SYNTAX_TEXT = DIRECT_SYNTAX_TEXT.replaceAll('\n', ' ')
const SENT_SYNTAX_TEXT = SELECTED_SYNTAX_TEXT.replace(SESSION_MENTION, '@Quote source')
const REPLY = 'Quote received.'

async function quoteAppearance(quote: Locator): Promise<Record<string, string>> {
  return quote.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      alignItems: style.alignItems,
      color: style.color,
      display: style.display,
      fontSize: style.fontSize,
      gap: style.gap,
      lineHeight: style.lineHeight,
      margin: style.margin,
      padding: style.padding,
    }
  })
}

const REPLAY: ReplayOverrideDoc = [{
  kind: 'chunks',
  chunks: [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: REPLY },
    { type: 'block-end', index: 0, block: { type: 'text', text: REPLY } },
    { type: 'usage', usage: { inputTokens: 128, outputTokens: 8 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ],
}]

function quoteHistoryFixture(raw: string): string {
  const { headerLine } = parseSeedFixture(raw)
  let seq = 0
  let time = 0
  const events: Array<Record<string, unknown> & { seq: number; time: number }> = []
  const at = (event: Record<string, unknown>): number => {
    const assigned = seq++
    events.push({ ...event, seq: assigned, time: time++ })
    return assigned
  }
  at({ type: 'turn/start', data: { turn: 1 } })
  at({
    type: 'user/message',
    data: {
      id: '{{message:1}}',
      role: 'user',
      content: [{ type: 'text', text: SOURCE_TEXT }],
      source: { kind: 'user', rpcId: '{{rpc:1}}' },
    },
    surfaceOp: 'append',
  })
  for (let ordinal = 2; ordinal <= 51; ordinal++) {
    at({
      type: 'user/message',
      data: {
        id: `{{message:${String(ordinal)}}}`,
        role: 'user',
        content: [{
          type: 'text',
          text: ordinal === 2 ? formatQuoteText(DIRECT_SYNTAX_TEXT) : `Filler message ${String(ordinal)}`,
        }],
        source: { kind: 'user', rpcId: `{{rpc:${String(ordinal)}}}` },
      },
      surfaceOp: 'append',
    })
  }
  at({
    type: 'user/message',
    data: {
      id: '{{message:52}}',
      role: 'user',
      content: [
        { type: 'text', text: `> ${SOURCE_TEXT}` },
        { type: 'text', text: '\n\nUse that excerpt.' },
      ],
      source: {
        kind: 'user',
        rpcId: '{{rpc:52}}',
      },
    },
    surfaceOp: 'append',
  })
  at({
    type: 'session/title',
    data: {
      title: 'Quote history',
      messageSeqs: Array.from({ length: 52 }, (_value, index) => index + 1),
      source: { kind: 'fallback' },
    },
  })
  at({ type: 'step/start', data: { turn: 1, step: 1 } })
  at({
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: '{{message:53}}',
        role: 'assistant',
        content: [
          { type: 'reasoning', text: THINKING_TEXT },
          { type: 'text', text: 'Quote fixture ready.' },
        ],
        source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      },
      stream: [
        { type: 'chunk', time: 0, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
        { type: 'reasoning-chunks', time0: 0, index: 0, dt: [], texts: [THINKING_TEXT] },
        { type: 'chunk', time: 0, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: THINKING_TEXT } } },
        { type: 'chunk', time: 0, chunk: { type: 'block-start', index: 1, blockType: 'text' } },
        { type: 'text-chunks', time0: 0, index: 1, dt: [], texts: ['Quote fixture ready.'] },
        { type: 'chunk', time: 0, chunk: { type: 'block-end', index: 1, block: { type: 'text', text: 'Quote fixture ready.' } } },
        { type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } },
      ],
    },
    surfaceOp: 'append',
  })
  at({ type: 'step/end', data: { turn: 1, step: 1 } })
  at({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  return renderSeedFixture(headerLine, events)
}

function otherSessionFixture(raw: string): string {
  const { headerLine } = parseSeedFixture(raw)
  let seq = 0
  const events: Array<Record<string, unknown> & { seq: number; time: number }> = []
  const at = (event: Record<string, unknown>): void => {
    events.push({ ...event, seq, time: seq })
    seq += 1
  }
  at({ type: 'turn/start', data: { turn: 1 } })
  at({
    type: 'user/message', surfaceOp: 'append',
    data: {
      id: '{{message:1}}', role: 'user',
      content: [{ type: 'text', text: 'Other session.' }],
      source: { kind: 'user', rpcId: '{{rpc:1}}' },
    },
  })
  at({ type: 'session/title', data: { title: 'Other session', messageSeqs: [1], source: { kind: 'fallback' } } })
  at({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  return renderSeedFixture(headerLine, events)
}

async function selectAllText(locator: Locator): Promise<void> {
  await locator.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
}

async function expectEllipsizedQuote(box: Locator, text: Locator, container: Locator): Promise<number> {
  const [quoteBounds, containerBounds, presentation] = await Promise.all([
    box.boundingBox(),
    container.boundingBox(),
    text.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflow: style.overflow,
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace,
      }
    }),
  ])
  expect(quoteBounds).not.toBeNull()
  expect(containerBounds).not.toBeNull()
  const expectedMaximum = Math.min(containerBounds!.width * 0.8, 300)
  expect(quoteBounds!.width).toBeLessThanOrEqual(expectedMaximum + 1)
  expect(presentation.overflow).toBe('hidden')
  expect(presentation.textOverflow).toBe('ellipsis')
  expect(presentation.whiteSpace).toBe('nowrap')
  expect(presentation.scrollWidth).toBeGreaterThan(presentation.clientWidth)
  return quoteBounds!.width
}

async function openQuoteSession(page: Page): Promise<void> {
  await page.locator(`[data-row-key="session:${SESSION_ID}"]`).click()
}

async function expectScrollableQuote(page: Page, quote: Locator, text: string): Promise<void> {
  await quote.hover()
  const content = page.locator('[data-quote-popover]')
  await expect.poll(() => content.textContent()).toBe(text)
  const panel = content.locator('..')
  await expect.poll(async () => {
    const bounds = await panel.boundingBox()
    return bounds !== null && bounds.y >= 8 && bounds.y + bounds.height <= page.viewportSize()!.height - 8
  }).toBe(true)
  await panel.hover()
  await page.mouse.wheel(0, 10_000)
  await expect.poll(() => panel.evaluate(element => ({
    scrolled: element.scrollTop > 0,
    atEnd: element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
  }))).toEqual({ scrolled: true, atEnd: true })
  expect(await content.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let last: Node | null = null
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) last = node
    if (last === null) return false
    const length = last.textContent?.length ?? 0
    const range = document.createRange()
    range.setStart(last, length - 'End of long quote.'.length)
    range.setEnd(last, length)
    const end = range.getBoundingClientRect()
    const panelBounds = element.parentElement!.getBoundingClientRect()
    return end.top >= panelBounds.top && end.bottom <= panelBounds.bottom
  })).toBe(true)
  await page.mouse.move(0, 0)
  await expect.poll(() => content.count()).toBe(0)
}

async function crossQuoteGap(page: Page, quote: Locator, text: string, placement: 'above' | 'below'): Promise<void> {
  await quote.hover()
  const content = page.locator('[data-quote-popover]')
  await expect.poll(() => content.count()).toBe(1)
  await expect.poll(() => content.textContent()).toBe(text)
  const anchor = (await quote.locator('..').boundingBox())!
  const panel = (await content.locator('..').boundingBox())!
  expect(panel.width).toBeLessThan(300)
  const above = panel.y < anchor.y
  expect(above).toBe(placement === 'above')
  const x = Math.max(anchor.x, panel.x) + Math.min(anchor.width, panel.width) / 2
  const y = above ? (panel.y + panel.height + anchor.y) / 2 : (anchor.y + anchor.height + panel.y) / 2
  expect(await page.evaluate(point =>
    Boolean(document.elementFromPoint(point.x, point.y)?.closest('[data-hovercard-bridge]')), { x, y })).toBe(true)
  await page.mouse.move(x, y, { steps: 8 })
  await page.evaluate(() => new Promise<void>((resolve) => { requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) }) }))
  await expect.poll(() => content.count()).toBe(1)
  expect(await content.textContent()).toBe(text)
  await content.hover()
  const body = (await content.boundingBox())!
  await page.mouse.move(body.x + 12, body.y + 15)
  await page.mouse.down()
  await page.mouse.move(body.x + 60, body.y + 15, { steps: 5 })
  await page.mouse.up()
  expect(await page.evaluate(() => window.getSelection()?.toString().trim())).not.toBe('')
  expect(await content.count()).toBe(1)
  await page.keyboard.press('Escape')
  await expect.poll(() => content.count()).toBe(0)
}

describe.skipIf(MODE === 'record')('web e2e: rich-text quotes', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let replayDir: string
  let tripwire: ReturnType<typeof watchConsole>
  let hostClock: ReturnType<typeof pinHostClock> | undefined

  beforeAll(async () => {
    hostClock = pinHostClock()
    replayDir = await mkdtemp(join(tmpdir(), 'dsh-rich-text-quotes-replay-'))
    const replayOverride = join(replayDir, 'replay.override.json')
    await writeFile(replayOverride, JSON.stringify(REPLAY))
    scaffold = await launchWebScaffold({
      replayFixture: join(replayDir, 'override-only.jsonl'),
      replayOverride,
    })
    const skillDir = join(scaffold.workspaceCwd, '.agents', 'skills', 'quoted-demo')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), [
      '---',
      'name: quoted-demo',
      'description: Example user-invoked skill',
      'disable-model-invocation: true',
      '---',
      '',
      'An example skill instruction.',
      '',
    ].join('\n'))
    const borrowed = await readFile(await selectedSessionFixture(BORROWED), 'utf8')
    const createdAt = Date.now() - 60_000
    await seedSession(scaffold, quoteHistoryFixture(borrowed), SESSION_ID, undefined, { createdAt })
    await seedSession(scaffold, otherSessionFixture(borrowed), OTHER_ID, undefined, { createdAt: createdAt + 1_000 })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await pinBrowserClock(page)
    await page.addInitScript(({ key, value }) => {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value)
    }, { key: LEGACY_DRAFT_KEY, value: LEGACY_DRAFT })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const group = page.getByRole('treeitem', { name: /Ungrouped/ })
    await group.waitFor({ timeout: 15_000 })
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
    await openQuoteSession(page)
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (replayDir !== undefined) {
      await rm(replayDir, { recursive: true, force: true })
        .catch((error: unknown) => failures.push(error))
    }
    hostClock?.mockRestore()
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'rich-text-quotes e2e cleanup failed')
  })

  it('renders and restores rich quotes with uniform styling after reference recognition', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-rich-text-quotes'))
    const input = page.locator('[data-composer-input]').first()
    await expect.poll(() => input.textContent()).toBe('Imported plain draft')
    await input.click()
    await input.press('ControlOrMeta+A')
    await input.press('Backspace')
    await expect.poll(() => input.textContent()).toBe('')
    const sentQuote = page.locator('[data-message-bubble] [data-quote-preview]').filter({ hasText: SOURCE_TEXT }).first()
    await sentQuote.waitFor({ timeout: 15_000 })
    await expect.poll(() => sentQuote.getAttribute('title')).toBeNull()
    await expect.poll(() => sentQuote.getAttribute('role')).toBeNull()
    await expect.poll(() => sentQuote.getAttribute('tabindex')).toBeNull()
    await expect.poll(() => sentQuote.locator('xpath=ancestor::*[@data-message-bubble][1]').textContent())
      .toBe(`${SOURCE_TEXT} Use that excerpt.`)
    const sentText = sentQuote.locator('[data-quote-preview-text]')
    const sentWidth = await expectEllipsizedQuote(
      sentQuote,
      sentText,
      sentQuote.locator('xpath=ancestor::*[@data-message-bubble][1]'),
    )
    const sentAppearance = await quoteAppearance(sentQuote)
    expect(sentAppearance.gap).toBe('4px')
    expect(sentAppearance.margin).toBe('0px')
    await sentQuote.hover()
    const quotePopover = page.locator('[data-quote-popover]')
    await expect.poll(() => quotePopover.textContent()).toBe(SOURCE_TEXT)
    const hoveredSentBounds = await sentQuote.boundingBox()
    expect(hoveredSentBounds).not.toBeNull()
    expect(hoveredSentBounds!.width).toBeCloseTo(sentWidth, 0)
    await quotePopover.hover()
    // Exceed the pointer grace to prove the panel itself keeps the popover open.
    await page.waitForTimeout(300)
    await expect.poll(() => quotePopover.count()).toBe(1)
    await page.mouse.move(0, 0)
    await expect.poll(() => quotePopover.count()).toBe(0)

    const sourceBlocks = page.locator('[data-text-interaction-source]').filter({ hasText: SOURCE_TEXT })
    const olderSource = page.getByRole('button', { name: 'Load earlier' })
    if (await sourceBlocks.count() < 2 && await olderSource.isVisible()) await olderSource.click()
    await expect.poll(() => sourceBlocks.count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
    const source = sourceBlocks.filter({ hasNot: page.locator('[data-quote-preview]') }).first()
    await source.waitFor()

    const quoteAction = page.getByRole('button', { name: 'Quote text', exact: true })
    await source.scrollIntoViewIfNeeded()
    await source.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', buttons: 1 })
    await selectAllText(source)
    await expect.poll(() => quoteAction.count()).toBe(0)
    await source.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'mouse', buttons: 0 })
    await expect.poll(() => quoteAction.count()).toBe(1)
    expect(await quoteAction.evaluate(element => element.closest('[data-chat-flow]') !== null)).toBe(true)
    expect(await quoteAction.evaluate(element => getComputedStyle(element.closest('[data-text-interaction-surface]')!).position)).toBe('absolute')
    await page.keyboard.press('Escape')
    await expect.poll(() => quoteAction.count()).toBe(0)
    await page.evaluate(() => window.dispatchEvent(new Event('resize')))
    await expect.poll(() => quoteAction.count()).toBe(0)
    await source.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 })
    await selectAllText(source)
    await source.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 0 })
    await expect.poll(() => quoteAction.count()).toBe(1)
    await input.click()
    await source.scrollIntoViewIfNeeded()
    await expect.poll(() => quoteAction.count()).toBe(0)
    await source.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 })
    await selectAllText(source)
    await source.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 0 })
    await expect.poll(() => quoteAction.count()).toBe(1)
    await page.locator('[data-conversation-scroll]').evaluate((element) => {
      element.scrollTop = element.scrollHeight
      element.dispatchEvent(new Event('scroll'))
    })
    await expect.poll(() => quoteAction.isVisible()).toBe(false)
    expect(await page.locator('[data-text-interaction-surface] button').count()).toBe(1)
    await source.scrollIntoViewIfNeeded()
    await expect.poll(() => quoteAction.isVisible()).toBe(true)
    await quoteAction.click()
    const draftQuote = page.locator('[data-composer-quote]')
    const draftPreview = draftQuote.locator('[data-quote-preview]')
    const draftPreviewText = draftPreview.locator('[data-quote-preview-text]')
    await expect.poll(() => draftQuote.count()).toBe(1)
    await expect.poll(() => draftQuote.textContent()).toContain(SOURCE_TEXT)
    const draftText = draftPreviewText
    await expect.poll(() => draftPreview.getAttribute('role')).toBeNull()
    await expect.poll(() => draftPreview.getAttribute('tabindex')).toBeNull()
    const draftWidth = await expectEllipsizedQuote(
      draftPreview,
      draftPreviewText,
      input,
    )
    expect(await quoteAppearance(draftPreview)).toEqual(sentAppearance)
    await draftText.hover()
    await expect.poll(() => quotePopover.textContent()).toBe(SOURCE_TEXT)
    const hoveredDraftBounds = await draftPreview.boundingBox()
    expect(hoveredDraftBounds).not.toBeNull()
    expect(hoveredDraftBounds!.width).toBeCloseTo(draftWidth, 0)
    await page.mouse.move(0, 0)
    await expect.poll(() => quotePopover.count()).toBe(0)
    await input.press('Backspace')
    await expect.poll(() => draftQuote.count()).toBe(0)
    await expect.poll(() => input.textContent()).toBe('')
    await input.press('ControlOrMeta+z')
    await expect.poll(() => draftQuote.count()).toBe(1)

    const removeQuote = draftQuote.getByRole('button', { name: 'Remove quote' })
    const removeIcons = removeQuote.locator('svg')
    await expect.poll(() => removeIcons.first().evaluate(element => getComputedStyle(element).opacity)).toBe('1')
    await expect.poll(() => removeIcons.last().evaluate(element => getComputedStyle(element).opacity)).toBe('0')
    await input.click()
    await page.keyboard.press('ControlOrMeta+A')
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain(SOURCE_TEXT)
    await draftQuote.hover()
    await expect.poll(() => removeIcons.first().evaluate(element => getComputedStyle(element).opacity)).toBe('0')
    await expect.poll(() => removeIcons.last().evaluate(element => getComputedStyle(element).opacity)).toBe('1')
    await removeQuote.focus()
    await expect.poll(() => removeIcons.last().evaluate(element => getComputedStyle(element).opacity)).toBe('1')
    await expectEllipsizedQuote(draftPreview, draftPreviewText, input)
    await removeQuote.click()
    await expect.poll(() => draftQuote.count()).toBe(0)
    await expect.poll(() => input.textContent()).toBe('')
    await expect.poll(() => page.evaluate(() => window.getSelection()?.isCollapsed ?? true)).toBe(true)
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => draftQuote.count()).toBe(1)

    await input.click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace')
    await expect.poll(() => draftQuote.count()).toBe(0)
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => draftQuote.count()).toBe(1)
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('Delete')
    await expect.poll(() => draftQuote.count()).toBe(0)
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => draftQuote.count()).toBe(1)

    await page.locator(`[data-row-key="session:${OTHER_ID}"]`).click()
    await openQuoteSession(page)
    await expect.poll(() => draftQuote.count()).toBe(1)

    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const restoredQuote = page.locator('[data-composer-quote]')
    await expect.poll(() => restoredQuote.count(), { timeout: 15_000 }).toBe(1)
    const restoredPreview = restoredQuote.locator('[data-quote-preview]')
    const restoredText = restoredQuote.locator('[data-quote-preview-text]')
    await expect.poll(() => restoredPreview.getAttribute('role')).toBeNull()
    await restoredText.click()

    await restoredQuote.getByRole('button', { name: 'Remove quote' }).click()
    await expect.poll(() => input.textContent()).toBe('')
    const process = page.locator('[data-turn-process]').first()
    if (await process.getAttribute('aria-expanded') === 'false') await process.click()
    await page.getByRole('button', { name: 'Analysis completed', exact: true }).click()
    const think = page.getByRole('button', { name: /Think/u })
    await think.click()
    const reasoningSource = page.locator('[data-text-interaction-source]').filter({ hasText: THINKING_TEXT })
    await reasoningSource.waitFor()
    await selectAllText(reasoningSource)
    await expect.poll(() => quoteAction.isVisible()).toBe(true)
    const beforeComposerScroll = await reasoningSource.evaluate((element) => {
      const scroller = element.closest<HTMLElement>('[data-conversation-scroll]')!
      const composer = scroller.querySelector<HTMLElement>('[data-composer-seat]')!
      const previous = scroller.scrollTop
      scroller.scrollTop -= composer.getBoundingClientRect().top - element.getBoundingClientRect().top + 16
      return previous
    })
    await expect.poll(() => reasoningSource.evaluate((element) => {
      const composer = element.closest('[data-conversation-scroll]')!.querySelector('[data-composer-seat]')!
      return element.getBoundingClientRect().top >= composer.getBoundingClientRect().top
    })).toBe(true)
    await expect.poll(() => quoteAction.isVisible()).toBe(false)
    expect(await page.locator('[data-text-interaction-surface] button').count()).toBe(1)
    await page.locator('[data-conversation-scroll]').evaluate((element, top) => { element.scrollTop = top }, beforeComposerScroll)
    await expect.poll(() => quoteAction.isVisible()).toBe(true)
    await quoteAction.click()
    await expect.poll(() => draftQuote.textContent()).toContain(THINKING_TEXT)
    await think.click()
    await expect.poll(() => reasoningSource.isVisible()).toBe(false)
    const reasoningQuote = draftQuote.locator('[data-quote-preview-text]')
    await expect.poll(() => draftQuote.locator('[data-quote-preview]').getAttribute('role')).toBeNull()
    await reasoningQuote.click()
    await expect.poll(() => reasoningSource.isVisible()).toBe(false)
    await expect.poll(() => think.getAttribute('aria-expanded')).toBe('false')

    const backToBottom = page.getByRole('button', { name: 'Back to bottom', exact: true })
    if (await backToBottom.isVisible()) await backToBottom.click()
    await expect.poll(() => backToBottom.isVisible()).toBe(false)

    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)

    await draftQuote.getByRole('button', { name: 'Remove quote' }).click()
    const loadEarlier = page.getByRole('button', { name: 'Load earlier' })
    if (await loadEarlier.isVisible()) await loadEarlier.click()
    await page.getByText('Filler message 3', { exact: true }).waitFor({ timeout: 15_000 })
    await page.locator('[data-conversation-scroll]').evaluate((element) => {
      element.scrollTop = 0
      element.dispatchEvent(new Event('scroll'))
    })
    const syntaxSource = page.locator('[data-text-interaction-source]').filter({ hasText: DIRECT_SYNTAX_TEXT }).first()
    await syntaxSource.waitFor({ timeout: 15_000 })
    await syntaxSource.scrollIntoViewIfNeeded()
    await selectAllText(syntaxSource)
    await quoteAction.click()
    const viewport = page.viewportSize()!
    try {
      await expectScrollableQuote(page, draftPreview, SELECTED_SYNTAX_TEXT)
      await page.setViewportSize({ width: 420, height: 420 })
      await expectScrollableQuote(page, draftPreview, SELECTED_SYNTAX_TEXT)
    } finally {
      await page.setViewportSize(viewport)
    }
    const beforeOffset = scaffold.ctx.agents.get(SessionId(SESSION_ID))!.session.seq
    const settled = scaffold.whenTurnSettled()
    await page.getByRole('button', { name: 'Send message' }).click()
    const settledSessionId = await settled
    await page.getByText(REPLY, { exact: true }).waitFor({ timeout: 20_000 })
    const longSentQuote = page.locator('[data-message-bubble] [data-quote-preview]').filter({ hasText: SENT_SYNTAX_TEXT }).last()
    try {
      await expectScrollableQuote(page, longSentQuote, SENT_SYNTAX_TEXT)
      await page.setViewportSize({ width: 420, height: 420 })
      await expectScrollableQuote(page, longSentQuote, SENT_SYNTAX_TEXT)
    } finally {
      await page.setViewportSize(viewport)
    }
    expect(await longSentQuote.textContent()).toContain(LITERAL_CREDENTIAL)
    const sentSource = longSentQuote.locator('[data-quote-preview-text]')
    expect(await sentSource.textContent()).toBe(SENT_SYNTAX_TEXT)
    expect(await sentSource.locator('*').count()).toBe(0)
    const textAppearance = await quoteAppearance(sentSource)
    const quoteStyle = await quoteAppearance(longSentQuote)
    expect(textAppearance.color).toBe(quoteStyle.color)
    expect(textAppearance.fontSize).toBe(quoteStyle.fontSize)
    expect(textAppearance.lineHeight).toBe(quoteStyle.lineHeight)
    expect(await longSentQuote.locator('[data-secret], [data-ref-chip], strong').count()).toBe(0)
    const events = scaffold.ctx.agents.get(settledSessionId)!.session.snapshotEvents(beforeOffset)
    expect(events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'skill-invocation')).toBe(true)
    expect(events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'session-reference')).toBe(true)
    const submitted = events.find(event => event.type === 'user/message'
      && event.data.source.kind === 'user')
    expect(submitted).toMatchObject({
      data: {
        content: [{ type: 'text', text: formatQuoteText(SENT_SYNTAX_TEXT) }],
      },
    })
    expect(submitted).not.toHaveProperty('data.source.quotes')
    await expect.poll(() => input.textContent()).toBe('')
    const persisted = await page.evaluate((key): unknown => JSON.parse(localStorage.getItem(key)!), CURRENT_DRAFT_KEY)
    expect(persisted).toMatchObject({ draft: { text: '', references: [] } })
    await page.reload({ waitUntil: 'load' })
    await page.getByText(REPLY, { exact: true }).waitFor({ timeout: 20_000 })
    await expectScrollableQuote(page, longSentQuote, SENT_SYNTAX_TEXT)
    const literalQuote = await captureStableAria(
      page, `[data-message-bubble]:has([data-quote-preview-text]):has-text("${LITERAL_CREDENTIAL}") >> nth=-1`, scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(UI_EXPECTED, `${snapshot}\n\n## Literal quote body\n\n${literalQuote}`, MODE)
    await expect.poll(() => input.textContent()).toBe('')
    expect(await page.locator('[data-slot-error]').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  }, 120_000)

  it('keeps adjacent quote previews exclusive while crossing their hover gaps', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-quote-hover-gap'))
    const texts = ['First excerpt', 'Second excerpt'].map(line => Array.from({ length: 6 }, () => line).join('\n'))
    const quoted = texts.map(formatQuoteText)
    const separator = '\nx\n'
    const draft = {
      text: quoted[0]! + separator + quoted[1]!, references: [],
      quotes: texts.map((text, index) => ({
        text, offset: index === 0 ? 0 : quoted[0]!.length + separator.length, length: quoted[index]!.length,
      })),
    }
    const viewport = page.viewportSize()!
    try {
      await page.evaluate(({ key, draft }) => {
        localStorage.setItem(key, JSON.stringify({ draft, view: 'chat', viewRequest: null }))
      }, { key: CURRENT_DRAFT_KEY, draft })
      await page.reload({ waitUntil: 'load' })
      const draftQuotes = page.locator('[data-composer-quote] [data-quote-preview]')
      await expect.poll(() => draftQuotes.count()).toBe(2)
      await crossQuoteGap(page, draftQuotes.last(), texts[1]!, 'above')
      const settled = scaffold.whenTurnSettled()
      await page.getByRole('button', { name: 'Send message' }).click()
      await settled
      await page.setViewportSize({ width: 600, height: 1000 })
      const sentQuotes = page.locator('[data-message-bubble] [data-quote-preview]').filter({ hasText: 'First excerpt' })
      await sentQuotes.last().waitFor()
      await sentQuotes.last().evaluate((element) => { element.scrollIntoView({ block: 'center' }) })
      await crossQuoteGap(page, sentQuotes.last(), texts[0]!, 'below')
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      await page.keyboard.press('Escape')
      await page.setViewportSize(viewport)
    }
  })

})
