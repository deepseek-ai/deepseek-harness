import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionId, SessionId as SessionIdValue } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import {
  connectFreshWorkspace, dismissSessionPanel, newEnglishPage, saveFailureShot, sessionPanelToggle, showSessionPanel,
} from './support.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/sidebar-subagent-activity', import.meta.url))
const RUNNING_OWNER_EXPECTED = join(SNAPSHOT_DIR, 'owner-running.expected.md')
const MODE = webSnapshotMode()
const HOLD_PROVIDER = 'web-test-hold'
const HOLD_MODEL = 'hold'
const PANEL = '@deepseek-ai/dsh-client-ui-session-panel'
const SUBAGENTS = '@deepseek-ai/dsh-client-ui-subagent'
const JOBS = '@deepseek-ai/dsh-client-ui-jobs'
/** Declares style isolation for the three packages above before the Host starts. */
const STYLE_ISOLATION_OVERLAY = fileURLToPath(new URL('./session-panel-style-isolation.overlay.yml', import.meta.url))

/** Sample both marks in one frame; their identical colors hide an incorrect paint order in screenshots. */
async function expectIndicators(page: Page, scoped: boolean, owners: readonly string[]): Promise<void> {
  const sample = () => sessionPanelToggle(page).evaluate((button) => {
    const { top, right } = button.getBoundingClientRect()
    const slot = button.querySelector('[data-slot="conversation.session.panel.indicator"]')!
    const corner = getComputedStyle(slot.parentElement!)
    const marks = [...slot.querySelectorAll('[data-subagents-running], [data-jobs-running]')]
    const stack = document.elementsFromPoint(right - 8, top + 8).filter(node => marks.includes(node))
    return {
      scopes: [button, ...marks].map((node) => {
        const owner = node.closest('[data-plugin]')?.getAttribute('data-plugin')
        const sheets = [...document.querySelectorAll<HTMLStyleElement>('style[data-plugin]')].filter(style => style.dataset.plugin === owner)
        return [owner, sheets.length ? sheets.some(style => style.sheet?.cssRules[0] instanceof CSSScopeRule) : null]
      }),
      cornerPaint: [corner.backgroundColor, corner.boxShadow],
      marks: marks.map((mark) => {
        const box = mark.getBoundingClientRect()
        const style = getComputedStyle(mark)
        return {
          size: [box.width, box.height], inset: [box.top - top, right - box.right], radius: style.borderRadius,
          filled: style.backgroundColor !== 'rgba(0, 0, 0, 0)', ring: style.boxShadow !== 'none',
        }
      }),
      topFirst: stack.map(node => node.closest('[data-plugin]')?.getAttribute('data-plugin')),
    }
  })
  await expect.poll(sample, { timeout: 15_000 }).toEqual({
    scopes: [PANEL, ...owners].map(name => [name, scoped]),
    cornerPaint: ['rgba(0, 0, 0, 0)', 'none'],
    marks: owners.map(() => ({ size: [6, 6], inset: [5, 5], radius: '50%', filled: true, ring: true })),
    topFirst: [...owners].reverse(),
  })
}

/** Model stub that completes the owner turn, then holds its delegated child open. */
class StagedAdapter extends LlmAdapter {
  activeCalls = 0
  private calls = 0

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.calls === 0) {
      this.calls += 1
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    this.calls += 1
    const signal = options.signal
    if (signal === undefined) throw new Error('staged Web adapter requires a turn signal')
    this.activeCalls += 1
    try {
      await new Promise<never>((_resolve, reject) => {
        const abort = (): void => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('holding Web adapter aborted'))
        }
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })
    } finally {
      this.activeCalls -= 1
    }
  }
}

async function waitForRunningChild(
  scaffold: WebScaffold,
  adapter: StagedAdapter,
  childId: SessionIdValue,
): Promise<void> {
  const deadline = Date.now() + 10_000
  while (adapter.activeCalls !== 1 || scaffold.ctx.agents.get(childId)?.status !== 'running') {
    if (Date.now() >= deadline) throw new Error('held child did not enter its running model call')
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}

describe.each([
  { composition: 'shipped styles', scoped: false },
  { composition: 'style-isolated panel packages', scoped: true },
])('web e2e: sidebar subagent activity with $composition', ({ scoped }) => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let parentHandle: AgentHandle
  let childId: SessionIdValue
  let adapter: StagedAdapter
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold(scoped ? { extraOverlayPath: STYLE_ISOLATION_OVERLAY } : {})
    expect(scaffold.ctx.clientModules.graph().entries.filter(row => [PANEL, SUBAGENTS, JOBS].includes(row.id)).map(row => row.isolation))
      .toEqual(Array(3).fill(scoped ? 'style' : undefined))
    adapter = new StagedAdapter()
    scaffold.ctx.effect(
      () => scaffold.ctx.llm.registerAdapter([HOLD_PROVIDER], adapter),
      'sidebar subagent activity staged adapter',
    )
    const cwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(cwd)
    parentHandle = await scaffold.ctx.agents.create({
      sessionId: brandString<SessionId>('sidebar-activity-owner'),
      meta: { cwd },
      agentOptions: { provider: HOLD_PROVIDER, model: HOLD_MODEL },
    })
    parentHandle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Delegate a background job.' }],
      source: { kind: 'user' },
    }))
    await parentHandle.agent.whenIdle()
    const started = await scaffold.ctx.subagents.startActivation({
      delivery: 'parent',
      provider: 'spawn',
      label: 'sidebar activity child',
      signal: new AbortController().signal,
      prompt: [{ type: 'text', text: 'Hold this delegated task open.' }],
      parent: parentHandle.agent,
    })
    childId = started.childId
    await waitForRunningChild(scaffold, adapter, childId)

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(cwd)
    if (workspace === undefined) throw new Error('connected Web workspace was not registered')
    await workspace.attachSession(parentHandle.agent.session.id)
  }, 60_000)

  afterAll(async () => {
    const failures: unknown[] = []
    const child = childId === undefined ? undefined : scaffold?.ctx.agents.get(childId)
    if (child !== undefined) {
      child.cancel({ kind: 'user' })
      await child.whenIdle().catch((error: unknown) => failures.push(error))
    }
    await browser?.close().catch((error: unknown) => failures.push(error))
    await parentHandle?.dispose().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'sidebar subagent activity teardown failed')
  })

  it('pins a running descendant on its idle owner row and stacks its indicator with running jobs on the panel toggle', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-subagent-activity'))
    const sidebar = page.getByRole('tree', { name: 'Sessions' })
    const ownerRow = sidebar.getByRole('treeitem', { name: /1 subagent running.*Delegate a background job/ })
    await ownerRow.waitFor({ timeout: 10_000 })
    expect(parentHandle.agent.status).toBe('idle')
    await compareOrRefreshGolden(
      RUNNING_OWNER_EXPECTED,
      await captureStableAria(page, '[role="tree"][aria-label="Sessions"]', scaffold.workspaceCwd),
      MODE,
    )
    expect(await ownerRow.locator('[data-state="ongoing"]').count()).toBe(1)
    await ownerRow.click()
    const toggle = sessionPanelToggle(page)
    const subagents = (await showSessionPanel(page)).locator('[data-session-panel-section="subagents"]')
    await subagents.getByRole('treeitem').locator('[data-state="ongoing"]').waitFor({ timeout: 10_000 })
    expect(await subagents.getByText('1 in progress', { exact: true }).isVisible()).toBe(true)
    // This directly created owner has no tool preset; the fixture collects its own job.
    scaffold.ctx.effect(() => scaffold.ctx.jobs.attachController('compact header fixture'), 'compact header job controller')
    const completion = Promise.withResolvers<{ status: 'completed' }>()
    const ownerId = parentHandle.agent.id
    const jobId = scaffold.ctx.jobs.start({
      kind: 'bash', label: 'Concurrent background work', owner: ownerId,
      run(handle) {
        handle.append('Background work is running.\n')
        return { done: completion.promise, cancel: () => { completion.resolve({ status: 'completed' }) } }
      },
    })
    const viewport = page.viewportSize()!
    const panel = page.locator('[data-session-panel]')
    const assertRunningSections = async (): Promise<void> => {
      await showSessionPanel(page)
      for (const section of ['subagents', 'background-jobs']) {
        await panel.locator(`[data-session-panel-section="${section}"]`).locator('[data-state="ongoing"]').first()
          .waitFor({ timeout: 10_000 })
      }
      await expectIndicators(page, scoped, [])
      await dismissSessionPanel(page)
    }
    try {
      await assertRunningSections()
      await toggle.focus()
      await page.setViewportSize({ width: 390, height: 700 })
      expect(await toggle.evaluate(element => element === document.activeElement)).toBe(true)
      await expectIndicators(page, scoped, [SUBAGENTS, JOBS])
      await compareOrRefreshGolden(
        join(SNAPSHOT_DIR, 'compact-running.expected.md'),
        await captureStableAria(page, 'header:has([data-session-panel-toggle])', scaffold.workspaceCwd),
        MODE,
      )
      await saveFailureShot(page, 'web-e2e-compact-running-header')
      await assertRunningSections()
      await page.setViewportSize(viewport)
      await assertRunningSections()
    } finally {
      completion.resolve({ status: 'completed' })
      await scaffold.ctx.jobs.wait(jobId, 5_000, ownerId)
      await page.setViewportSize(viewport)
    }
    await expectIndicators(page, scoped, [SUBAGENTS])
    await page.getByRole('button', { name: 'Session panel Subagents running: 1', exact: true }).waitFor()
    const child = scaffold.ctx.agents.get(childId)!
    child.cancel({ kind: 'user' })
    await child.whenIdle()
    await expectIndicators(page, scoped, [])
    await page.getByRole('button', { name: 'Session panel', exact: true }).waitFor()
    await assertFixtureInventory(SNAPSHOT_DIR, ['owner-running.expected.md', 'compact-running.expected.md'])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
