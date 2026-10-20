// Keyless assembled-browser coverage for per-Session Agent Teams
// over the real Host projection frame flow.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-agent-team'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { NO_START_CAPABILITIES } from '@deepseek-ai/dsh-subagent'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/agent-team-panel', import.meta.url))
const PANEL_EXPECTED = join(SNAPSHOT_DIR, 'task.expected.md')
const RESIZE_EXPECTED = join(SNAPSHOT_DIR, 'resize.expected.md')
const MODE = webSnapshotMode()

describe('web e2e: Agent Teams panel', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const agent = scaffold.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('connected Team workspace did not create an Agent')
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Open the task board.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('step/start', { turn: 1, step: 1 })
    agent.session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'Ready.' }],
        source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      }),
    }, { surfaceOp: 'append' })
    agent.session.append('step/end', { turn: 1, step: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(agent.session)
    await page.getByText('Ready.').waitFor({ timeout: 10_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('defaults off and saves a Session selection in the model menu', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-team-mode'))
    expect(await page.locator('[data-subagent-action]').count()).toBe(0)
    await page.getByRole('button', { name: /^Select model/u }).click()
    const toggle = page.getByRole('switch', { name: 'Use Agent Teams', exact: true })
    await toggle.waitFor()
    expect(await toggle.getAttribute('aria-checked')).toBe('false')
    await toggle.focus()
    await page.keyboard.press('ArrowUp')
    expect(await toggle.evaluate(element => element === document.activeElement)).toBe(false)
    await page.keyboard.press('ArrowDown')
    expect(await toggle.evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Space')
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
    await page.keyboard.press('Escape')
    await page.locator('[data-subagent-action]').waitFor()
    const agent = scaffold.ctx.agents.list()[0]!
    const other = await scaffold.ctx.agents.create({ sessionId: SessionId('other-team-mode'), agentOptions: agent.options })
    expect(scaffold.ctx.agentTeams.isEnabled(other.agent)).toBe(false)
    await other.dispose()
    const beforeReload = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.locator('[data-subagent-action]').waitFor()
    await page.getByRole('button', { name: /^Select model/u }).click()
    expect(await toggle.getAttribute('aria-checked')).toBe('true')
    await page.keyboard.press('Escape')
    acknowledgeReloadConnectionLoss(tripwire, beforeReload)
  }, 60_000)

  it('opens the member tree and live read-only tasks in one panel', async (test) => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-team-panel'))
    const projectionReads = vi.spyOn(scaffold.ctx.sessionController, 'projections')
    onTestFinished(() => { projectionReads.mockRestore() })
    await page.locator('[data-subagent-action]').getByRole('button', { name: /subagents?$/u }).click()
    const action = page.locator('[data-subagent-panel]')
    await action.getByText('No shared tasks yet. Create them through the conversation.').waitFor()
    expect(await action.getByRole('heading', { name: 'Members', exact: true }).count()).toBe(0)
    expect(projectionReads).not.toHaveBeenCalled()

    expect(await action.getByRole('button', { name: 'New task' }).count()).toBe(0)
    expect(await action.getByRole('button', { name: /Refresh/u }).count()).toBe(0)

    // Host-side Team mutations reach the open panel through projection frames only.
    const agent = scaffold.ctx.agents.list()[0]!
    onTestFinished(scaffold.ctx.subagents.registerProvider({
      name: 'team-panel-member', inheritsParentContext: false, capabilities: NO_START_CAPABILITIES,
      start: async () => ({
        id: SessionId('team-panel-researcher'),
        result: Promise.resolve({ output: [{ type: 'text', text: 'Research complete' }], stopReason: 'completed' }),
        dispose: async () => {},
      }),
    }))
    const member = await scaffold.ctx.subagents.startActivation({
      name: 'researcher', provider: 'team-panel-member', label: 'Researcher: investigate the construction and verify every bound before reporting the result. '.repeat(8).trim(), delivery: 'caller', signal: test.signal,
      request: { parent: agent, prompt: [{ type: 'text', text: 'Research the task' }] },
    })
    onTestFinished(() => member.dispose())
    await member.result
    await action.getByRole('treeitem', { name: /Researcher/u }).waitFor()
    expect(await page.locator('[data-subagent-panel]').count()).toBe(1)
    expect(await page.getByRole('button', { name: 'Task board', exact: true }).count()).toBe(0)
    expect(await action.evaluate((element) => {
      const tree = element.querySelector('[role="tree"]')!
      const board = element.querySelector('[data-team-panel]')!
      return Boolean(tree.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING)
    })).toBe(true)
    const task = await scaffold.ctx.agentTeams.createTask(agent, {
      subject: 'Agent task', description: 'Created by the root agent', writeScopes: ['src/web'],
    })
    await action.getByText('Agent task', { exact: true }).waitFor()
    await action.getByText('Owner: Unowned', { exact: true }).waitFor()
    await scaffold.ctx.agentTeams.updateTask(agent, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    await action.getByText('In progress', { exact: true }).waitFor()
    await action.getByText('Owner: Lead', { exact: true }).waitFor()
    expect(await action.getByRole('button', { name: /^(New task|Edit|Complete|Reopen|Delete)$/u }).count()).toBe(0)
    expect(await action.locator('input, select, textarea').count()).toBe(0)

    const snapshot = await captureStableAria(page, '[data-subagent-panel]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(PANEL_EXPECTED, snapshot, MODE)
    expect(projectionReads).not.toHaveBeenCalled()
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await page.keyboard.press('Escape')
  }, 60_000)

  it('hides the board while disabled and restores its tasks when re-enabled', async () => {
    await page.getByRole('button', { name: /^Select model/u }).click()
    const toggle = page.getByRole('switch', { name: 'Use Agent Teams', exact: true })
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false')
    expect(await page.locator('[data-subagent-action]').count()).toBe(1)
    await page.keyboard.press('Escape')
    await page.locator('[data-subagent-action]').getByRole('button', { name: '1 subagent', exact: true }).click()
    await page.getByRole('treeitem', { name: /Researcher/u }).waitFor()
    expect(await page.locator('[data-team-panel]').count()).toBe(0)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /^Select model/u }).click()
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
    await page.keyboard.press('Escape')
    await page.locator('[data-subagent-action]').getByRole('button', { name: /subagents?$/u }).click()
    await page.locator('[data-subagent-panel]').getByText('Agent task', { exact: true }).waitFor()
    await page.keyboard.press('Escape')
  })

  it('keeps the panel inside the viewport and closes on outside click or Escape', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-team-panel-keyboard'))
    const panel = page.locator('[data-subagent-panel]')
    const trigger = page.locator('[data-subagent-action]').getByRole('button', { name: /subagents?$/u })
    const viewport = page.viewportSize()!
    await trigger.click()
    await panel.getByRole('heading', { name: /Shared tasks/u }).waitFor()
    try {
      for (const size of [{ width: 760, height: 540 }, { width: 600, height: 420 }, { width: 390, height: 700 }]) {
        await page.setViewportSize(size)
        await expect.poll(() => panel.evaluate((element) => {
          const rect = element.getBoundingClientRect()
          return element.parentElement === document.body
            && rect.left >= 16 && rect.top >= 16
            && rect.right <= window.innerWidth - 16 && rect.bottom <= window.innerHeight - 16
            && [[rect.left + 12, rect.top + 12], [rect.right - 12, rect.bottom - 12]]
              .every(([x, y]) => element.contains(document.elementFromPoint(x!, y!)))
        })).toBe(true)
      }
      const description = panel.getByRole('button', { name: 'Expand description for researcher', exact: true })
      const preview = description.locator('span')
      expect(await preview.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
      await description.focus()
      await page.keyboard.press('Enter')
      const expanded = panel.getByRole('button', { name: 'Collapse description for researcher', exact: true })
      expect(await expanded.getAttribute('aria-expanded')).toBe('true')
      expect(await expanded.locator('span').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      expect(await expanded.evaluate(element => element === document.activeElement)).toBe(true)
      await expanded.click()
      expect(await description.getAttribute('aria-expanded')).toBe('false')
      await panel.getByRole('heading', { name: /Shared tasks/u }).click()
      expect(await panel.count()).toBe(1)
      await page.mouse.click(2, 2)
      await panel.waitFor({ state: 'detached' })
      await page.setViewportSize(viewport)
      await trigger.focus()
      await page.keyboard.press('Enter')
      await panel.getByRole('heading', { name: /Shared tasks/u }).waitFor()
      expect(await panel.evaluate(element => element === document.activeElement)).toBe(true)
      await page.keyboard.press('Escape')
      await panel.waitFor({ state: 'detached' })
      expect(await trigger.evaluate(element => element === document.activeElement)).toBe(true)
      await page.keyboard.press('Enter')
      await panel.waitFor()
      const outside = page.getByRole('button', { name: 'Account menu', exact: true })
      await outside.focus()
      expect(await panel.count()).toBe(1)
      await page.keyboard.press('Escape')
      await panel.waitFor({ state: 'detached' })
      expect(await outside.evaluate(element => element === document.activeElement)).toBe(true)
    } finally {
      await page.setViewportSize(viewport)
    }
  })

  it('keeps the hovered panel open when the pointer returns directly to its trigger', async () => {
    const trigger = page.locator('[data-subagent-action]').getByRole('button', { name: /subagents?$/u })
    const panel = page.locator('[data-subagent-panel]')
    await trigger.hover()
    await panel.waitFor()
    await panel.hover()
    await trigger.hover()
    // The assertion spans the 120ms dismissal grace while the pointer stays on the trigger.
    await page.waitForTimeout(180)
    expect(await panel.count()).toBe(1)
    await page.keyboard.press('Escape')
  })

  it('offers expansion when resizing makes a task description exceed two lines', async () => {
    const agent = scaffold.ctx.agents.list()[0]!
    await scaffold.ctx.agentTeams.createTask(agent, {
      subject: 'Responsive task',
      description: 'Check the task description before you start work. '.repeat(3),
      writeScopes: [],
    })
    const viewport = page.viewportSize()!
    const trigger = page.locator('[data-subagent-action]').getByRole('button', { name: /subagents?$/u })
    const panel = page.locator('[data-subagent-panel]')
    const card = panel.locator('article').filter({ hasText: 'Responsive task' })
    await trigger.click()
    await card.waitFor()
    expect(await card.getByRole('button', { name: 'Show more' }).count()).toBe(0)
    try {
      await page.setViewportSize({ width: 390, height: 700 })
      await card.getByRole('button', { name: 'Show more' }).waitFor()
      expect(await card.locator('p').evaluate(p => p.scrollHeight > p.clientHeight)).toBe(true)
      await compareOrRefreshGolden(RESIZE_EXPECTED, await captureStableAria(page, '[data-subagent-panel]', scaffold.workspaceCwd), MODE)
      await card.getByRole('button', { name: 'Show more' }).click()
      expect(await card.locator('p').evaluate(p => p.scrollHeight === p.clientHeight)).toBe(true)
      await card.getByRole('button', { name: 'Show less' }).click()
      await page.setViewportSize(viewport)
      await expect.poll(() => card.getByRole('button', { name: 'Show more' }).count()).toBe(0)
    } finally {
      await page.keyboard.press('Escape')
      await page.setViewportSize(viewport)
    }
  })

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['task.expected.md', 'resize.expected.md'])
  })
})
