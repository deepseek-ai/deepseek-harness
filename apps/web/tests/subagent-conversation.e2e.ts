import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionLogOffset,
  SESSION_FORMAT_VERSION, SessionId as sessionId, type SessionEvent, type SessionHeader, type SessionId,
} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import {
  acknowledgeReloadConnectionLoss, captureExpandedTurnProcessAria, captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold, readPersistedEvents, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const BASE_FIXTURE = fileURLToPath(new URL('../../../snapshots/web/live-interactions/session.jsonl', import.meta.url))
const AVAILABLE_CHILD_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/subagent-conversation/ui.expected.md', import.meta.url))
const AVAILABLE_CHILD_EXPANDED_EXPECTED = fileURLToPath(
  new URL('../../../snapshots/web/subagent-conversation/ui-expanded.expected.md', import.meta.url),
)
const TREE_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/subagent-conversation/tree.expected.md', import.meta.url))
const BRANCHLESS_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/subagent-conversation/branchless.expected.md', import.meta.url))
const STALE_CATALOG_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/subagent-conversation/stale-catalog.expected.md', import.meta.url))
const SIDEBAR_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/subagent-conversation/sidebar.expected.md', import.meta.url))
const UNAVAILABLE_GRANDCHILD_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/subagent-conversation/nested.expected.md', import.meta.url))
const FORK_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/subagent-conversation/fork.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const LABEL = 'event-sourcing researcher'
const ONE_SHOT_LABEL = 'event-sourcing reviewer'
const NESTED_LABEL = 'example editor'
const PARENT_PROMPT = 'Ask a research subagent to explain event sourcing.'
const INITIAL_PROMPT = 'Explain event sourcing in one sentence.'
/** The grandchild's own first message; its arrival is what says its history finished loading. */
const NESTED_PROMPT = 'Give one concrete event sourcing example.'
const FOLLOWUP = 'Now give the same explanation to a human reader.'
const POST_FORK_FOLLOWUP = 'Continue the original conversation after the fork.'

function childFixture(source: string, fixtureId: string, withContinuation: boolean): string {
  const [header, ...eventLines] = source.trimEnd().split('\n')
  if (header === undefined) throw new Error('base replay fixture has no header')
  const childHeader = header
    .replace('"id":"{{sessionId}}"', `"id":"${fixtureId}"`)
    .replace(/"createdAt":\d+/, '"createdAt":1784998084442')
  if (!withContinuation) return [childHeader, ...eventLines, ''].join('\n')
  const continued = eventLines.map(line => line
    .replace(/"seq":(\d+)/g, (_match, seq: string) => `"seq":${String(Number(seq) + 100)}`)
    .replace(/"seq0":(\d+)/g, (_match, seq: string) => `"seq0":${String(Number(seq) + 100)}`)
    .replaceAll('"turn":1', '"turn":2'))
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
  while (scaffold.ctx.sessionProjectionCache.cachedSnapshot(header, SessionLogOffset(0)) === undefined) {
    if (Date.now() >= deadline) throw new Error(`cache row for "${header.id}" did not land`)
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}

describe('web e2e: persisted subagent conversation and human continuation', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let sidecarRoot: string
  let childId: SessionId
  let oneShotId: SessionId
  let grandchildId: SessionId
  let tripwire: ReturnType<typeof watchConsole>
  const apiCalls: string[] = []

  beforeAll(async () => {
    if (MODE === 'record') throw new Error('subagent conversation is a keyless assembled snapshot')
    const baseFixture = await readFile(BASE_FIXTURE, 'utf8')
    sidecarRoot = await mkdtemp(join(tmpdir(), 'dsh-web-subagent-'))
    const childFixturePath = join(sidecarRoot, 'child.jsonl')
    await writeFile(childFixturePath, childFixture(baseFixture, 'recorded-subagent', true))
    scaffold = await launchWebScaffold({
      replayFixture: BASE_FIXTURE,
      compareReplaySession: false,
      replayChildFixtures: [childFixturePath],
      paceMs: 25,
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (path.startsWith('/api/')) apiCalls.push(path)
    })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)

    const parent = scaffold.ctx.agents.roots()[0]
    if (parent === undefined) throw new Error('fresh workspace did not publish its parent Agent')
    const parentSettled = scaffold.whenTurnSettled()
    const parentInput = page.locator('[data-composer-input][contenteditable="true"]').first()
    await parentInput.fill(PARENT_PROMPT)
    await parentInput.press('Enter')
    expect(await parentSettled).toBe(parent.id)

    const started = await scaffold.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: LABEL,
      signal: new AbortController().signal,
      request: {
        prompt: [{ type: 'text', text: INITIAL_PROMPT }],
        parent,
      },
    })
    childId = started.childId
    await waitForAgentToSettle(scaffold, childId)
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
        data: snapshotSubagentDescriptor({
          mode: 'one-shot', provider: 'spawn', label: ONE_SHOT_LABEL,
        }),
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
    expect(scaffold.ctx.agents.get(childId)).toBeUndefined()
    expect(scaffold.ctx.agents.get(oneShotId)).toBeUndefined()
    expect(scaffold.ctx.agents.get(grandchildId)).toBeUndefined()
    await expect(scaffold.ctx.subagents.listChildren(parent.id)).resolves.toMatchObject([
      {
        kind: 'child', id: oneShotId, mode: 'one-shot',
        label: ONE_SHOT_LABEL, activity: 'inactive', hasChildren: false,
      },
      {
        kind: 'child', id: childId, mode: 'continuable', label: LABEL,
        activity: 'inactive', hasChildren: true,
      },
    ])
    await expect(scaffold.ctx.subagents.listChildren(childId)).resolves.toMatchObject([
      {
        kind: 'child', id: grandchildId, mode: 'continuable',
        label: NESTED_LABEL, activity: 'inactive', hasChildren: false,
      },
    ])
    // These two cold fixtures were authored after the page's initial
    // session.list and intentionally emitted no api-session/added event. Reload
    // to exercise the restart baseline that discovers their full lineage.
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const catalogButton = page.getByRole('button', { name: '3 subagents', exact: true })
    await catalogButton.waitFor({ timeout: 15_000 })
    await catalogButton.hover()
    const catalogTree = page.getByRole('tree', { name: 'Subagent sessions' })
    await catalogTree.getByRole('treeitem').nth(1).waitFor({ timeout: 15_000 })
    await catalogTree.press('Escape')
    await page.getByRole('button', { name: '3 subagents' }).waitFor({ timeout: 15_000 })
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
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'subagent Web teardown failed')
  })

  it('keeps known descendants reachable across a stale empty catalog response', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-stale-catalog'))
    const pattern = '**/api/subagents/list'
    let firstClaimed = false
    let emptyDelivered = false
    let trailingRequested = false
    let releaseCatalog = (): void => {}
    const catalogHeld = new Promise<void>((resolve) => { releaseCatalog = resolve })
    await page.route(pattern, async (route) => {
      if (firstClaimed) {
        const response = await route.fetch()
        trailingRequested = true
        await catalogHeld
        await route.fulfill({ response })
        return
      }
      firstClaimed = true
      const response = await route.fetch()
      const body = await response.json() as {
        result: { ok: true; value: { entries: unknown[] } } | { ok: false }
      }
      if (body.result.ok) body.result.value.entries = []
      await route.fulfill({ response, json: body })
      emptyDelivered = true
    })

    const warningStart = tripwire.warnings.length
    try {
      await page.reload({ waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await expect.poll(() => emptyDelivered, { timeout: 15_000 }).toBe(true)
      await page.getByRole('button', { name: '3 subagents' }).waitFor({ timeout: 15_000 })
      acknowledgeReloadConnectionLoss(tripwire, warningStart)

      await page.getByRole('button', { name: '3 subagents' }).hover()
      await expect.poll(() => trailingRequested, { timeout: 15_000 }).toBe(true)
      const tree = page.getByRole('tree', { name: 'Subagent sessions' })
      await tree.getByRole('treeitem', { name: 'Loading subagents' }).first().waitFor()
      expect(await tree.getByRole('treeitem', { name: 'Loading subagents' }).count()).toBe(2)
      await compareOrRefreshGolden(
        STALE_CATALOG_EXPECTED,
        await captureStableAria(page, '[role="tree"][aria-label="Subagent sessions"]', scaffold.workspaceCwd),
        MODE,
      )
      releaseCatalog()
      await tree.getByRole('treeitem', { name: new RegExp(LABEL) }).waitFor({ timeout: 15_000 })
      await tree.press('Escape')
    } finally {
      releaseCatalog()
      await page.unroute(pattern)
    }
  })

  it('expands a persisted grandchild progressively without activating either level', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-tree'))
    await page.getByRole('button', { name: '3 subagents' }).hover()
    const catalogTree = page.getByRole('tree', { name: 'Subagent sessions' })
    expect(await catalogTree.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + 8, rect.top + 8)
      return hit !== null && element.contains(hit)
    })).toBe(true)
    expect(await page.getByRole('button', {
      name: `Expand ${ONE_SHOT_LABEL} descendants`,
    }).count()).toBe(0)
    const oneShotRow = page.getByRole('treeitem', { name: new RegExp(ONE_SHOT_LABEL) })
    expect(await oneShotRow.getByText('~6mo 12d', { exact: true }).count()).toBe(1)
    expect(await oneShotRow.getAttribute('aria-label')).toContain('192d 00h 00m 00s')
    await page.getByRole('button', { name: `Expand ${LABEL} descendants` }).click()
    const childRow = page.getByRole('treeitem', { name: new RegExp(LABEL) })
    const childLabel = await childRow.getAttribute('aria-label')
    await page.waitForTimeout(1_100)
    expect(await childRow.getAttribute('aria-label')).toBe(childLabel)
    await page.getByRole('treeitem', { name: new RegExp(NESTED_LABEL) }).waitFor({ timeout: 15_000 })
    expect(scaffold.ctx.agents.get(childId)).toBeUndefined()
    expect(scaffold.ctx.agents.get(grandchildId)).toBeUndefined()
    const snapshot = await captureStableAria(
      page,
      '[role="tree"][aria-label="Subagent sessions"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(TREE_EXPECTED, snapshot, MODE)
    await page.getByRole('tree', { name: 'Subagent sessions' }).press('Escape')
  })

  it('opens the completed child from persistence without activating it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-open'))
    await page.getByRole('button', { name: '3 subagents' }).hover()
    await page.getByRole('treeitem', { name: new RegExp(LABEL) }).click()
    await expect.poll(
      () => page.getByText(/^Explain event sourcing in one sentence\.Your parent agent id is /).count(),
      { timeout: 15_000 },
    ).toBe(1)
    if (scaffold.ctx.agents.get(childId) !== undefined) {
      throw new Error(`viewing the child activated it; API calls: ${apiCalls.join(', ')}`)
    }
    const hierarchy = page.getByRole('navigation', { name: 'Session hierarchy' })
    await hierarchy.getByRole('button', { name: `Switch subagent: ${LABEL}` }).waitFor()
    const sidebar = await captureStableAria(
      page,
      '[role="tree"][aria-label="Sessions"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(SIDEBAR_EXPECTED, sidebar, MODE)
  })

  it('keeps a restored child neutral until its parent availability arrives', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-restore'))
    const pattern = '**/api/subagents/list'
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
      expect(await page.locator('[data-composer-seat]').evaluate(element =>
        getComputedStyle(element).visibility)).toBe('hidden')
      releaseCatalog()
      const input = page.getByRole('textbox', { name: 'Message or run a task... / commands, @ files or sessions' })
      await input.waitFor({ timeout: 15_000 })
      await expect.poll(() => input.isEnabled(), { timeout: 15_000 }).toBe(true)
      acknowledgeReloadConnectionLoss(tripwire, warningStart)
    } finally {
      releaseCatalog()
      await page.unroute(pattern)
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
    const input = page.getByRole('textbox', { name: 'Message or run a task... / commands, @ files or sessions' })
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

  it('opens an unavailable persisted grandchild after recording the available child', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-grandchild'))
    await page.getByRole('button', { name: '1 subagent' }).hover()
    const tree = page.getByRole('tree', { name: 'Subagent sessions' })
    const nestedRow = tree.locator('[role="treeitem"]').filter({ hasText: NESTED_LABEL })
    await nestedRow.waitFor({ timeout: 15_000 })
    const clickArea = nestedRow.locator(':scope > div')
    expect(await clickArea.count()).toBe(1)
    const [treeBox, clickAreaBox] = await Promise.all([
      tree.boundingBox(),
      clickArea.boundingBox(),
    ])
    expect(treeBox).not.toBeNull()
    expect(clickAreaBox).not.toBeNull()
    expect([
      Math.round(clickAreaBox!.x - treeBox!.x),
      Math.round(treeBox!.x + treeBox!.width - clickAreaBox!.x - clickAreaBox!.width),
    // Menu padding alone insets the rows now that the border is gone.
    ]).toEqual([4, 4])
    await compareOrRefreshGolden(
      BRANCHLESS_EXPECTED,
      await captureStableAria(page, '[role="tree"][aria-label="Subagent sessions"]', scaffold.workspaceCwd),
      MODE,
    )
    await nestedRow.click()
    await page.getByText('The parent session is offline; reopen it to continue sending messages.').waitFor()
    // The offline banner renders from the descriptor alone, so it says nothing
    // about the transcript below it. The golden pins that transcript, and
    // `captureStableAria` calls two identical polls stable — including two of
    // "Loading history…". Wait for the message the golden asserts.
    await page.getByText(NESTED_PROMPT).waitFor()
    const hierarchy = page.getByRole('navigation', { name: 'Session hierarchy' })
    const crumbs = await hierarchy.getByRole('button').allTextContents()
    expect(crumbs.slice(-2)).toEqual([LABEL, NESTED_LABEL])
    expect(scaffold.ctx.agents.get(childId)).toBeUndefined()
    expect(scaffold.ctx.agents.get(grandchildId)).toBeUndefined()
    await compareOrRefreshGolden(
      UNAVAILABLE_GRANDCHILD_EXPECTED,
      await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd),
      MODE,
    )
  })

  it('opens a one-shot child as permanently read-only history', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-one-shot'))
    const parentSession = page.getByRole('tree', { name: 'Sessions' })
      .getByRole('treeitem')
      .last()
    await parentSession.click()
    await page.getByRole('button', { name: '3 subagents' }).hover()
    await page.getByRole('treeitem', { name: new RegExp(ONE_SHOT_LABEL) }).click()
    await page.getByText('One-shot tasks do not accept follow-ups; review the full execution record here.').waitFor()
    expect(scaffold.ctx.agents.get(oneShotId)).toBeUndefined()
  })

  it('places an ordinary fork from a subagent beside its workspace-owning ancestor', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-fork'))
    await page.getByRole('tree', { name: 'Sessions' })
      .getByRole('treeitem', { name: /Ask a research subagent to/ })
      .click()
    await page.getByRole('button', { name: '3 subagents' }).hover()
    await page.getByRole('treeitem', { name: new RegExp(LABEL) }).click()
    await page.getByRole('textbox', { name: 'Message or run a task... / commands, @ files or sessions' }).waitFor()
    const forkResponse = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/session/fork')
    await page.getByRole('button', { name: 'Branch into a new conversation' }).last().click()
    const forkReceipt = await (await forkResponse).json() as { result: { ok: boolean } }
    expect(forkReceipt.result).toMatchObject({ ok: true })
    await expect.poll(
      () => page.getByRole('tree', { name: 'Sessions' }).getByRole('treeitem').count(),
      { timeout: 15_000 },
    ).toBe(3)
    expect(await page.getByText('Ungrouped', { exact: true }).count()).toBe(0)
    const hierarchy = page.getByRole('navigation', { name: 'Session hierarchy' })
    await expect.poll(() => hierarchy.getByRole('button').count()).toBe(1)
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
    await page.getByRole('button', { name: '3 subagents' }).hover()
    await page.getByRole('treeitem', { name: new RegExp(LABEL) }).click()
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
    await page.getByRole('button', { name: '3 subagents' }).press('ArrowDown')
    await page.getByRole('treeitem', { name: new RegExp(LABEL) }).click()
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
})
