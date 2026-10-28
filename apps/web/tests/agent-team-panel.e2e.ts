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
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { assertWarningDialogLayout, connectFreshWorkspace, connectFreshWorkspaceZh, newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/agent-team-panel', import.meta.url))
const PANEL_EXPECTED = join(SNAPSHOT_DIR, 'task.expected.md')
const RESIZE_EXPECTED = join(SNAPSHOT_DIR, 'resize.expected.md')
const MODE = webSnapshotMode()
const RESEARCHER_DESCRIPTION = 'Researcher: investigate the construction and verify every bound before reporting the result. '.repeat(8).trim()

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

  it('explains Agent Teams on hover and focus without changing the Session selection', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-team-info'))
    await page.getByRole('button', { name: /^Select model/u }).click()
    const info = page.getByRole('button', { name: 'About Agent Teams', exact: true })
    const toggle = page.getByRole('switch', { name: 'Use Agent Teams', exact: true })
    const tooltip = page.getByRole('tooltip')
    await info.hover()
    await tooltip.waitFor({ state: 'visible' })
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'info.expected.md'), await captureStableAria(page, '[role="tooltip"]', scaffold.workspaceCwd), MODE)
    expect(await toggle.getAttribute('aria-checked')).toBe('false')
    await page.getByRole('button', { name: /^Select model/u }).hover()
    await tooltip.waitFor({ state: 'hidden' })
    await page.keyboard.press('Shift')
    await info.focus()
    await tooltip.waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await tooltip.waitFor({ state: 'hidden' })
    expect(await toggle.isVisible()).toBe(true)
    await info.click()
    await tooltip.waitFor({ state: 'visible' })
    expect(await info.getAttribute('aria-describedby')).toBe(await tooltip.getAttribute('id'))
    expect(await toggle.getAttribute('aria-checked')).toBe('false')
    await page.keyboard.press('Escape')
    await tooltip.waitFor({ state: 'hidden' })
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  })

  it('toggles from the row label and empty space while keeping the information button independent', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-team-row'))
    await page.getByRole('button', { name: /^Select model/u }).click()
    const toggle = page.getByRole('switch', { name: 'Use Agent Teams', exact: true })
    const info = page.getByRole('button', { name: 'About Agent Teams', exact: true })
    const label = page.getByText('Use Agent Teams', { exact: true })
    const labelBounds = await label.boundingBox()
    if (labelBounds === null) throw new Error('Team label is not visible')
    const labelPoint = { x: labelBounds.x + labelBounds.width / 2, y: labelBounds.y + labelBounds.height / 2 }
    await page.mouse.move(labelPoint.x, labelPoint.y)
    expect(await toggle.evaluate((element) => {
      const row = element.parentElement!
      return getComputedStyle(row).backgroundColor !== 'rgba(0, 0, 0, 0)'
    })).toBe(true)
    await page.mouse.click(labelPoint.x, labelPoint.y)
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
    await info.click()
    await page.getByRole('tooltip').waitFor({ state: 'visible' })
    expect(await toggle.getAttribute('aria-checked')).toBe('true')
    await page.keyboard.press('Escape')
    const gap = await toggle.evaluate((element) => {
      const control = element.getBoundingClientRect()
      const help = element.parentElement!.querySelector('button:not([role="switch"])')!.getBoundingClientRect()
      return { x: (help.right + control.left) / 2, y: control.top + control.height / 2 }
    })
    await page.mouse.click(gap.x, gap.y)
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false')
    expect(await page.getByRole('tooltip').count()).toBe(0)
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
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
    expect(await page.locator('[data-subagent-action]').count()).toBe(0)
    const agent = scaffold.ctx.agents.list()[0]!
    const other = await scaffold.ctx.agents.create({ sessionId: SessionId('other-team-mode'), agentOptions: agent.options })
    expect(scaffold.ctx.agentTeams.isEnabled(other.agent)).toBe(false)
    await other.dispose()
    const beforeReload = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('button', { name: /^Select model/u }).click()
    expect(await page.locator('[data-subagent-action]').count()).toBe(0)
    expect(await toggle.getAttribute('aria-checked')).toBe('true')
    await page.keyboard.press('Escape')
    acknowledgeReloadConnectionLoss(tripwire, beforeReload)
  }, 60_000)

  it('submits Team commands and keeps text editing usable after refocusing', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-team-command-input'))
    const input = page.locator('[data-composer-input]').first()
    const agent = scaffold.ctx.agents.list()[0]!
    for (const enabled of [false, true]) {
      await writeComposerDraft(page, input, `/team ${enabled ? 'on' : 'off'}`)
      await input.press('Enter')
      await expect.poll(() => scaffold.ctx.agentTeams.isEnabled(agent)).toBe(enabled)
      await expect.poll(() => input.textContent()).toBe('')
      await page.getByRole('button', { name: 'Account menu', exact: true }).focus()
      await input.click()
      await page.keyboard.insertText('asdas')
      await expect.poll(() => input.textContent()).toBe('asdas')
      expect(await input.evaluate((element) => {
        const selection = window.getSelection()
        return document.activeElement === element && selection?.isCollapsed === true
          && selection.anchorNode?.textContent === 'asdas' && selection.anchorOffset === 5
      })).toBe(true)
      await input.press('Backspace')
      await expect.poll(() => input.textContent()).toBe('asda')
      await writeComposerDraft(page, input, '')
    }
    expect(tripwire.pageErrors).toEqual([])
  })

  it('shows tasks without children or a divider and hides the entry after the last task is deleted', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-team-task-only'))
    const agent = scaffold.ctx.agents.list()[0]!
    expect(await page.locator('[data-subagent-action]').count()).toBe(0)
    const task = await scaffold.ctx.agentTeams.createTask(agent, {
      subject: 'Plan before delegation', description: 'Prepare shared work before creating subagents',
    })
    await page.getByRole('button', { name: '0 subagents', exact: true }).click()
    const board = page.locator('[data-team-panel]')
    await board.getByText(task.subject, { exact: true }).waitFor()
    expect(await page.locator('[data-subagent-panel]').getByRole('treeitem').count()).toBe(0)
    expect(await board.evaluate((element) => {
      const style = getComputedStyle(element)
      return { border: style.borderTopWidth, margin: style.marginTop }
    })).toEqual({ border: '0px', margin: '0px' })
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'task-only.expected.md'),
      await captureStableAria(page, '[data-subagent-panel]', scaffold.workspaceCwd), MODE)
    await scaffold.ctx.agentTeams.updateTask(agent, { taskId: task.id, expectedRevision: task.revision, action: 'delete' })
    await page.locator('[data-subagent-action]').waitFor({ state: 'hidden' })
    await page.locator('[data-subagent-panel]').waitFor({ state: 'hidden' })
    expect(tripwire.pageErrors).toEqual([])
  })

  it('opens the member tree and live read-only tasks in one panel', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-team-panel'))
    const projectionReads = vi.spyOn(scaffold.ctx.sessionController, 'projections')
    onTestFinished(() => { projectionReads.mockRestore() })
    const agent = scaffold.ctx.agents.list()[0]!
    const memberId = SessionId('team-panel-researcher')
    agent.session.append('subagent/catalog', {
      version: 2, childId: memberId, childCreatedAt: Date.now(), mode: 'external',
      label: RESEARCHER_DESCRIPTION,
    })
    scaffold.ctx.subagentNames.bind(agent, memberId, 'lead/researcher')
    await page.locator('[data-subagent-action]').getByRole('button', { name: /subagents?$/u }).click()
    const action = page.locator('[data-subagent-panel]')
    await action.getByText('No shared tasks yet. Create them through the conversation.').waitFor()
    expect(await action.getByRole('heading', { name: 'Members', exact: true }).count()).toBe(0)
    expect(projectionReads).not.toHaveBeenCalled()

    expect(await action.getByRole('button', { name: 'New task' }).count()).toBe(0)
    expect(await action.getByRole('button', { name: /Refresh/u }).count()).toBe(0)

    await action.getByRole('treeitem', { name: /Researcher/u }).waitFor()
    expect(await action.locator('[data-team-panel]').evaluate(element => Number.parseFloat(getComputedStyle(element).borderTopWidth))).toBeGreaterThan(0)
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
      const row = panel.getByRole('treeitem', { name: /Researcher/u })
      const primary = row.getByText(RESEARCHER_DESCRIPTION, { exact: true })
      const secondary = row.getByText('researcher', { exact: true })
      expect(await row.getByRole('button').count()).toBe(0)
      expect(await primary.evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          tag: element.tagName, clipped: element.scrollWidth > element.clientWidth,
          whiteSpace: style.whiteSpace, overflow: style.overflowX, textOverflow: style.textOverflow,
        }
      })).toEqual({ tag: 'SPAN', clipped: true, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' })
      const primaryBounds = await primary.boundingBox()
      const secondaryBounds = await secondary.boundingBox()
      expect(primaryBounds).not.toBeNull()
      expect(secondaryBounds).not.toBeNull()
      expect(primaryBounds!.y + primaryBounds!.height).toBeLessThanOrEqual(secondaryBounds!.y)
      const beforeHover = page.url()
      await primary.hover()
      const tooltip = page.getByRole('tooltip', { name: RESEARCHER_DESCRIPTION, exact: true })
      await tooltip.waitFor({ state: 'visible' })
      expect(await tooltip.textContent()).toBe(RESEARCHER_DESCRIPTION)
      expect(await tooltip.evaluate(element => element.parentElement === document.body)).toBe(true)
      expect(page.url()).toBe(beforeHover)
      expect(await page.getByText('Ready.', { exact: true }).isVisible()).toBe(true)
      expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await panel.getByRole('heading', { name: /Shared tasks/u }).hover()
      await tooltip.waitFor({ state: 'detached' })
      expect(await secondary.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await secondary.hover()
      expect(await page.getByRole('tooltip').count()).toBe(0)
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

  it('confirms disabling after a recorded model request and keeps cancellation side-effect free', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-team-disable-confirmation'))
    const agent = scaffold.ctx.agents.list()[0]!
    const selection = agent.model.current()
    if (selection === undefined) throw new Error('Team fixture has no selected model')
    agent.session.append('request/header', { header: { config: selection }, reason: 'initial' })
    await scaffold.ctx.sessions.flush(agent.session)
    const openConfirmation = async (): Promise<void> => {
      await page.getByRole('button', { name: /^Select model/u }).click()
      await page.getByRole('switch', { name: 'Use Agent Teams', exact: true }).click()
      await page.getByRole('dialog', { name: 'Turn off Agent Teams?', exact: true }).waitFor()
    }
    await openConfirmation()
    const dialog = page.getByRole('dialog', { name: 'Turn off Agent Teams?', exact: true })
    await assertWarningDialogLayout(dialog)
    expect(await page.getByRole('menu', { name: 'Model and reasoning effort', exact: true }).count()).toBe(0)
    expect(await dialog.getByRole('checkbox').count()).toBe(0)
    expect(scaffold.ctx.agentTeams.isEnabled(agent)).toBe(true)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'disable-confirmation.expected.md'),
      await captureStableAria(page, '[aria-modal="true"]', scaffold.workspaceCwd), MODE)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    expect(scaffold.ctx.agentTeams.isEnabled(agent)).toBe(true)
    await openConfirmation()
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    expect(scaffold.ctx.agentTeams.isEnabled(agent)).toBe(true)
    await openConfirmation()
    await dialog.getByRole('button', { name: 'Confirm turn off', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await expect.poll(() => scaffold.ctx.agentTeams.isEnabled(agent)).toBe(false)
    await page.getByRole('button', { name: /^Select model/u }).click()
    await page.getByRole('switch', { name: 'Use Agent Teams', exact: true }).click()
    await expect.poll(() => scaffold.ctx.agentTeams.isEnabled(agent)).toBe(true)
    expect(await dialog.count()).toBe(0)
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  })

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['task.expected.md', 'resize.expected.md', 'info.expected.md', 'task-only.expected.md', 'disable-confirmation.expected.md', 'collaboration.zh.expected.md'])
  })
})

it('uses the Chinese collaboration name in the switch and disable confirmation', async () => {
  const scaffold = await launchWebScaffold()
  let browser: Browser | undefined
  try {
    browser = await chromium.launch()
    const page = await browser.newPage({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
    const agent = scaffold.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('Chinese Team fixture has no Agent')
    await scaffold.ctx.agentTeams.setEnabled(agent, true)
    const selection = agent.model.current()
    if (selection === undefined) throw new Error('Chinese Team fixture has no model')
    agent.session.append('request/header', { header: { config: selection }, reason: 'initial' })
    await scaffold.ctx.sessions.flush(agent.session)
    await page.getByRole('button', { name: /^选择模型/u }).click()
    const toggle = page.getByRole('switch', { name: '启用智能体团队协作', exact: true })
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
    await page.getByRole('button', { name: '关于智能体团队协作', exact: true }).waitFor()
    expect(await toggle.evaluate(element => element.parentElement!.scrollWidth <= element.parentElement!.clientWidth)).toBe(true)
    const menu = await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd)
    await toggle.click()
    const dialog = page.getByRole('dialog', { name: '确认停用智能体团队协作？', exact: true })
    await dialog.waitFor()
    await dialog.getByText('对话过程中停用智能体团队协作，将停止共享任务工具和团队协调指令，已有任务记录将会完整保留。', { exact: true }).waitFor()
    await assertWarningDialogLayout(dialog)
    const confirmation = await captureStableAria(page, '[aria-modal="true"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'collaboration.zh.expected.md'),
      `## Menu\n\n${menu}\n\n## Confirmation\n\n${confirmation}`, MODE)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    expect(scaffold.ctx.agentTeams.isEnabled(agent)).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  } finally {
    try { await browser?.close() } finally { await scaffold.close() }
  }
})
