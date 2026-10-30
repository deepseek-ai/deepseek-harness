import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionId as SessionIdValue } from '@deepseek-ai/dsh-session'
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
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/sidebar-subagent-activity', import.meta.url))
const RUNNING_OWNER_EXPECTED = join(SNAPSHOT_DIR, 'owner-running.expected.md')
const MODE = webSnapshotMode()
const HOLD_PROVIDER = 'web-test-hold'
const HOLD_MODEL = 'hold'

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

describe('web e2e: sidebar subagent activity', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let parentHandle: AgentHandle
  let childId: SessionIdValue
  let adapter: StagedAdapter
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    adapter = new StagedAdapter()
    scaffold.ctx.effect(
      () => scaffold.ctx.llm.registerAdapter([HOLD_PROVIDER], adapter),
      'sidebar subagent activity staged adapter',
    )
    const cwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(cwd)
    parentHandle = await scaffold.ctx.agents.create({
      sessionId: SessionId('sidebar-activity-owner'),
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

  it('pins a running descendant on its visible idle owner row', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-subagent-activity'))
    const sidebar = page.getByRole('tree', { name: 'Sessions' })
    const ownerRow = sidebar.getByRole('treeitem', { name: /1 subagent running Delegate a background job/ })
    await ownerRow.waitFor({ timeout: 10_000 })
    expect(parentHandle.agent.status).toBe('idle')
    await compareOrRefreshGolden(
      RUNNING_OWNER_EXPECTED,
      await captureStableAria(page, '[role="tree"][aria-label="Sessions"]', scaffold.workspaceCwd),
      MODE,
    )
    expect(await ownerRow.locator('[data-state="ongoing"]').count()).toBe(1)
    await ownerRow.click()
    const runningTrigger = page.getByRole('button', { name: '1 subagent', exact: true })
    await runningTrigger.waitFor({ timeout: 10_000 })
    expect(await runningTrigger.locator('[data-state="ongoing"]').count()).toBe(1)
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
    try {
      const jobTrigger = page.getByRole('button', { name: '1 background job', exact: true })
      await jobTrigger.waitFor()
      expect(await jobTrigger.evaluate(element => document.getElementById(element.getAttribute('aria-describedby')!)?.textContent)).toBe('Running')
      const controls = [
        { trigger: runningTrigger, icon: '[data-icon="dsw-icon-users-outline-regular"]', count: '[data-subagent-count]' },
        { trigger: jobTrigger, icon: '[data-icon="dsw-icon-layers-outline-regular"]', count: '[data-job-count]' },
      ]
      for (const { trigger, icon, count } of controls) {
        expect(await trigger.locator(count).isVisible()).toBe(true)
        expect(await trigger.locator('[data-state="ongoing"]').isVisible()).toBe(true)
        expect(await trigger.locator(icon).isVisible()).toBe(false)
      }
      await runningTrigger.focus()
      await page.setViewportSize({ width: 390, height: 700 })
      for (const { trigger, icon, count } of controls) {
        await expect.poll(() => trigger.locator(count).isVisible()).toBe(false)
        expect(await trigger.locator(icon).isVisible()).toBe(true)
        expect(await trigger.locator('[data-state="ongoing"]').isVisible()).toBe(false)
      }
      expect(await runningTrigger.evaluate(element => element === document.activeElement)).toBe(true)
      expect(await jobTrigger.evaluate(element => document.getElementById(element.getAttribute('aria-describedby')!)?.textContent)).toBe('Running')
      await compareOrRefreshGolden(
        join(SNAPSHOT_DIR, 'compact-running.expected.md'),
        await captureStableAria(page, 'header:has([data-subagent-action])', scaffold.workspaceCwd),
        MODE,
      )
      await saveFailureShot(page, 'web-e2e-compact-running-icons')
      await runningTrigger.click()
      const members = page.locator('[data-subagent-panel]')
      await members.waitFor()
      expect(await members.getByRole('treeitem').locator('[data-state="ongoing"]').isVisible()).toBe(true)
      await page.keyboard.press('Escape')
      await jobTrigger.click()
      const jobs = page.getByRole('list', { name: 'Background jobs', exact: true })
      await jobs.waitFor()
      expect(await jobs.locator('[data-state="ongoing"]').isVisible()).toBe(true)
      await page.keyboard.press('Escape')
      await page.setViewportSize(viewport)
      for (const { trigger, icon, count } of controls) {
        await expect.poll(() => trigger.locator(count).isVisible()).toBe(true)
        expect(await trigger.locator('[data-state="ongoing"]').isVisible()).toBe(true)
        expect(await trigger.locator(icon).isVisible()).toBe(false)
      }
    } finally {
      completion.resolve({ status: 'completed' })
      await scaffold.ctx.jobs.wait(jobId, 5_000, ownerId)
      await page.keyboard.press('Escape')
      await page.setViewportSize(viewport)
    }
    await assertFixtureInventory(SNAPSHOT_DIR, ['owner-running.expected.md', 'compact-running.expected.md'])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
