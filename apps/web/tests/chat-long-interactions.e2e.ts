// Long-history Chat behavior contract that stays valid under a virtualized
// renderer: wheel input only navigates to the semantic target; assertions pin
// content identity and interaction routing rather than scroll geometry or
// mounted row counts.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayEntry, ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import {
  launchWebScaffold,
  seedSession,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { conversationContextKey, expandOwningTurnProcess, newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const SESSION_ID = 'chat-long-interactions-e2e'
const FIXTURE_TURNS = 88
const TOOL_TURN = FIXTURE_TURNS
const BRANCH_TURN = 80
const TARGET_CALL_1 = 'chat-scroll-088-1'
const TARGET_CALL_2 = 'chat-scroll-088-2'
const CONTINUE_PROMPT = 'CHAT_INTERACTION_CONTINUE Continue from this exact branch point.'
const CONTINUE_FIRST = 'CHAT_INTERACTION_CONTINUE_FIRST'
const CONTINUE_DONE = 'CHAT_INTERACTION_CONTINUE_DONE'
const FIXTURE = createChatScrollFixture({
  markerPrefix: 'INTERACTION',
  title: 'CHAT_INTERACTION long semantic identity session',
  turns: FIXTURE_TURNS,
})

function continuationChunks(): StreamChunk[] {
  const response = `${CONTINUE_FIRST} The fork retained the intended prefix. ${CONTINUE_DONE}.`
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: `${CONTINUE_FIRST} ` },
    { type: 'text-delta', index: 0, text: `The fork retained the intended prefix. ${CONTINUE_DONE}.` },
    { type: 'block-end', index: 0, block: { type: 'text', text: response } },
    { type: 'usage', usage: { inputTokens: 512, outputTokens: 32 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function replayEntry(chunks: StreamChunk[]): ReplayEntry {
  return { kind: 'chunks', chunks }
}

function carries(event: SessionEvent, marker: string): boolean {
  return JSON.stringify(event).includes(marker)
}

function textContent(content: readonly unknown[]): string {
  return content.flatMap((block) => {
    if (typeof block !== 'object' || block === null) return []
    const candidate = block as { type?: unknown; text?: unknown }
    return candidate.type === 'text' && typeof candidate.text === 'string'
      ? [candidate.text]
      : []
  }).join('')
}

async function nextPaint(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>(resolve => requestAnimationFrame(() => {
      requestAnimationFrame(() => { resolve() })
    }))
  })
}

async function openSeed(page: Page): Promise<void> {
  // The compact layout dropped group session counts; the seeded baseline is
  // the Ungrouped bucket once cold summaries load.
  await page.getByText('Ungrouped', { exact: true }).waitFor({ timeout: 30_000 })
  // Search collapsed into a header action; expand it before filling.
  const searchButton = page.getByRole('button', { name: 'Search sessions' })
  if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
  const search = page.getByRole('textbox', { name: 'Search sessions...', exact: true })
  await search.fill(FIXTURE.markers.user(1))
  const results = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  await results.first().waitFor({ timeout: 60_000 })
  const resultCount = await results.count()
  if (resultCount !== 1) throw new Error(`expected one seeded search result, received ${String(resultCount)}`)
  await results.click()
  await page.getByText(FIXTURE.markers.assistant(FIXTURE.turns), { exact: false })
    .last().waitFor({ timeout: 30_000 })
  await nextPaint(page)
}

async function wheelUntilMounted(page: Page, selector: string, deltaY: number): Promise<void> {
  const scrollport = page.locator('[data-conversation-scroll]')
  const box = await scrollport.boundingBox()
  if (box === null) throw new Error('conversation scrollport has no layout box')
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(140, box.height / 3))
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await page.locator(selector).count() > 0) return
    await page.mouse.wheel(0, deltaY)
    await nextPaint(page)
  }
  throw new Error(`semantic Chat target did not mount: ${selector}`)
}

function requiredEvent<T extends SessionEvent['type']>(
  events: readonly SessionEvent[],
  type: T,
  marker: string,
): Extract<SessionEvent, { type: T }> {
  const event = events.find((candidate): candidate is Extract<SessionEvent, { type: T }> => (
    candidate.type === type && carries(candidate, marker)
  ))
  if (event === undefined) throw new Error(`${type} carrying ${marker} is absent`)
  return event
}

function messageKey(event: SessionEvent<'user/message'>): string {
  return conversationContextKey('input-message', String(event.data.id))
}

function assistantKey(event: SessionEvent<'assistant/message'>): string {
  return conversationContextKey('assistant-step', `${event.data.turn}:${event.data.step}`)
}

function turnTailKey(turn: number): string {
  return conversationContextKey('turn-tail', String(turn))
}

describe('web e2e: long Chat interaction contract', () => {
  let browser: Browser
  let page: Page
  let replayDir: string
  let scaffold: WebScaffold
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    replayDir = await mkdtemp(join(tmpdir(), 'dsh-chat-interaction-replay-'))
    const replayOverride = join(replayDir, 'replay.override.json')
    const replay: ReplayOverrideDoc = [replayEntry(continuationChunks())]
    await writeFile(replayOverride, JSON.stringify(replay))
    scaffold = await launchWebScaffold({
      replayFixture: join(replayDir, 'override-only.jsonl'),
      replayOverride,
      replayContextWindow: 10_000_000,
      paceMs: 18,
    })
    await seedSession(scaffold, FIXTURE.log, SESSION_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser, 900)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await openSeed(page)
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (replayDir !== undefined) {
      await rm(replayDir, { recursive: true, force: true })
        .catch((error: unknown) => failures.push(error))
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'long Chat interaction cleanup failed')
  })

  it.skipIf(MODE === 'record')('keeps heterogeneous rows and their actions bound to exact semantic identities', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-chat-long-interactions'))
    await expect.poll(
      () => scaffold.ctx.agents.get(SessionId(SESSION_ID)) !== undefined,
      { timeout: 10_000 },
    ).toBe(true)
    const source = scaffold.ctx.agents.get(SessionId(SESSION_ID))
    if (source === undefined) throw new Error('seeded long-history agent is not attached')

    const toolUserMarker = FIXTURE.markers.user(TOOL_TURN)
    const toolAssistantMarker = FIXTURE.markers.assistant(TOOL_TURN)
    const toolMarker1 = FIXTURE.markers.tool(TOOL_TURN, 1)
    const toolMarker2 = FIXTURE.markers.tool(TOOL_TURN, 2)
    const toolUserEvent = requiredEvent(source.session.snapshotEvents(), 'user/message', toolUserMarker)
    const toolAssistantEvent = requiredEvent(source.session.snapshotEvents(), 'assistant/message', toolAssistantMarker)
    const branchUserMarker = FIXTURE.markers.user(BRANCH_TURN)
    const branchAssistantMarker = FIXTURE.markers.assistant(BRANCH_TURN)
    const branchUserEvent = requiredEvent(source.session.snapshotEvents(), 'user/message', branchUserMarker)
    const branchAssistantEvent = requiredEvent(source.session.snapshotEvents(), 'assistant/message', branchAssistantMarker)
    const boundary = source.session.snapshotEvents().find((event): event is SessionEvent<'turn/end'> => (
      event.type === 'turn/end' && event.data.turn === BRANCH_TURN
    ))
    if (boundary === undefined) throw new Error(`turn ${String(BRANCH_TURN)} has no turn/end event`)
    const expectedUserText = textContent(branchUserEvent.data.content)

    const turnNavigation = page.getByRole('navigation', { name: 'Turn navigation' })
    await turnNavigation.waitFor({ state: 'visible', timeout: 15_000 })
    // The whole-log outline offers every fixture turn before any paging, with
    // the live tail mark current.
    const marks = turnNavigation.getByRole('button')
    await expect.poll(() => marks.count(), { timeout: 15_000 }).toBe(FIXTURE_TURNS)
    expect(await marks.last().getAttribute('aria-current')).toBe('true')
    // The oldest turn is an unloaded mark whose outline preview already
    // carries both the prompt and the settled response.
    const firstTurnButton = turnNavigation
      .getByRole('button', { name: 'Load and jump to turn 1', exact: true })
    await firstTurnButton.focus()
    const preview = page.getByRole('tooltip')
    await preview.waitFor({ state: 'visible', timeout: 5_000 })
    expect(await preview.textContent()).toContain(FIXTURE.markers.user(1))
    expect(await preview.textContent()).toContain(FIXTURE.markers.assistant(1))
    const firstTurnPosition = await firstTurnButton.evaluate(button => (
      button.parentElement?.style.getPropertyValue('--turn-natural-position') ?? ''
    ))
    expect(firstTurnPosition).toBe('0px')

    const loadEarlier = page.getByRole('button', { name: 'Load earlier', exact: true })
    const loadedMarks = turnNavigation.getByRole('button', { name: /^Jump to turn / })
    const loadedBefore = await loadedMarks.count()
    await loadEarlier.click()
    // Paging converts marks to their loaded form without moving the
    // fixed-pitch ladder.
    await expect.poll(() => loadedMarks.count(), { timeout: 15_000 }).toBeGreaterThan(loadedBefore)
    expect(await firstTurnButton.evaluate(button => (
      button.parentElement?.style.getPropertyValue('--turn-natural-position') ?? ''
    ))).toBe(firstTurnPosition)
    // Activating the still-unloaded oldest mark pages the rest in and lands
    // on the turn's own row.
    await firstTurnButton.focus()
    await firstTurnButton.press('Enter')
    const firstLoaded = turnNavigation.getByRole('button', { name: 'Jump to turn 1', exact: true })
    await firstLoaded.waitFor({ timeout: 60_000 })
    await expect.poll(() => firstLoaded.getAttribute('aria-current'), { timeout: 15_000 }).toBe('true')
    await expect.poll(
      () => page.locator('[data-chat-turn="1"][data-chat-flow-kind="user"]').count(),
      { timeout: 5_000 },
    ).toBe(1)

    // Desktop-only affordance: a narrow Chat container hides the rail outright.
    await page.setViewportSize({ width: 800, height: 900 })
    await turnNavigation.waitFor({ state: 'hidden', timeout: 5_000 })
    await page.setViewportSize({ width: 1_680, height: 900 })
    await turnNavigation.waitFor({ state: 'visible', timeout: 5_000 })

    await wheelUntilMounted(page, `[data-chat-call-id="${TARGET_CALL_2}"]`, -1_100)
    const toolUserKey = messageKey(toolUserEvent)
    const toolAssistantKey = assistantKey(toolAssistantEvent)
    const toolUserRow = page.locator(`[data-chat-anchor-key="${toolUserKey}"]`)
    const toolAssistantRow = page.locator(`[data-chat-anchor-key="${toolAssistantKey}"]`)
    const call1 = page.locator(`[data-chat-call-id="${TARGET_CALL_1}"]`)
    const call2 = page.locator(`[data-chat-call-id="${TARGET_CALL_2}"]`)

    await expect.poll(() => toolUserRow.count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => toolAssistantRow.count(), { timeout: 10_000 }).toBe(1)
    expect(await call1.count()).toBe(1)
    expect(await call2.count()).toBe(1)
    expect(await toolUserRow.getAttribute('data-chat-flow-kind')).toBe('user')
    expect(await toolAssistantRow.getAttribute('data-chat-flow-kind')).toBe('assistant-step')
    expect(await toolUserRow.textContent()).toContain(toolUserMarker)
    expect(await toolAssistantRow.textContent()).toContain(toolAssistantMarker)
    expect(await call1.textContent()).toContain(toolMarker1)
    expect(await call2.textContent()).toContain(toolMarker2)

    const expectedOrder = [
      toolUserKey,
      conversationContextKey('tool-call', TARGET_CALL_1),
      conversationContextKey('tool-call', TARGET_CALL_2),
      toolAssistantKey,
    ]
    const actualOrder = await page.locator('[data-chat-anchor-key]').evaluateAll((rows, keys) => (
      rows.map(row => (row as HTMLElement).dataset.chatAnchorKey)
        .filter((key): key is string => key !== undefined && keys.includes(key))
    ), expectedOrder)
    expect(actualOrder).toEqual(expectedOrder)
    const toolKinds = await Promise.all([call1, call2].map(row => row.evaluate(element => (
      element.closest<HTMLElement>('[data-chat-flow-kind]')?.dataset.chatFlowKind ?? null
    ))))
    expect(toolKinds).toEqual(['tool-call', 'tool-call'])

    const summary1 = call1.locator('[data-sample="bash"]')
    const summary2 = call2.locator('[data-sample="bash"]')
    await expandOwningTurnProcess(page, call2)
    expect(await summary1.getAttribute('aria-expanded')).toBe('false')
    expect(await summary2.getAttribute('aria-expanded')).toBe('false')
    await summary2.focus()
    await summary2.press('Enter')
    await expect.poll(() => summary2.getAttribute('aria-expanded'), { timeout: 10_000 }).toBe('true')
    expect(await summary1.getAttribute('aria-expanded')).toBe('false')
    await call2.getByText(`${toolMarker2} output line 12`, { exact: true }).waitFor({ timeout: 10_000 })

    const branchUserKey = messageKey(branchUserEvent)
    const branchAssistantKey = assistantKey(branchAssistantEvent)
    await wheelUntilMounted(page, `[data-chat-anchor-key="${branchUserKey}"]`, -1_100)
    const userRow = page.locator(`[data-chat-anchor-key="${branchUserKey}"]`)
    const assistantRow = page.locator(`[data-chat-anchor-key="${branchAssistantKey}"]`)
    const turnTailRow = page.locator(`[data-chat-anchor-key="${turnTailKey(BRANCH_TURN)}"]`)
    expect(await userRow.textContent()).toContain(branchUserMarker)
    expect(await assistantRow.textContent()).toContain(branchAssistantMarker)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await userRow.hover()
    await userRow.getByRole('button', { name: 'Copy', exact: true }).click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5_000 })
      .toBe(expectedUserText)

    await turnTailRow.hover()
    await turnTailRow.getByRole('button', { name: 'Branch into a new conversation', exact: true }).click()
    await expect.poll(
      () => scaffold.ctx.agents.list().find(agent => agent.session.header.parentSession === SessionId(SESSION_ID)),
      { timeout: 15_000 },
    ).toBeDefined()
    const child = scaffold.ctx.agents.list()
      .find(agent => agent.session.header.parentSession === SessionId(SESSION_ID))
    if (child === undefined) throw new Error('message branch did not create a child session')
    expect(child.session.inheritedEventCount).toBe(boundary.seq + 1)
    expect(child.session.snapshotEvents().some(event => carries(event, branchAssistantMarker))).toBe(true)
    expect(child.session.snapshotEvents().some(event => carries(event, FIXTURE.markers.user(BRANCH_TURN + 1)))).toBe(false)
    expect(child.session.snapshotEvents().some(event => carries(event, FIXTURE.markers.user(FIXTURE.turns)))).toBe(false)

    const currentCrumb = page.getByRole('navigation', { name: 'Session hierarchy' })
      .getByRole('button').last()
    await expect.poll(() => currentCrumb.textContent(), { timeout: 15_000 })
      .toBe(`${FIXTURE.title} (1)`)
    await page.getByText(branchAssistantMarker, { exact: false }).last().waitFor({ timeout: 15_000 })
    const settled = scaffold.whenTurnSettled(60_000)
    const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
    await composer.fill(CONTINUE_PROMPT)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(() => page.getByText(CONTINUE_PROMPT, { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    expect(await settled).toBe(child.session.id)
    await page.getByText(CONTINUE_DONE, { exact: false }).last().waitFor({ timeout: 15_000 })
    await expect.poll(() => page.locator('[data-streaming="true"]').count(), { timeout: 15_000 }).toBe(0)
    expect(await composer.textContent()).toBe('')
    expect(await composer.isEnabled()).toBe(true)
    expect(source.session.snapshotEvents().some(event => carries(event, CONTINUE_PROMPT))).toBe(false)
    expect(child.session.snapshotEvents().filter(event => (
      event.type === 'user/message' && carries(event, CONTINUE_PROMPT)
    ))).toHaveLength(1)
    const lastTurnEnd = child.session.snapshotEvents().findLast((event): event is SessionEvent<'turn/end'> => (
      event.type === 'turn/end'
    ))
    expect(lastTurnEnd?.data.reason).toEqual({ kind: 'completed' })
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 180_000)
})
