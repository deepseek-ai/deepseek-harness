import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import { prepareSessionSnapshotFixtureForComparison } from '@deepseek-ai/dsh-llm-replay'
import {
  SESSION_FORMAT_VERSION, SessionId as sessionId, SessionLogOffset, SessionSeq,
  type SessionEvent, type SessionHeader, type SessionId,
} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import { snapshotSubagentDescriptor, SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent'
import { checkpointRecord, projectionCacheDomainSpec } from '@deepseek-ai/dsh-session-projection-cache'
import {
  acknowledgeReloadConnectionLoss, captureExpandedTurnProcessAria, captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold, readPersistedEvents, realizeSeedFixture, seedSession, selectedSessionFixture, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, pinBrowserClock, pinHostClock, saveFailureShot, writeComposerDraft } from './support.ts'

const BASE_FIXTURE = fileURLToPath(new URL('../../../snapshots/web/live-interactions/session.v3.jsonl', import.meta.url))
const AVAILABLE_CHILD_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/subagent-conversation/ui.expected.md', import.meta.url))
const AVAILABLE_CHILD_EXPANDED_EXPECTED = fileURLToPath(
  new URL('../../../snapshots/web/subagent-conversation/ui-expanded.expected.md', import.meta.url),
)
const CATALOG_PUSH_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/subagent-conversation/catalog-push.expected.md', import.meta.url))
const TREE_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/subagent-conversation/tree.expected.md', import.meta.url))
const BRANCHLESS_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/subagent-conversation/branchless.expected.md', import.meta.url))
const SIDEBAR_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/subagent-conversation/sidebar.expected.md', import.meta.url))
const SIDEBAR_CHAT_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/subagent-conversation/sidebar-chat.expected.md', import.meta.url))
const GRANDCHILD_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/subagent-conversation/nested.expected.md', import.meta.url))
const FORK_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/subagent-conversation/fork.expected.md', import.meta.url))
const MIGRATING_CHILD_EXPECTED = fileURLToPath(new URL(
  './expected/subagent-conversation/migration-required-child.expected.md', import.meta.url,
))
const MODE = webSnapshotMode()
const LABEL = 'event-sourcing researcher'
const ONE_SHOT_LABEL = 'event-sourcing reviewer'
const NESTED_LABEL = 'example editor'
const CHILD_TITLE = 'Explain event sourcing in one'
const PARENT_PROMPT = 'Ask a research subagent to explain event sourcing.'
const INITIAL_PROMPT = 'Explain event sourcing in one sentence.'
/** The grandchild's own first message; its arrival is what says its history finished loading. */
const NESTED_PROMPT = 'Give one concrete event sourcing example.'
const FOLLOWUP = 'Now give the same explanation to a human reader.'
const POST_FORK_FOLLOWUP = 'Continue the original conversation after the fork.'

function childFixture(source: string, fixtureId: string, withContinuation: boolean): string {
  const [header, ...eventLines] = source.trimEnd().split('\n')
  if (header === undefined) throw new Error('base replay fixture has no header')
  const childHeaderValue = JSON.parse(header) as Record<string, unknown>
  childHeaderValue.id = fixtureId
  childHeaderValue.createdAt = 1784998084442
  const childHeader = JSON.stringify(childHeaderValue)
  if (!withContinuation) return [childHeader, ...eventLines, ''].join('\n')
  const seqOffset = eventLines.length
  const continued = eventLines.map((line) => {
    const event = JSON.parse(line) as {
      type: string
      seq: number
      data: Record<string, unknown>
    }
    const data = { ...event.data }
    if (data.turn === 1) data.turn = 2
    if (event.type === 'session/title' && Array.isArray(data.messageSeqs)) {
      data.messageSeqs = data.messageSeqs.map((seq: unknown) => {
        if (typeof seq !== 'number') throw new Error('base replay fixture title has a non-numeric message seq')
        return seq + seqOffset
      })
    }
    return JSON.stringify({ ...event, seq: event.seq + seqOffset, data })
  })
  return [childHeader, ...eventLines, ...continued, ''].join('\n')
}

async function waitForAgentToSettle(scaffold: WebScaffold, id: SessionId): Promise<void> {
  const deadline = Date.now() + 30_000
  while (scaffold.ctx.agents.get(id) !== undefined) {
    if (Date.now() >= deadline) throw new Error(`subagent ${id} did not settle`)
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}

/** Poll until the cold-read write-back of {@link coldSnapshot} lands a visible row. */
async function waitForCacheRow(
  scaffold: WebScaffold,
  header: SessionHeader,
): Promise<void> {
  const deadline = Date.now() + 10_000
  while (scaffold.ctx.sessionProjectionCache.cachedSnapshot(header) === undefined) {
    if (Date.now() >= deadline) throw new Error(`cache row for "${header.id}" did not land`)
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}

describe('web e2e: persisted subagent conversation and human continuation', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let sidecarRoot: string
  let parentId: SessionId
  let childId: SessionId
  let oneShotId: SessionId
  let grandchildId: SessionId
  let liveReferenceOptions: string[]
  let tripwire: ReturnType<typeof watchConsole>
  const apiCalls: string[] = []
  let hostClock: ReturnType<typeof pinHostClock> | undefined

  beforeAll(async () => {
    if (MODE === 'record') throw new Error('subagent conversation is a keyless assembled snapshot')
    hostClock = pinHostClock()
    const selectedBaseFixture = await selectedSessionFixture(BASE_FIXTURE)
    const baseFixture = prepareSessionSnapshotFixtureForComparison(
      await readFile(selectedBaseFixture, 'utf8'),
    )
    sidecarRoot = await mkdtemp(join(tmpdir(), 'dsh-web-subagent-'))
    const childFixturePath = join(sidecarRoot, 'child.jsonl')
    await writeFile(childFixturePath, childFixture(baseFixture, 'recorded-subagent', true))
    scaffold = await launchWebScaffold({
      replayFixture: selectedBaseFixture,
      compareReplaySession: false,
      replayChildFixtures: [childFixturePath],
      paceMs: 25,
    })
    browser = await chromium.launch()
    await mkdir(fileURLToPath(new URL('../../../.artifacts/screenshots/non-migrating-session-reads', import.meta.url)), { recursive: true })
    page = await newEnglishPage(browser)
    await pinBrowserClock(page)
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (path.startsWith('/api/')) apiCalls.push(path)
    })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)

    const parent = scaffold.ctx.agents.list().filter(agent => agent.session.header.origin !== 'subagent')[0]
    if (parent === undefined) throw new Error('fresh workspace did not publish its parent Agent')
    parentId = parent.id
    const parentSettled = scaffold.whenTurnSettled()
    const parentInput = page.locator('[data-composer-input][contenteditable="true"]').first()
    await parentInput.fill(PARENT_PROMPT)
    await parentInput.press('Enter')
    expect(await parentSettled).toBe(parent.id)

    const started = await scaffold.ctx.subagents.startActivation({
      delivery: 'parent',
      provider: 'spawn',
      label: LABEL,
      signal: new AbortController().signal,
      prompt: [{ type: 'text', text: INITIAL_PROMPT }],
      parent,
    })
    childId = started.childId
    await waitForAgentToSettle(scaffold, childId)
    const liveInput = page.locator('[data-composer-input][contenteditable="true"]').first()
    const liveMenu = page.getByRole('listbox', { name: 'Trigger suggestions' })
    await writeComposerDraft(page, liveInput, '@')
    await liveMenu.getByText('Subagents', { exact: true }).waitFor({ timeout: 15_000 })
    liveReferenceOptions = await liveMenu.getByRole('option').allTextContents()
    await page.keyboard.press('Escape')
    await writeComposerDraft(page, liveInput, '')
    oneShotId = sessionId('recorded-one-shot')
    const oneShotDurationMs = 192 * 24 * 60 * 60 * 1_000
    const oneShotAt = Date.now() - oneShotDurationMs
    const oneShotHeader: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: oneShotId,
      createdAt: oneShotAt,
      isSeeded: false,
      cwd: scaffold.workspaceCwd,
      parentSession: parent.id,
      origin: 'subagent',
      delegationDepth: 1,
    }
    const oneShotHandle = await scaffold.ctx.sessionPersistence.create(oneShotHeader)
    const oneShotEvents = [
      {
        type: 'turn/start',
        seq: 0,
        time: oneShotAt,
        data: { turn: 1 },
      },
      {
        type: 'user/message',
        seq: 1,
        time: oneShotAt + 1,
        data: {
          id: '00000000-0000-4000-9000-000000000101',
          role: 'user',
          content: [{ type: 'text', text: 'Review the event sourcing explanation.' }],
          source: { kind: 'user' },
        },
        surfaceOp: 'append',
      },
      {
        type: 'subagent/descriptor',
        seq: 2,
        time: oneShotAt + 2,
        data: {
          version: SUBAGENT_DESCRIPTOR_VERSION,
          mode: 'one-shot', provider: 'spawn', label: ONE_SHOT_LABEL,
        },
      },
      {
        type: 'turn/end',
        seq: 3,
        time: oneShotAt + oneShotDurationMs,
        data: { turn: 1, reason: { kind: 'completed' } },
      },
    ] as SessionEvent[]
    await oneShotHandle.append(oneShotEvents)
    await oneShotHandle.close()
    scaffold.ctx.sessionProjectionCache.coldSnapshot(oneShotHeader, SessionLogOffset(0), oneShotEvents)
    await waitForCacheRow(scaffold, oneShotHeader)
    await page.getByRole('button', { name: '1 subagent', exact: true }).waitFor({ timeout: 15_000 })
    const catalogReads = apiCalls.filter(path => path === '/api/session/projections').length
    parent.session.append('subagent/catalog', {
      version: 0,
      childId: oneShotId,
      childCreatedAt: oneShotAt,
      mode: 'one-shot',
      label: ONE_SHOT_LABEL,
    })
    const pushedCount = page.getByRole('button', { name: '2 subagents', exact: true })
    await pushedCount.waitFor({ timeout: 15_000 })
    expect(apiCalls.filter(path => path === '/api/session/projections')).toHaveLength(catalogReads)
    await compareOrRefreshGolden(CATALOG_PUSH_EXPECTED, await pushedCount.ariaSnapshot(), MODE)
    grandchildId = sessionId('recorded-grandchild')
    const authoredAt = Date.now()
    const grandchildHeader: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: grandchildId,
      createdAt: authoredAt,
      isSeeded: false,
      cwd: scaffold.workspaceCwd,
      parentSession: childId,
      origin: 'subagent',
      delegationDepth: 2,
    }
    const grandchildHandle = await scaffold.ctx.sessionPersistence.create(grandchildHeader)
    const grandchildEvents = [
      {
        type: 'turn/start',
        seq: 0,
        time: authoredAt,
        data: { turn: 1 },
      },
      {
        type: 'user/message',
        seq: 1,
        time: authoredAt + 1,
        data: {
          id: '00000000-0000-4000-9000-000000000102',
          role: 'user',
          content: [{ type: 'text', text: NESTED_PROMPT }],
          source: { kind: 'user' },
        },
        surfaceOp: 'append',
      },
      {
        type: 'subagent/descriptor',
        seq: 2,
        time: authoredAt + 2,
        data: snapshotSubagentDescriptor({
          mode: 'continuable', provider: 'spawn', label: NESTED_LABEL,
        }),
      },
      {
        type: 'turn/end',
        seq: 3,
        time: authoredAt + 3,
        data: { turn: 1, reason: { kind: 'completed' } },
      },
    ] as SessionEvent[]
    await grandchildHandle.append(grandchildEvents)
    await grandchildHandle.close()
    scaffold.ctx.sessionProjectionCache.coldSnapshot(grandchildHeader, SessionLogOffset(0), grandchildEvents)
    await waitForCacheRow(scaffold, grandchildHeader)
    const childHandle = await scaffold.ctx.sessionPersistence.open(childId, 'write')
    const childHeader = childHandle.header
    const childInheritedEventCount = childHandle.inheritedEventCount
    const { events: childEvents } = await childHandle.read()
    const grandchildCatalogEvent: SessionEvent<'subagent/catalog'> = {
      type: 'subagent/catalog',
      seq: SessionSeq((childEvents.at(-1)?.seq ?? -1) + 1),
      time: authoredAt,
      data: {
        version: 0,
        childId: grandchildId,
        childCreatedAt: authoredAt,
        mode: 'continuable',
        label: NESTED_LABEL,
      },
    }
    await childHandle.append([grandchildCatalogEvent])
    await childHandle.close()
    scaffold.ctx.sessionProjectionCache.coldSnapshot(
      childHeader,
      childInheritedEventCount,
      [...childEvents, grandchildCatalogEvent],
    )
    expect(scaffold.ctx.agents.get(childId)).toBeUndefined()
    expect(scaffold.ctx.agents.get(oneShotId)).toBeUndefined()
    expect(scaffold.ctx.agents.get(grandchildId)).toBeUndefined()
    {
      using observed = await scaffold.ctx.sessionQuery.observeSession(parent.id)
      expect(observed.projections?.values.subagentCatalog).toMatchObject([
        {
          id: childId, mode: 'continuable', label: LABEL,
        },
        {
          id: oneShotId, mode: 'one-shot', label: ONE_SHOT_LABEL,
        },
      ])
    }
    {
      using observed = await scaffold.ctx.sessionQuery.observeSession(childId)
      expect(observed.source).toBe('prepared')
      expect(observed.projections?.values.subagentCatalog).toEqual([
        { id: grandchildId, createdAt: authoredAt, mode: 'continuable', label: NESTED_LABEL },
      ])
    }
    await waitForCacheRow(scaffold, childHeader)
    const cache = scaffold.ctx.storageDomain.get(projectionCacheDomainSpec.name)
    if (cache === undefined) throw new Error('projection cache is not open')
    const table = cache.table('sessions')
    const record = checkpointRecord.parse(table.get(childId))
    const { subagentCatalog: _catalog, ...rows } = record.rows
    await table.put(childId, { ...record, rows })
    // These two cold fixtures were authored after the page's initial
    // session.list and intentionally emitted no api-session/added event. Reload
    // to exercise the restart baseline that discovers their full lineage.
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const catalogButton = page.getByRole('button', { name: '2 subagents', exact: true })
    await catalogButton.waitFor({ timeout: 15_000 })
    await catalogButton.hover()
    const catalogTree = page.getByRole('tree', { name: 'Subagent sessions' })
    await catalogTree.getByRole('treeitem').nth(1).waitFor({ timeout: 15_000 })
    await catalogTree.press('Escape')
    await page.getByRole('button', { name: '2 subagents' }).waitFor({ timeout: 15_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (sidecarRoot !== undefined) {
      await rm(sidecarRoot, { recursive: true, force: true })
        .catch((error: unknown) => failures.push(error))
    }
    hostClock?.mockRestore()
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'subagent Web teardown failed')
  })

  it('lists direct subagents by label in the reference menu', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-reference-title'))
    expect(liveReferenceOptions.some(text => text.includes(LABEL))).toBe(true)
    expect(liveReferenceOptions.some(text => text.includes(CHILD_TITLE))).toBe(false)
    const input = page.locator('[data-composer-input][contenteditable="true"]').first()
    const menu = page.getByRole('listbox', { name: 'Trigger suggestions' })
    await writeComposerDraft(page, input, '@')
    await menu.getByText('Subagents', { exact: true }).waitFor({ timeout: 15_000 })
    await menu.getByRole('option', { name: new RegExp(LABEL) }).waitFor({ timeout: 15_000 })
    expect(await menu.getByRole('option', { name: new RegExp(CHILD_TITLE) }).count()).toBe(0)
    await page.keyboard.press('Escape')
    await writeComposerDraft(page, input, '')
  })

  it('enters the member tree after pointer or keyboard activation of its trigger', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-trigger-focus'))
    const trigger = page.getByRole('button', { name: '2 subagents', exact: true })
    const panel = page.locator('[data-subagent-panel]')
    try {
      for (const activation of ['click', 'Enter', 'Space']) {
        if (activation === 'click') await trigger.click()
        else await trigger.press(activation)
        await expect.poll(() => panel.evaluate(element => element === document.activeElement)).toBe(true)
        await page.keyboard.press('ArrowDown')
        expect(await panel.locator('[role="treeitem"]:not([aria-disabled="true"])').first()
          .evaluate(element => element === document.activeElement)).toBe(true)
        await page.keyboard.press('Escape')
        await panel.waitFor({ state: 'detached' })
        expect(await trigger.evaluate(element => element === document.activeElement)).toBe(true)
      }
    } finally {
      await page.locator('[data-composer-input]').first().hover()
    }
  })

  it('shows complete descriptions and IDs without hover at desktop and touch widths', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-catalog-labels'))
    const originalViewport = page.viewportSize()!
    const originalUrl = page.url()
    try {
      for (const width of [originalViewport.width, 390]) {
        await page.setViewportSize({ ...originalViewport, width })
        const trigger = page.getByRole('button', { name: '2 subagents', exact: true })
        await trigger.click()
        const panel = page.locator('[data-subagent-panel]')
        const row = panel.getByRole('treeitem', { name: new RegExp(LABEL) })
        const primary = row.getByText(LABEL, { exact: true })
        const secondary = row.getByText(childId, { exact: true })
        const primaryBounds = await primary.boundingBox()
        const secondaryBounds = await secondary.boundingBox()
        expect(primaryBounds).not.toBeNull()
        expect(secondaryBounds).not.toBeNull()
        expect(primaryBounds!.y + primaryBounds!.height).toBeLessThanOrEqual(secondaryBounds!.y)
        for (const label of [primary, secondary]) {
          expect(await label.evaluate(element => element.scrollWidth <= element.clientWidth
            && element.scrollHeight <= element.clientHeight)).toBe(true)
        }
        expect(await row.getAttribute('aria-label')).toContain(`${LABEL} ${childId} `)
        expect(await row.getByRole('button', { name: /description/u }).count()).toBe(0)
        expect(await row.getByRole('button', { name: `Expand ${LABEL} descendants`, exact: true }).count()).toBe(1)
        expect(await row.getByRole('button', { name: `Open ${LABEL} in sidebar`, exact: true }).count()).toBe(1)
        expect(page.url()).toBe(originalUrl)
        expect(await page.getByRole('tooltip').count()).toBe(0)
        expect(scaffold.ctx.agents.get(childId)).toBeUndefined()
        await page.keyboard.press('Escape')
        await panel.waitFor({ state: 'detached' })
      }
    } finally {
      await page.setViewportSize(originalViewport)
      await page.locator('[data-composer-input]').first().hover()
    }
  })

  it('recovers a current-format cold child catalog cache miss without activating either level', async () => {
    onTestFailed(() => saveFailureShot(page, 'screenshots/non-migrating-session-reads/web-e2e-subagent-tree'))
    await page.getByRole('button', { name: '2 subagents' }).hover()
    const catalogTree = page.getByRole('tree', { name: 'Subagent sessions' })
    expect(await catalogTree.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + 8, rect.top + 8)
      return hit !== null && element.contains(hit)
    })).toBe(true)
    const sectionHeader = page.locator('[data-subagent-section-header]')
    expect(await sectionHeader.count()).toBe(0)
    const oneShotDisclosure = page.getByRole('button', {
      name: `Expand ${ONE_SHOT_LABEL} descendants`,
    })
    expect(await oneShotDisclosure.count()).toBe(0)
    const oneShotRow = page.getByRole('treeitem', { name: new RegExp(ONE_SHOT_LABEL) })
    expect(await oneShotRow.locator('[data-state="done"]').count()).toBe(1)
    expect(await oneShotRow.getByText('~6mo 12d', { exact: true }).count()).toBe(1)
    expect(await oneShotRow.getAttribute('aria-label')).toContain('192d 00h 00m 00s')
    const childRow = page.getByRole('treeitem', { name: new RegExp(LABEL) })
    const disclosure = childRow.getByRole('button', { name: new RegExp(`^(Expand|Collapse) ${LABEL} descendants$`, 'u') })
    const beforeDisclosureUrl = page.url()
    const clickDisclosureGutter = async (offset: number): Promise<void> => {
      const geometry = await disclosure.evaluate((button, xOffset) => {
        const row = button.closest('[role="treeitem"]')!
        const rowBounds = row.getBoundingClientRect()
        const buttonBounds = button.getBoundingClientRect()
        const glyph = getComputedStyle(button.querySelector('svg')!)
        const target = { x: rowBounds.left + xOffset, y: rowBounds.bottom - 3 }
        const pseudo = getComputedStyle(button, '::after')
        const status = row.querySelector('[data-state]')!.getBoundingClientRect()
        return {
          target,
          outsideButton: target.x < buttonBounds.left || target.x > buttonBounds.right
            || target.y < buttonBounds.top || target.y > buttonBounds.bottom,
          pseudo: { width: pseudo.width, height: pseudo.height, top: pseudo.top, bottom: pseudo.bottom, left: pseudo.left },
          rowHeight: rowBounds.height,
          glyph: { width: glyph.width, height: glyph.height },
          transform: getComputedStyle(button).transform,
          hitsDisclosure: document.elementFromPoint(target.x, target.y) === button,
          missesNextRow: document.elementFromPoint(target.x, rowBounds.bottom + 1) !== button,
          endsBeforeStatus: rowBounds.left + 28 <= status.left,
          missesStatus: document.elementFromPoint(status.left + status.width / 2, status.top + status.height / 2) !== button,
        }
      }, offset)
      expect(geometry.outsideButton, JSON.stringify(geometry)).toBe(true)
      expect(geometry.pseudo).toEqual({ width: '28px', height: `${geometry.rowHeight}px`, top: '0px', bottom: '0px', left: '0px' })
      expect(geometry.glyph).toEqual({ width: '12px', height: '12px' })
      expect(geometry.transform).toBe('none')
      expect(geometry.hitsDisclosure).toBe(true)
      expect(geometry.missesNextRow).toBe(true)
      expect(geometry.endsBeforeStatus).toBe(true)
      expect(geometry.missesStatus).toBe(true)
      const body = childRow.locator(':scope > div')
      await childRow.getByText(LABEL, { exact: true }).hover()
      expect(await body.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
      await page.mouse.move(geometry.target.x, geometry.target.y)
      expect(await body.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
      await page.mouse.click(geometry.target.x, geometry.target.y)
      expect(page.url()).toBe(beforeDisclosureUrl)
      expect(await page.getByText(PARENT_PROMPT, { exact: true }).isVisible()).toBe(true)
      expect(await page.locator('[data-sidebar-chat]').count()).toBe(0)
    }
    const observe = vi.spyOn(scaffold.ctx.sessionQuery, 'observeSession')
    try {
      const projections = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/projections')
      await clickDisclosureGutter(3)
      await projections
      await page.getByRole('treeitem', { name: new RegExp(NESTED_LABEL) }).waitFor({ timeout: 15_000 })
      expect(await sectionHeader.count()).toBe(0)
      expect(observe.mock.calls.some(([id]) => id === childId)).toBe(true)
      expect(observe.mock.calls.some(([id]) => id === grandchildId)).toBe(false)
    } finally {
      observe.mockRestore()
    }
    await clickDisclosureGutter(26)
    await page.getByRole('treeitem', { name: new RegExp(NESTED_LABEL) }).waitFor({ state: 'detached' })
    expect(await childRow.getAttribute('aria-expanded')).toBe('false')
    await clickDisclosureGutter(3)
    await page.getByRole('treeitem', { name: new RegExp(NESTED_LABEL) }).waitFor()
    expect(await childRow.getAttribute('aria-expanded')).toBe('true')
    const connector = await page.getByRole('treeitem', { name: new RegExp(NESTED_LABEL) }).evaluate((row) => {
      const rowBounds = row.getBoundingClientRect()
      const dot = row.querySelector('[data-state]')!
      const dotBounds = dot.getBoundingClientRect()
      const slot = dot.parentElement!.getBoundingClientRect()
      const horizontal = getComputedStyle(row, '::before')
      const node = row.parentElement!
      const spine = getComputedStyle(node, '::before')
      const stroke = Number.parseFloat(horizontal.borderTopWidth)
      const colorProbe = document.createElement('span')
      colorProbe.style.cssText = 'display:none;color:var(--dsw-alias-border-l3)'
      row.append(colorProbe)
      let expectedColor: string
      try {
        expectedColor = getComputedStyle(colorProbe).color
      } finally {
        colorProbe.remove()
      }
      return {
        rowTop: rowBounds.top,
        dotCenter: dotBounds.top + dotBounds.height / 2,
        lineCenter: rowBounds.top + Number.parseFloat(horizontal.top) + stroke / 2,
        lineEnd: rowBounds.left + Number.parseFloat(horizontal.left) + Number.parseFloat(horizontal.width),
        slotLeft: slot.left,
        spineEnd: node.getBoundingClientRect().top + Number.parseFloat(spine.top) + Number.parseFloat(spine.height),
        lastSibling: node.nextElementSibling === null,
        stroke,
        color: horizontal.borderTopColor,
        spineColor: spine.borderLeftColor,
        expectedColor,
      }
    })
    expect(connector.lastSibling).toBe(true)
    expect(Math.abs(connector.lineCenter - connector.dotCenter), JSON.stringify(connector)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(connector.spineEnd - connector.dotCenter), JSON.stringify(connector)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(connector.lineEnd - connector.slotLeft), JSON.stringify(connector)).toBeLessThanOrEqual(0.5)
    expect(connector.stroke).toBeGreaterThanOrEqual(0.5)
    expect(connector.stroke).toBeLessThanOrEqual(1)
    expect(connector.color).toBe(connector.expectedColor)
    expect(connector.spineColor).toBe(connector.expectedColor)
    const childLabel = await childRow.getAttribute('aria-label')
    await page.waitForTimeout(1_100)
    expect(await childRow.getAttribute('aria-label')).toBe(childLabel)
    expect(await page.getByRole('treeitem', { name: new RegExp(NESTED_LABEL) }).getAttribute('aria-label')).toContain('continuable')
    expect(scaffold.ctx.agents.get(childId)).toBeUndefined()
    expect(scaffold.ctx.agents.get(grandchildId)).toBeUndefined()
    const snapshot = await captureStableAria(
      page,
      '[role="tree"][aria-label="Subagent sessions"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(TREE_EXPECTED, snapshot, MODE)
    await page.getByRole('treeitem', { name: new RegExp(NESTED_LABEL) }).getByText(grandchildId, { exact: true }).click()
    await page.getByText(NESTED_PROMPT).waitFor()
    const hierarchy = page.getByRole('navigation', { name: 'Session hierarchy' })
    await hierarchy.getByRole('button', { name: `Switch subagent: ${LABEL}`, exact: true }).waitFor()
    expect(scaffold.ctx.agents.get(childId)).toBeUndefined()
    expect(scaffold.ctx.agents.get(grandchildId)).toBeUndefined()
    await hierarchy.getByRole('button').first().click()
    await page.getByRole('button', { name: '2 subagents', exact: true }).waitFor()
  })

  it('opens child history in the right Sidebar and releases it when closed', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-sidebar-chat'))
    await page.getByRole('button', { name: '2 subagents' }).hover()
    await page.getByRole('treeitem', { name: new RegExp(LABEL) }).getByRole('button', { name: `Open ${LABEL} in sidebar`, exact: true }).click()
    const sidebarChat = page.locator('[data-sidebar-chat]')
    await sidebarChat.getByText(/^Explain event sourcing in one sentence\./).waitFor({ timeout: 15_000 })
    await compareOrRefreshGolden(
      SIDEBAR_CHAT_EXPECTED,
      await captureStableAria(page, '[data-sidebar-chat]', scaffold.workspaceCwd),
      MODE,
    )
    await page.locator('[data-sidebar-right-panel] [data-dockkit-tab-close]').click()
    await sidebarChat.waitFor({ state: 'detached' })

    await page.getByRole('button', { name: '2 subagents' }).hover()
    await page.getByRole('treeitem', { name: new RegExp(ONE_SHOT_LABEL) }).getByRole('button', { name: `Open ${ONE_SHOT_LABEL} in sidebar`, exact: true }).click()
    await page.locator('[data-sidebar-chat]').getByText(
      'One-shot tasks do not accept follow-ups; review the full execution record here.',
    ).waitFor({ timeout: 15_000 })
    await page.locator('[data-sidebar-right-panel] [data-dockkit-tab-close]').click()
    await page.locator('[data-sidebar-chat]').waitFor({ state: 'detached' })
  })

  it('opens the completed child from persistence without activating it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-open'))
    await page.getByRole('button', { name: '2 subagents' }).hover()
    await page.getByRole('treeitem', { name: new RegExp(LABEL) }).getByText(LABEL, { exact: true }).click()
    await expect.poll(
      () => page.getByText(/^Explain event sourcing in one sentence\./).count(),
      { timeout: 15_000 },
    ).toBe(1)
    if (scaffold.ctx.agents.get(childId) !== undefined) {
      throw new Error(`viewing the child activated it; API calls: ${apiCalls.join(', ')}`)
    }
    const hierarchy = page.getByRole('navigation', { name: 'Session hierarchy' })
    const currentCrumb = hierarchy.getByRole('button', { name: `Switch subagent: ${LABEL}` })
    await currentCrumb.waitFor()
    const crumbGeometry = await Promise.all([hierarchy.getByRole('button').first(), currentCrumb].map(crumb => crumb.evaluate((element) => {
      const style = getComputedStyle(element)
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      let text = walker.nextNode()
      while (text !== null && text.textContent?.trim() === '') text = walker.nextNode()
      if (text === null) throw new Error('Breadcrumb has no title text')
      const range = document.createRange()
      range.selectNodeContents(text)
      const bounds = range.getBoundingClientRect()
      return { fontSize: style.fontSize, lineHeight: style.lineHeight, top: bounds.top, bottom: bounds.bottom }
    })))
    expect(crumbGeometry.map(({ fontSize, lineHeight }) => ({ fontSize, lineHeight })))
      .toEqual([{ fontSize: '14px', lineHeight: '20px' }, { fontSize: '14px', lineHeight: '20px' }])
    expect(Math.abs(crumbGeometry[0]!.top - crumbGeometry[1]!.top), JSON.stringify(crumbGeometry)).toBeLessThanOrEqual(1)
    expect(Math.abs(crumbGeometry[0]!.bottom - crumbGeometry[1]!.bottom), JSON.stringify(crumbGeometry)).toBeLessThanOrEqual(1)
    expect(await hierarchy.getByRole('button', { name: '1 subagent', exact: true })
      .evaluate(element => getComputedStyle(element).fontSize)).toBe('12px')
    const sidebar = await captureStableAria(
      page,
      '[role="tree"][aria-label="Sessions"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(SIDEBAR_EXPECTED, sidebar, MODE)
  })

  it('waits for the initial catalog before restoring a saved child', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-restore'))
    const pattern = '**/api/session/list'
    let requested = false
    let releaseCatalog = (): void => {}
    const catalogHeld = new Promise<void>((resolve) => { releaseCatalog = resolve })
    await page.route(pattern, async (route) => {
      const response = await route.fetch()
      requested = true
      await catalogHeld
      await route.fulfill({ response })
    })

    const warningStart = tripwire.warnings.length
    try {
      await page.reload({ waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await expect.poll(() => requested, { timeout: 15_000 }).toBe(true)
      expect(await page.getByText('This subagent is read-only for now', { exact: true }).count()).toBe(0)
      expect(await page.getByRole('navigation', { name: 'Session hierarchy' }).count()).toBe(0)
      expect(await page.getByText(/^Explain event sourcing in one sentence\./).count()).toBe(0)
      releaseCatalog()
      await page.getByRole('button', { name: `Switch subagent: ${LABEL}` }).waitFor({ timeout: 15_000 })
      const input = page.getByRole('textbox', { name: 'Message or run a task, / commands, @ files or sessions' })
      await input.waitFor({ timeout: 15_000 })
      await expect.poll(() => input.isEnabled(), { timeout: 15_000 }).toBe(true)
      acknowledgeReloadConnectionLoss(tripwire, warningStart)
    } finally {
      releaseCatalog()
      await page.unrouteAll({ behavior: 'wait' })
    }
  })

  it('continues through FIFO follow-up admission and receives the child follow events', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-followup'))
    const ended = new Promise<void>((resolveEnded, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new Error('subagent follow-up did not reach turn/end'))
      }, 30_000)
      const off = scaffold.ctx.on('session/event', (session: { id: SessionId }, event: SessionEvent) => {
        if (session.id !== childId || event.type !== 'turn/end') return
        clearTimeout(timer)
        off()
        resolveEnded()
      })
    })
    const input = page.getByRole('textbox', { name: 'Message or run a task, / commands, @ files or sessions' })
    await input.fill(FOLLOWUP)
    await input.press('Enter')
    await expect.poll(
      () => scaffold.ctx.agents.get(childId)?.status,
      { timeout: 10_000 },
    ).toBe('running')
    await ended
    await expect.poll(() => page.getByText(FOLLOWUP, { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => scaffold.ctx.agents.get(childId), { timeout: 10_000 }).toBeUndefined()
    expect(await page.getByRole('button', { name: 'Stop generating' }).count()).toBe(0)
  })

  it('matches the settled addressed-conversation aria golden and stays clean', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-aria'))
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(AVAILABLE_CHILD_EXPECTED, snapshot, MODE)
    const expanded = await captureExpandedTurnProcessAria(
      page,
      '[class*="centerCol"]',
      scaffold.workspaceCwd,
      { scrollToBottom: true },
    )
    await compareOrRefreshGolden(AVAILABLE_CHILD_EXPANDED_EXPECTED, expanded, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('opens a persisted grandchild with input enabled while its creator is offline', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-grandchild'))
    await page.getByRole('button', { name: '1 subagent' }).hover()
    const tree = page.getByRole('tree', { name: 'Subagent sessions' })
    const nestedRow = tree.locator('[role="treeitem"]').filter({ hasText: NESTED_LABEL })
    await nestedRow.waitFor({ timeout: 15_000 })
    const nestedDisclosure = page.getByRole('button', {
      name: `Expand ${NESTED_LABEL} descendants`,
    })
    expect(await nestedDisclosure.count()).toBe(0)
    const clickArea = nestedRow.locator(':scope > div')
    expect(await clickArea.count()).toBe(1)
    const [menuBox, clickAreaBox] = await Promise.all([
      page.locator('[data-subagent-panel]').boundingBox(),
      clickArea.boundingBox(),
    ])
    expect(menuBox).not.toBeNull()
    expect(clickAreaBox).not.toBeNull()
    expect([
      Math.round(clickAreaBox!.x - menuBox!.x),
      Math.round(menuBox!.x + menuBox!.width - clickAreaBox!.x - clickAreaBox!.width),
    // Menu padding plus the branchless row's one-pixel leading inset.
    ]).toEqual([7, 6])
    await compareOrRefreshGolden(
      BRANCHLESS_EXPECTED,
      await captureStableAria(page, '[role="tree"][aria-label="Subagent sessions"]', scaffold.workspaceCwd),
      MODE,
    )
    await nestedRow.getByText(grandchildId, { exact: true }).click()
    await page.getByText(NESTED_PROMPT).waitFor()
    expect(await page.getByRole('textbox', { name: 'Message or run a task, / commands, @ files or sessions' }).isEnabled()).toBe(true)
    const hierarchy = page.getByRole('navigation', { name: 'Session hierarchy' })
    const crumbs = await hierarchy.getByRole('button').allTextContents()
    expect(crumbs.slice(-2)).toEqual([LABEL, NESTED_LABEL])
    expect(scaffold.ctx.agents.get(childId)).toBeUndefined()
    expect(scaffold.ctx.agents.get(grandchildId)).toBeUndefined()
    await compareOrRefreshGolden(
      GRANDCHILD_EXPECTED,
      await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd),
      MODE,
    )
  })

  it('opens a one-shot child as permanently read-only history', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-one-shot'))
    const parentSession = page.getByRole('tree', { name: 'Sessions' })
      .getByRole('treeitem', { name: /Ask a research subagent to/ })
    await parentSession.click()
    await page.getByRole('button', { name: '2 subagents' }).hover()
    await page.getByRole('treeitem', { name: new RegExp(ONE_SHOT_LABEL) }).getByText(oneShotId, { exact: true }).click()
    await page.getByText('One-shot tasks do not accept follow-ups; review the full execution record here.').waitFor()
    expect(scaffold.ctx.agents.get(oneShotId)).toBeUndefined()
  })

  it('places an ordinary fork from a subagent beside its workspace-owning ancestor', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-fork'))
    await page.getByRole('tree', { name: 'Sessions' })
      .getByRole('treeitem', { name: /Ask a research subagent to/ })
      .click()
    await page.getByRole('button', { name: '2 subagents' }).hover()
    await page.getByRole('treeitem', { name: new RegExp(LABEL) }).getByText(childId, { exact: true }).click()
    await page.getByRole('textbox', { name: 'Message or run a task, / commands, @ files or sessions' }).waitFor()
    const forkResponse = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/session/fork')
    await page.getByRole('button', { name: 'Branch into a new conversation' }).last().click()
    const forkReceipt = await (await forkResponse).json() as { result: { ok: boolean } }
    expect(forkReceipt.result).toMatchObject({ ok: true })
    await expect.poll(
      () => page.getByRole('tree', { name: 'Sessions' }).getByRole('treeitem').count(),
      { timeout: 15_000 },
    ).toBe(3)
    expect(await page.getByRole('tree', { name: 'Sessions' })
      .getByRole('treeitem', { name: 'Ungrouped', exact: true }).count()).toBe(0)
    const hierarchy = page.getByRole('navigation', { name: 'Session hierarchy' })
    // The current crumb is plain text; the fork sits at the root, so no ancestor crumb buttons remain.
    await expect.poll(() => hierarchy.getByText(`${CHILD_TITLE} (1)`, { exact: true }).count()).toBe(1)
    expect(await hierarchy.getByRole('button').count()).toBe(0)
    await compareOrRefreshGolden(
      FORK_EXPECTED,
      await captureStableAria(page, '[role="tree"][aria-label="Sessions"]', scaffold.workspaceCwd),
      MODE,
    )
  })

  it('cold-resumes the original subagent while its ordinary fork stays active', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-post-fork-followup'))
    const sessions = page.getByRole('tree', { name: 'Sessions' })
    await sessions.getByRole('treeitem', { name: /Ask a research subagent to/ }).click()
    await page.getByRole('button', { name: '2 subagents' }).hover()
    await page.getByRole('treeitem', { name: new RegExp(LABEL) }).getByText(childId, { exact: true }).click()
    await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor()
    expect(scaffold.ctx.agents.get(childId)).toBeUndefined()

    const forkResponse = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/session/fork')
    await page.getByRole('button', { name: 'Branch into a new conversation' }).last().click()
    const forkReceipt = await (await forkResponse).json() as {
      result: { ok: true; value: { sessionId: string } } | { ok: false }
    }
    expect(forkReceipt.result).toMatchObject({ ok: true })
    if (!forkReceipt.result.ok) return
    const forkId = sessionId(forkReceipt.result.value.sessionId)
    await expect.poll(() => scaffold.ctx.agents.get(forkId)).not.toBeUndefined()

    await sessions.getByRole('treeitem', { name: /Ask a research subagent to/ }).click()
    await page.getByRole('button', { name: '2 subagents' }).press('ArrowDown')
    await page.getByRole('treeitem', { name: new RegExp(LABEL) }).getByText(childId, { exact: true }).click()
    const input = page.locator('[data-composer-input][contenteditable="true"]').first()
    await input.waitFor()
    const promptResponse = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/subagents/prompt')
    await input.fill(POST_FORK_FOLLOWUP)
    await input.press('Enter')
    const promptReceipt = await (await promptResponse).json() as {
      result: { ok: true } | { ok: false; error: { code: string; message: string } }
    }
    if (!promptReceipt.result.ok) {
      throw new Error(`post-fork follow-up rejected: ${JSON.stringify(promptReceipt.result.error)}`)
    }
    await expect.poll(async () => {
      // The resumed loop appends the follow-up turn's closing events durably,
      // so the physical log alone answers whether the turn settled.
      const events = await readPersistedEvents(scaffold, childId)
      const messageIndex = events.findIndex(event => event.type === 'user/message'
        && event.data.content.some(block => block.type === 'text' && block.text === POST_FORK_FOLLOWUP))
      return messageIndex >= 0 && events.slice(messageIndex + 1).some(event => event.type === 'turn/end')
    }, { timeout: 30_000 }).toBe(true)
    expect(scaffold.ctx.agents.get(forkId)).not.toBeUndefined()
    await expect.poll(() => scaffold.ctx.agents.get(childId), { timeout: 10_000 }).toBeUndefined()
  })

  it('shows shared tasks only in the root conversation while keeping child navigation', async () => {
    const parent = scaffold.ctx.agents.get(parentId)
    if (parent === undefined) throw new Error('task-board fixture requires the live parent')
    const enabled = scaffold.ctx.agentTeams.isEnabled(parent)
    onTestFinished(() => scaffold.ctx.agentTeams.setEnabled(parent, enabled))
    await scaffold.ctx.agentTeams.setEnabled(parent, true)
    await scaffold.ctx.agentTeams.createTask(parent, {
      subject: 'Root-only shared task', description: 'Inspect from the root conversation.', writeScopes: [],
    })
    await page.getByRole('tree', { name: 'Sessions' })
      .getByRole('treeitem', { name: /Ask a research subagent to/ }).click()
    await page.getByRole('button', { name: '2 subagents', exact: true }).click()
    await page.locator('[data-team-panel]').getByText('Root-only shared task', { exact: true }).waitFor()
    const rootHeader = page.locator('[data-subagent-section-header]')
    expect(await rootHeader.textContent()).toBe('Subagents1 completed\u2002·\u20021 not running')
    expect(await rootHeader.getByRole('button').count()).toBe(0)
    expect(await rootHeader.locator('[data-icon="dsw-icon-users-outline-regular"]').count()).toBe(1)
    const progress = await rootHeader.textContent()
    await page.getByRole('button', { name: `Expand ${LABEL} descendants`, exact: true }).click()
    await page.getByRole('treeitem', { name: new RegExp(NESTED_LABEL) }).waitFor()
    expect(await rootHeader.textContent()).toBe(progress)
    await page.getByRole('treeitem', { name: new RegExp(LABEL) }).getByText(childId, { exact: true }).click()
    const switcher = page.getByRole('button', { name: `Switch subagent: ${LABEL}`, exact: true })
    await switcher.click()
    const panel = page.locator('[data-subagent-panel]')
    await panel.getByRole('treeitem', { name: new RegExp(ONE_SHOT_LABEL) }).waitFor()
    expect(await panel.locator('[data-team-panel]').count()).toBe(0)
    expect(await panel.evaluate(element => element.getBoundingClientRect().width)).toBe(360)
    const header = panel.locator('[data-subagent-section-header]')
    expect(await header.count()).toBe(0)
    expect(await switcher.textContent()).toBe(LABEL)
    const currentRow = panel.getByRole('treeitem', { name: new RegExp(LABEL) })
    const currentCheck = currentRow.locator('[data-subagent-current]')
    expect(await currentRow.getAttribute('aria-current')).toBe('true')
    expect(await currentCheck.getAttribute('aria-hidden')).toBe('true')
    expect(await currentCheck.evaluate(element => element.tagName)).toBe('SPAN')
    expect(await currentCheck.locator('button, [role="button"], [tabindex]').count()).toBe(0)
    expect(await currentRow.getByRole('button', { name: `Open ${LABEL} in sidebar`, exact: true }).count()).toBe(0)
    const otherRow = panel.getByRole('treeitem', { name: new RegExp(ONE_SHOT_LABEL) })
    expect(await otherRow.locator('[data-subagent-current]').count()).toBe(0)
    expect(await otherRow.getByRole('button', { name: `Open ${ONE_SHOT_LABEL} in sidebar`, exact: true }).isEnabled()).toBe(true)
    await compareOrRefreshGolden(
      fileURLToPath(new URL('./expected/subagent-conversation/navigation-only.expected.md', import.meta.url)),
      await captureStableAria(page, '[data-subagent-panel]', scaffold.workspaceCwd), MODE,
    )
    await page.keyboard.press('Escape')
  })


})

describe('web e2e: migration-required subagent catalog', () => {
  const parentId = sessionId('migration-catalog-parent')
  const childId = sessionId('migration-catalog-child')
  const grandchildId = sessionId('migration-catalog-grandchild')
  const childLabel = 'historical researcher'
  const grandchildLabel = 'historical editor'
  const predecessors: { id: SessionId; directory: string; path: string; source: Buffer }[] = []
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    if (MODE === 'record') throw new Error('migration-required subagent catalog is a keyless assembled snapshot')
    scaffold = await launchWebScaffold()
    const fixture = await readFile(BASE_FIXTURE, 'utf8')
    const createdAt = 1784998084442
    await seedSession(scaffold, fixture, parentId, undefined, { createdAt })
    const parentHandle = await scaffold.ctx.sessionPersistence.open(parentId, 'write')
    try {
      const { events } = await parentHandle.read()
      const last = events.at(-1)
      if (last === undefined) throw new Error('parent seed has no events')
      await parentHandle.append([{
        type: 'subagent/catalog', seq: SessionSeq(last.seq + 1), time: last.time + 1,
        data: { version: 1, childId, childCreatedAt: createdAt + 1, mode: 'continuable', label: childLabel },
      }])
    } finally {
      await parentHandle.close()
    }
    const projects = (await readdir(scaffold.persistenceRoot, { withFileTypes: true })).filter(entry => entry.isDirectory())
    expect(projects).toHaveLength(1)
    const project = projects[0]
    if (project === undefined) throw new Error('parent seed has no project directory')
    // Keep historical bytes on disk; seeding through the writer would migrate them before the browser opens.
    for (const [id, parentSession, label, depth] of [
      [childId, parentId, childLabel, 1],
      [grandchildId, childId, grandchildLabel, 2],
    ] as const) {
      const [header, ...events] = realizeSeedFixture(scaffold, fixture, id).trimEnd().split('\n')
        .map((line): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>)
      expect(header?.version).toBe(3)
      const body = [
        ...events,
        { type: 'subagent/descriptor', data: snapshotSubagentDescriptor({ mode: 'continuable', provider: 'spawn', label }) },
        ...id === childId ? [{
          type: 'subagent/catalog',
          data: { version: 0, childId: grandchildId, childCreatedAt: createdAt + 2, mode: 'continuable', label: grandchildLabel },
        }] : [],
      ]
      const rows = [
        { ...header, id, createdAt: createdAt + depth, cwd: scaffold.workspaceCwd, parentSession, origin: 'subagent', delegationDepth: depth },
        ...body.map((event, seq) => ({ ...event, seq, time: createdAt + depth + seq + 1 })),
      ]
      const directory = join(scaffold.persistenceRoot, project.name, id)
      const path = join(directory, 'session.v3.jsonl.zstd')
      const source = Buffer.concat(rows.map(row => zstdCompressSync(Buffer.from(`${JSON.stringify(row)}\n`))))
      await mkdir(directory, { recursive: true })
      await writeFile(path, source)
      predecessors.push({ id, directory, path, source })
    }
    for (const { id } of predecessors) {
      const stored = await scaffold.ctx.sessionPersistence.stat(id)
      expect(stored?.formatStatus).toBe('migration-required')
      if (stored === undefined) throw new Error(`historical fixture ${id} is missing`)
      expect(scaffold.ctx.sessionProjectionCache.cachedSnapshot(stored.header)).toBeUndefined()
    }
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'migration-required subagent Web teardown failed')
  })

  it('stops at a migration-required child until its history opens', async () => {
    onTestFailed(() => saveFailureShot(page, 'screenshots/non-migrating-session-reads/migration-required-subagent'))
    const observe = vi.spyOn(scaffold.ctx.sessionQuery, 'observeSession')
    const projections = vi.spyOn(scaffold.ctx.sessionController, 'projections')
    const model = vi.spyOn(scaffold.ctx.llm, 'stream')
    try {
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      const workspaceRow = page.getByRole('tree', { name: 'Sessions' }).getByRole('treeitem').first()
      await workspaceRow.click()
      await page.locator(`[data-row-key="session:${parentId}"]`).click()
      await page.getByRole('button', { name: '1 subagent', exact: true }).hover()
      const tree = page.getByRole('tree', { name: 'Subagent sessions' })
      const childRow = tree.getByRole('treeitem', { name: new RegExp(childLabel) })
      await childRow.waitFor()
      await expect.poll(() => childRow.textContent()).toContain('Migration required')
      await expect.poll(() => childRow.getByRole('button', { name: `Expand ${childLabel} descendants`, exact: true }).count()).toBe(0)
      expect(await childRow.getAttribute('aria-expanded')).toBeNull()
      expect(await childRow.textContent()).toContain('Migration required')
      expect(await childRow.textContent()).not.toContain('unknown mode')
      expect(await childRow.getByRole('button', { name: `Open ${childLabel} in sidebar`, exact: true }).isEnabled()).toBe(true)
      expect(await tree.getByRole('treeitem').count()).toBe(1)
      for (const { id, directory, path, source } of predecessors) {
        expect(scaffold.ctx.agents.get(id)).toBeUndefined()
        expect(await readdir(directory)).toEqual(['session.v3.jsonl.zstd'])
        expect(await readFile(path)).toEqual(source)
      }
      const before = await captureStableAria(page, '[role="tree"][aria-label="Subagent sessions"]', scaffold.workspaceCwd)
      expect(observe.mock.calls.some(([id]) => id === childId || id === grandchildId)).toBe(false)
      expect(projections).not.toHaveBeenCalled()

      await childRow.getByText(childId, { exact: true }).click()
      await page.getByRole('button', { name: `Switch subagent: ${childLabel}`, exact: true }).waitFor()
      await page.getByRole('button', { name: '1 subagent', exact: true }).hover()
      const grandchildRow = tree.getByRole('treeitem', { name: new RegExp(grandchildLabel) })
      await grandchildRow.waitFor()
      expect(await grandchildRow.textContent()).toContain('Migration required')
      expect(await grandchildRow.getAttribute('aria-expanded')).toBeNull()
      expect(await grandchildRow.getByRole('button', { name: `Expand ${grandchildLabel} descendants`, exact: true }).count()).toBe(0)
      expect(projections).not.toHaveBeenCalled()
      expect(observe.mock.calls.some(([id]) => id === childId)).toBe(true)
      const after = await captureStableAria(page, '[role="tree"][aria-label="Subagent sessions"]', scaffold.workspaceCwd)
      if (MODE === 'refresh') await mkdir(dirname(MIGRATING_CHILD_EXPECTED), { recursive: true })
      await compareOrRefreshGolden(MIGRATING_CHILD_EXPECTED,
        `# Before opening the child\n\n${before}\n\n# After opening the child\n\n${after}`, MODE)
      for (const { id, path, source } of predecessors) {
        expect(scaffold.ctx.agents.get(id)).toBeUndefined()
        expect(await readFile(path)).toEqual(source)
      }
      expect(observe.mock.calls.some(([id]) => id === grandchildId)).toBe(false)
      expect(model).not.toHaveBeenCalled()
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    } finally {
      projections.mockRestore()
      model.mockRestore()
      observe.mockRestore()
    }
  })
})
