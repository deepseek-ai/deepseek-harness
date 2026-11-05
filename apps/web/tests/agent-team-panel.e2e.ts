// Keyless assembled-browser coverage for per-Session agent teamwork
// over the real Host projection frame flow.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-agent-team'
import { SessionId } from '@deepseek-ai/dsh-session'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
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
const RECEIPT_LOCALES = [
  {
    language: 'English', code: 'en', browserLocale: 'en-US', connect: connectFreshWorkspace,
    modelButton: /^Select model/u, toggle: 'Enable agent teamwork', title: 'Agent teamwork',
    enabled: 'Enabled', disabled: 'Disabled',
    suggestions: 'Trigger suggestions', commandLabel: 'Team',
    failure: 'Failed: Use /team on or /team off.',
  },
  {
    language: 'Chinese', code: 'zh', browserLocale: 'zh-CN', connect: connectFreshWorkspaceZh,
    modelButton: /^选择模型/u, toggle: '启用智能体团队协作', title: '智能体团队协作',
    enabled: '已开启', disabled: '已停用',
    suggestions: '触发候选建议', commandLabel: '智能体团队协作',
    failure: '执行失败：Use /team on or /team off.',
  },
] as const

type ReceiptLocale = typeof RECEIPT_LOCALES[number]

async function seedTeamConversation(page: Page, scaffold: WebScaffold): Promise<void> {
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
}

async function withTeamReceiptPage(
  locale: ReceiptLocale,
  run: (page: Page, scaffold: WebScaffold, tripwire: ReturnType<typeof watchConsole>) => Promise<void>,
): Promise<void> {
  const scaffold = await launchWebScaffold()
  let browser: Browser | undefined
  try {
    browser = await chromium.launch()
    const page = await browser.newPage({
      viewport: { width: 1680, height: 1000 }, locale: locale.browserLocale, timezoneId: 'Asia/Shanghai',
    })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await locale.connect(page, scaffold.workspaceCwd)
    try {
      await seedTeamConversation(page, scaffold)
      await run(page, scaffold, tripwire)
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    } catch (error) {
      await saveFailureShot(page, `web-e2e-team-command-${locale.code}`)
      throw error
    }
  } finally {
    try { await browser?.close() } finally { await scaffold.close() }
  }
}

describe('web e2e: agent teamwork panel', () => {
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
    await seedTeamConversation(page, scaffold)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('explains agent teamwork on hover and focus without changing the Session selection', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-team-info'))
    await page.getByRole('button', { name: /^Select model/u }).click()
    const info = page.getByRole('button', { name: 'About agent teamwork', exact: true })
    const toggle = page.getByRole('switch', { name: 'Enable agent teamwork', exact: true })
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
    const toggle = page.getByRole('switch', { name: 'Enable agent teamwork', exact: true })
    const info = page.getByRole('button', { name: 'About agent teamwork', exact: true })
    const label = page.getByText('Enable agent teamwork', { exact: true })
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
    const toggle = page.getByRole('switch', { name: 'Enable agent teamwork', exact: true })
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
    expect(scaffold.ctx.commands.list(agent).some(command => command.name === 'team')).toBe(false)
    expect(agent.session.ownEvents().filter(event => event.type === 'command/run' || event.type === 'command/done')).toEqual([])
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

  it('toggles from the model menu and keeps text editing usable after refocusing', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-team-command-input'))
    const input = page.locator('[data-composer-input]').first()
    const agent = scaffold.ctx.agents.list()[0]!
    for (const enabled of [false, true]) {
      await page.getByRole('button', { name: /^Select model/u }).click()
      const toggle = page.getByRole('switch', { name: 'Enable agent teamwork', exact: true })
      await toggle.click()
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe(String(enabled))
      await page.keyboard.press('Escape')
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
    const panel = page.locator('[data-subagent-panel]')
    expect(await panel.getByRole('treeitem').count()).toBe(0)
    await panel.getByText('No subagents', { exact: true }).waitFor()
    expect(await panel.locator('[data-subagent-section-header]').textContent()).toBe('Subagents')
    expect(await panel.locator('[data-subagent-section-header] button, h3 button').count()).toBe(0)
    expect(await panel.evaluate(element => element.getBoundingClientRect().width)).toBe(360)
    expect(await board.locator('[data-team-task-details]').count()).toBe(0)
    expect(await board.getByRole('button', { expanded: false }).count()).toBe(1)
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
    const countAction = page.locator('[data-subagent-action]')
    await countAction.waitFor()
    await page.mouse.move(2, 2)
    expect(await countAction.evaluate((element) => {
      const header = element.closest('[data-slot="conversation.session.header.actions"]')!.parentElement!
      const preset = header.querySelector('[data-icon="dsw-icon-agent-preset-outline-regular"]')!
      const users = element.querySelector('[data-icon="dsw-icon-users-outline-regular"]')!
      return {
        display: getComputedStyle(header).display, gap: getComputedStyle(header).gap,
        presetOpacity: getComputedStyle(preset).opacity,
        presetParentOpacity: getComputedStyle(preset.parentElement!).opacity,
        sameColor: getComputedStyle(preset).color === getComputedStyle(users).color,
      }
    })).toEqual({ display: 'flex', gap: '10px', presetOpacity: '1', presetParentOpacity: '1', sameColor: true })
    const countTrigger = countAction.getByRole('button', { name: /subagents?$/u })
    await countTrigger.click()
    await countTrigger.click()
    await page.locator('[data-subagent-panel]').waitFor({ state: 'detached' })
    expect(await countTrigger.evaluate(element => element === document.activeElement)).toBe(true)
    await countTrigger.click()
    const action = page.locator('[data-subagent-panel]')
    await action.getByRole('treeitem', { name: /Researcher/u }).waitFor()
    expect(await action.locator('[data-team-panel], [data-subagent-section-header]').count()).toBe(0)
    expect(await action.getByText('No shared tasks yet. Create them through the conversation.').count()).toBe(0)
    expect(await action.evaluate(element => element.getBoundingClientRect().width)).toBe(360)
    expect(await action.locator('[data-subagent-section-header] button, h3 button').count()).toBe(0)
    expect(await action.getByRole('heading', { name: 'Members', exact: true }).count()).toBe(0)
    expect(projectionReads).not.toHaveBeenCalled()

    expect(await action.getByRole('button', { name: 'New task' }).count()).toBe(0)
    expect(await action.getByRole('button', { name: /Refresh/u }).count()).toBe(0)

    await action.getByRole('treeitem', { name: /Researcher/u }).waitFor()
    expect(await page.locator('[data-subagent-panel]').count()).toBe(1)
    expect(await page.getByRole('button', { name: 'Task board', exact: true }).count()).toBe(0)
    const task = await scaffold.ctx.agentTeams.createTask(agent, {
      subject: 'Agent task', description: 'Created by the root agent', writeScopes: ['src/web'],
    })
    const row = action.locator(`[data-team-task="${task.id}"]`)
    await row.getByRole('button', { name: 'Pending Agent task', exact: true, expanded: false }).waitFor()
    expect(await action.locator('[data-subagent-section-header]').textContent()).toBe('Subagents1 external')
    expect(await action.locator('[data-subagent-section-header] button, h3 button').count()).toBe(0)
    expect(await action.locator('[data-team-panel]').evaluate((element) => {
      const style = getComputedStyle(element)
      return { border: style.borderTopWidth, margin: style.marginTop }
    })).toEqual({ border: '0px', margin: '4px' })
    expect(await action.evaluate((element) => {
      const tree = element.querySelector('[role="tree"]')!
      const board = element.querySelector('[data-team-panel]')!
      return Boolean(tree.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING)
    })).toBe(true)
    expect(await row.evaluate(element => ({ tag: element.tagName, parent: element.parentElement?.tagName })))
      .toEqual({ tag: 'LI', parent: 'UL' })
    expect(await action.locator('[data-team-task-details], article').count()).toBe(0)
    expect(await action.evaluate(element => element.getBoundingClientRect().width)).toBe(360)
    await action.getByRole('heading', { name: 'Shared tasks 1 pending', exact: true }).waitFor()
    expect(await action.evaluate(element => getComputedStyle(element).padding)).toBe('6px')
    expect(await action.locator('[data-subagent-section-header]').evaluate((element) => {
      const style = getComputedStyle(element)
      return { padding: style.padding, gap: style.gap }
    })).toEqual({ padding: '4px 7px 8px', gap: '7px' })
    expect(await action.locator('[data-team-panel]').getByRole('heading')
      .evaluate(element => getComputedStyle(element).columnGap)).toBe('7px')
    for (const [title, progress] of [
      [action.locator('[data-subagent-section-header]').getByRole('heading'), action.getByText('1 external', { exact: true })],
      [action.locator('[data-team-panel]').getByText('Shared tasks', { exact: true }), action.getByText('1 pending', { exact: true })],
    ] as const) {
      expect(await progress.evaluate(element => getComputedStyle(element).marginInlineStart)).toBe('4px')
      const titleRight = await title.evaluate(element => element.getBoundingClientRect().right)
      const progressLeft = await progress.evaluate(element => element.getBoundingClientRect().left)
      expect(Math.abs(progressLeft - titleRight - 11)).toBeLessThanOrEqual(1)
    }
    const member = action.getByRole('treeitem', { name: /Researcher/u })
    const memberTitle = member.getByText(RESEARCHER_DESCRIPTION, { exact: true })
    const taskTitle = row.getByText('Agent task', { exact: true })
    const titleLefts = await Promise.all([
      memberTitle,
      action.locator('[data-subagent-section-header]').getByRole('heading'),
      action.locator('[data-team-panel]').getByText('Shared tasks', { exact: true }),
      taskTitle,
    ].map(locator => locator.evaluate(element => element.getBoundingClientRect().left)))
    expect(Math.max(...titleLefts) - Math.min(...titleLefts)).toBeLessThanOrEqual(1)
    const primaryStyles = await Promise.all([memberTitle, taskTitle].map(locator => locator.evaluate((element) => {
      const style = getComputedStyle(element)
      return { fontSize: style.fontSize, color: style.color }
    })))
    expect(primaryStyles.map(style => style.fontSize)).toEqual(['13px', '13px'])
    expect(primaryStyles[1]).toEqual(primaryStyles[0])
    expect(await member.getByText('team-panel-researcher', { exact: true })
      .evaluate(element => getComputedStyle(element).fontSize)).toBe('12px')
    const memberHover = member.locator(':scope > div')
    for (const target of [member, memberHover]) {
      expect(await target.evaluate((element) => {
        const style = getComputedStyle(element)
        return [style.paddingTop, style.paddingBottom]
      })).toEqual(['4px', '4px'])
    }
    expect(await member.evaluate(element => getComputedStyle(element).minHeight)).toBe('40px')
    expect(await member.evaluate((element) => {
      const style = getComputedStyle(element)
      return { left: style.paddingLeft, right: style.paddingRight, gap: style.gap }
    })).toEqual({ left: '9px', right: '6px', gap: '7px' })
    expect(await memberHover.evaluate((element) => {
      const style = getComputedStyle(element)
      return { left: style.paddingLeft, right: style.paddingRight, gap: style.gap, margin: style.margin }
    })).toEqual({ left: '6px', right: '6px', gap: '7px', margin: '-4px -6px' })
    const taskHover = row.getByRole('button')
    expect(await taskHover.evaluate((element) => {
      const style = getComputedStyle(element)
      return [style.paddingTop, style.paddingBottom]
    })).toEqual(['7px', '7px'])
    expect(await taskHover.evaluate(element => element.getBoundingClientRect().height)).toBe(31)
    expect(await taskHover.evaluate((element) => {
      const style = getComputedStyle(element)
      return { left: style.paddingLeft, right: style.paddingRight, gap: style.gap, margin: style.margin }
    })).toEqual({ left: '6px', right: '6px', gap: '7px', margin: '0px -6px' })
    expect(await taskHover.evaluate(element => element.getBoundingClientRect().width
      - element.parentElement!.getBoundingClientRect().width)).toBe(12)
    const hoverStyles = []
    for (const target of [memberHover, taskHover]) {
      await target.hover()
      hoverStyles.push(await target.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return { left: bounds.left, right: bounds.right, radius: style.borderRadius, background: style.backgroundColor }
      }))
    }
    expect(Math.abs(hoverStyles[0]!.left - hoverStyles[1]!.left)).toBeLessThanOrEqual(1)
    expect(Math.abs(hoverStyles[0]!.right - hoverStyles[1]!.right)).toBeLessThanOrEqual(1)
    expect(hoverStyles[1]!.radius).toBe(hoverStyles[0]!.radius)
    expect(hoverStyles[1]!.background).toBe(hoverStyles[0]!.background)
    expect(hoverStyles[1]!.background).not.toBe('rgba(0, 0, 0, 0)')
    await row.getByRole('button').click()
    await row.locator('[data-team-task-owner]').filter({ hasText: 'Unowned' }).waitFor()
    await row.getByText('Created by the root agent', { exact: true }).waitFor()
    expect(await row.locator('[data-team-task-details]').evaluate((element) => {
      const style = getComputedStyle(element)
      return { fontSize: style.fontSize, indent: style.paddingLeft }
    })).toEqual({ fontSize: '12px', indent: '21px' })
    expect(await row.locator('[data-team-task-details] p, [data-team-task-owner]')
      .evaluateAll(elements => elements.every(element => getComputedStyle(element).fontSize === '12px'))).toBe(true)
    expect(await row.getByRole('button').getAttribute('aria-expanded')).toBe('true')
    expect(await action.evaluate(element => element.getBoundingClientRect().width)).toBe(360)
    await scaffold.ctx.agentTeams.updateTask(agent, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    await row.getByRole('img', { name: 'In progress', exact: true }).waitFor()
    await row.locator('[data-team-task-owner]').filter({ hasText: 'Owner: lead' }).waitFor()
    await action.getByRole('heading', { name: 'Shared tasks 1 in progress', exact: true }).waitFor()
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
    const toggle = page.getByRole('switch', { name: 'Enable agent teamwork', exact: true })
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false')
    expect(await page.locator('[data-subagent-action]').count()).toBe(1)
    await page.keyboard.press('Escape')
    await page.locator('[data-subagent-action]').getByRole('button', { name: '1 subagent', exact: true }).click()
    await page.getByRole('treeitem', { name: /Researcher/u }).waitFor()
    expect(await page.locator('[data-team-panel]').count()).toBe(0)
    expect(await page.locator('[data-subagent-panel]').evaluate(element => element.getBoundingClientRect().width)).toBe(360)
    expect(await page.locator('[data-subagent-section-header]').count()).toBe(0)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /^Select model/u }).click()
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
    await page.keyboard.press('Escape')
    await page.locator('[data-subagent-action]').getByRole('button', { name: /subagents?$/u }).click()
    await page.locator('[data-subagent-panel]').getByText('Agent task', { exact: true }).waitFor()
    await page.keyboard.press('Escape')
  })

  it('keeps the narrow Users trigger focused and opens its catalog only on explicit activation', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-team-narrow-trigger'))
    const trigger = page.locator('[data-subagent-action]').getByRole('button', { name: '1 subagent', exact: true })
    const panel = page.locator('[data-subagent-panel]')
    const count = trigger.locator('[data-subagent-count]')
    const viewport = page.viewportSize()!
    expect(await count.isVisible()).toBe(true)
    expect(await trigger.locator('[data-icon="dsw-icon-users-outline-regular"]').count()).toBe(1)
    expect(await trigger.locator('[data-icon="dsw-icon-users-outline-regular"]').evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return { width: bounds.width, height: bounds.height }
    })).toEqual({ width: 14, height: 14 })
    expect(await trigger.locator('[data-icon="dsw-icon-chevron-down-outline-regular"]').count()).toBe(0)
    expect(await trigger.locator('svg').count()).toBe(1)
    await trigger.focus()
    const original = await trigger.elementHandle()
    if (original === null) throw new Error('Subagent trigger is missing')
    try {
      await page.setViewportSize({ width: 390, height: 700 })
      await expect.poll(() => count.evaluate(element => getComputedStyle(element).display)).toBe('none')
      expect(await original.evaluate(element => element.isConnected && element === document.activeElement)).toBe(true)
      const expandSidebar = page.locator('[data-sidebar-right-expand]')
      const compactStyles = await Promise.all([trigger, expandSidebar].map(control => control.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        const icon = element.querySelector('svg')!.getBoundingClientRect()
        const style = getComputedStyle(element)
        return { width: bounds.width, height: bounds.height, padding: style.padding, radius: style.borderRadius,
          color: style.color, iconWidth: icon.width, iconHeight: icon.height }
      })))
      expect(compactStyles[0]).toEqual(compactStyles[1])
      expect(compactStyles[0]).toMatchObject({ width: 28, height: 28, padding: '0px', iconWidth: 15, iconHeight: 15 })
      expect(await trigger.evaluate(element => getComputedStyle(element.closest('[data-slot="conversation.session.header.actions"]')!.parentElement!).gap)).toBe('8px')
      await expandSidebar.hover()
      const expandHover = await expandSidebar.evaluate((element) => {
        const style = getComputedStyle(element)
        return { background: style.backgroundColor, color: style.color }
      })
      await page.mouse.move(1, 1)
      await page.keyboard.press('Tab')
      const countTooltip = page.getByRole('tooltip', { name: '1 subagent', exact: true })
      await countTooltip.waitFor({ state: 'hidden' })
      await trigger.hover()
      expect(await trigger.evaluate((element) => {
        const style = getComputedStyle(element)
        return { background: style.backgroundColor, color: style.color }
      })).toEqual(expandHover)
      expect(expandHover.background).not.toBe('rgba(0, 0, 0, 0)')
      // Observe beyond the wide trigger's 150ms hover-open deadline.
      await page.waitForTimeout(200)
      expect(await panel.count()).toBe(0)
      await countTooltip.waitFor({ state: 'visible' })
      expect(await panel.count()).toBe(0)
      await trigger.click()
      await panel.waitFor()
      expect(await trigger.getAttribute('aria-expanded')).toBe('true')
      expect(await page.getByRole('tooltip', { name: '1 subagent', exact: true }).count()).toBe(0)
      await panel.getByRole('treeitem', { name: /Researcher/u }).waitFor()
      await panel.locator('[data-team-task]').getByRole('button', { expanded: false }).waitFor()
      await trigger.click()
      await panel.waitFor({ state: 'detached' })
      expect(await trigger.getAttribute('aria-expanded')).toBe('false')
      await trigger.press('ArrowDown')
      await panel.waitFor()
      await page.mouse.move(1, 1)
      // Keyboard activation stays pinned beyond the 120ms pointer-leave grace.
      await page.waitForTimeout(180)
      expect(await panel.count()).toBe(1)
      await page.keyboard.press('Escape')
      await panel.waitFor({ state: 'detached' })
    } finally {
      await page.keyboard.press('Escape')
      await page.setViewportSize(viewport)
      await original.dispose()
    }
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
      const secondary = row.getByText('team-panel-researcher', { exact: true })
      expect(await row.getByRole('button').count()).toBe(0)
      expect(await primary.evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          tag: element.tagName, clipped: element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight,
          whiteSpace: style.whiteSpace, overflowWrap: style.overflowWrap,
        }
      })).toEqual({ tag: 'SPAN', clipped: false, whiteSpace: 'normal', overflowWrap: 'anywhere' })
      const primaryBounds = await primary.boundingBox()
      const secondaryBounds = await secondary.boundingBox()
      expect(primaryBounds).not.toBeNull()
      expect(secondaryBounds).not.toBeNull()
      expect(primaryBounds!.y + primaryBounds!.height).toBeLessThanOrEqual(secondaryBounds!.y)
      const beforeClick = page.url()
      await primary.click()
      expect(page.url()).toBe(beforeClick)
      expect(await page.getByRole('tooltip', { name: RESEARCHER_DESCRIPTION, exact: true }).count()).toBe(0)
      expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
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
    onTestFailed(async () => {
      await saveFailureShot(page, 'web-e2e-agent-team-hover')
      console.error('Agent Team hover diagnostics', JSON.stringify({ errors: tripwire.pageErrors, warnings: tripwire.warnings }))
    })
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

  it('keeps compact tasks ordered, opens one full detail at a time, and scrolls only the fixed-width menu', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-team-compact-details'))
    const agent = scaffold.ctx.agents.list()[0]!
    const completed = await scaffold.ctx.agentTeams.createTask(agent, {
      subject: 'Completed preparation', description: 'Preparation is complete.', writeScopes: [],
    })
    const claimed = await scaffold.ctx.agentTeams.updateTask(agent, {
      taskId: completed.id, expectedRevision: completed.revision, action: 'claim',
    })
    await scaffold.ctx.agentTeams.updateTask(agent, {
      taskId: completed.id, expectedRevision: claimed.revision, action: 'complete',
    })
    const blocker = await scaffold.ctx.agentTeams.createTask(agent, {
      subject: 'Dependency task', description: 'Finish this prerequisite first.', writeScopes: [],
    })
    const subject = 'Responsive task with a long title that remains fully readable when expanded at the minimum supported viewport'
    const description = 'Check every dependency and write scope before you start work.\n'.repeat(16).trim()
    const task = await scaffold.ctx.agentTeams.createTask(agent, {
      subject, description, blockedBy: [blocker.id], writeScopes: ['src/web/components'],
    })
    const viewport = page.viewportSize()!
    const trigger = page.locator('[data-subagent-action]').getByRole('button', { name: /subagents?$/u })
    const panel = page.locator('[data-subagent-panel]')
    const board = panel.locator('[data-team-panel]')
    const row = board.locator(`[data-team-task="${task.id}"]`)
    const emptyRow = board.locator(`[data-team-task="${completed.id}"]`)
    onTestFinished(() => page.setViewportSize(viewport))
    // Constrain the menu so closed and expanded task rows both exercise its scrollbar.
    await page.setViewportSize({ width: viewport.width, height: 540 })
    await trigger.click()
    await row.waitFor()
    expect(await panel.evaluate(element => element.getBoundingClientRect().width)).toBe(360)
    expect(await board.locator('[data-team-task-details], article').count()).toBe(0)
    expect(await board.getByRole('button', { expanded: false }).count()).toBe(4)
    expect(await board.locator('[data-team-task]').evaluateAll(elements => elements.map(element => element.getAttribute('data-status'))))
      .toEqual(['in_progress', 'completed', 'pending', 'pending'])
    const counts = board.getByText('1 completed\u2002·\u20021 in progress\u2002·\u20022 pending', { exact: true })
    await counts.waitFor()
    expect(await counts.textContent()).toBe('1 completed\u2002·\u20021 in progress\u2002·\u20022 pending')
    expect(await panel.locator('[data-subagent-section-header] button, h3 button').count()).toBe(0)
    expect(await panel.getByRole('button', { name: /^Show (more|less)$/u }).count()).toBe(0)
    await row.getByRole('img', { name: 'Blocked by dependencies', exact: true }).waitFor()
    const measureScroll = async () => panel.evaluate((element) => {
      const style = getComputedStyle(element)
      const bounds = element.getBoundingClientRect()
      const scroller = element.querySelector('[role="tree"]')!.parentElement!
      const scrollStyle = getComputedStyle(scroller)
      const scrollBounds = scroller.getBoundingClientRect()
      const taskBounds = element.querySelector('[data-team-task] button')!.getBoundingClientRect()
      const scrollbarWidth = Number.parseFloat(getComputedStyle(scroller, '::-webkit-scrollbar').width)
      return {
        innerWidth: bounds.width - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
          - Number.parseFloat(style.borderLeftWidth) - Number.parseFloat(style.borderRightWidth),
        clientWidth: scroller.clientWidth, clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight,
        overflowing: scroller.scrollHeight > scroller.clientHeight,
        gutter: scrollStyle.scrollbarGutter, marginRight: scrollStyle.marginRight,
        trackMargin: scrollStyle.getPropertyValue('--dsh-scrollbar-track-margin').trim(),
        taskLeft: taskBounds.left, taskRight: taskBounds.right,
        trackLeft: scrollBounds.right - scrollbarWidth, trackRight: scrollBounds.right, panelRight: bounds.right,
        arrowsBeforeTrack: [...element.querySelectorAll('[data-team-task] button svg')]
          .every(arrow => arrow.getBoundingClientRect().right <= scrollBounds.right - scrollbarWidth),
      }
    })
    const closedScroll = await measureScroll()
    expect(closedScroll.overflowing, JSON.stringify(closedScroll)).toBe(true)
    expect(Math.abs(closedScroll.clientWidth - closedScroll.innerWidth), JSON.stringify(closedScroll)).toBeLessThanOrEqual(1)
    expect(closedScroll.gutter).toBe('stable')
    expect(closedScroll.marginRight).toBe('-5px')
    expect(closedScroll.trackMargin).toBe('6px')
    await row.getByRole('button').click()
    const expandedScroll = await measureScroll()
    expect(expandedScroll.overflowing).toBe(true)
    expect(expandedScroll.clientWidth).toBe(closedScroll.clientWidth)
    expect(expandedScroll.taskLeft).toBe(closedScroll.taskLeft)
    expect(expandedScroll.taskRight).toBe(closedScroll.taskRight)
    expect(expandedScroll.arrowsBeforeTrack).toBe(true)
    expect(expandedScroll.trackLeft).toBeGreaterThanOrEqual(expandedScroll.panelRight - 6)
    expect(expandedScroll.trackRight).toBeLessThanOrEqual(expandedScroll.panelRight - 1)
    expect(await panel.evaluate(element => element.getBoundingClientRect().width)).toBe(360)
    const details = row.locator('[data-team-task-details]')
    expect(await details.locator('p:not([data-team-task-owner])').textContent()).toBe(description)
    expect(await details.locator('[data-team-task-owner]').textContent()).toBe('Owner: Unowned')
    expect(await details.locator(':scope > *').evaluateAll(elements => elements.map(element =>
      element.hasAttribute('data-team-task-owner') ? 'owner' : element.tagName))).toEqual(['P', 'owner'])
    expect(await details.locator('dl, dt, dd').count()).toBe(0)
    for (const omitted of [task.id, blocker.subject, 'Readiness', 'Write scopes', 'Write scope warnings', 'src/web/components']) {
      expect(await details.textContent()).not.toContain(omitted)
    }
    expect(await row.getByRole('button').getAttribute('aria-controls')).toBe(await details.getAttribute('id'))
    try {
      await page.setViewportSize({ width: 390, height: 700 })
      await expect.poll(() => panel.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return rect.width === Math.min(360, innerWidth - 32) && rect.left >= 16 && rect.right <= innerWidth - 16
          && rect.top >= 16 && rect.bottom <= innerHeight - 16
          && element.scrollWidth <= element.clientWidth
      })).toBe(true)
      expect(await panel.locator('*').evaluateAll((elements) => {
        const scrollers = elements.filter(element =>
          ['auto', 'scroll'].includes(getComputedStyle(element).overflowY)
          && element.scrollHeight > element.clientHeight)
        return scrollers.map(element => ({
          hasHeader: element.querySelector('[data-subagent-section-header]') !== null,
          hasTree: element.querySelector('[role="tree"]') !== null,
          hasBoard: element.querySelector('[data-team-panel]') !== null,
          fitsWidth: element.scrollWidth <= element.clientWidth,
        }))
      })).toEqual([{ hasHeader: true, hasTree: true, hasBoard: true, fitsWidth: true }])
      const narrowScroll = await measureScroll()
      expect(Math.abs(narrowScroll.clientWidth - narrowScroll.innerWidth), JSON.stringify(narrowScroll)).toBeLessThanOrEqual(1)
      expect(narrowScroll.arrowsBeforeTrack).toBe(true)
      const scroller = panel.getByRole('tree').locator('..')
      await scroller.hover({ position: { x: 20, y: 20 } })
      await Promise.all([
        scroller.evaluate(element => new Promise<void>((resolve) => {
          element.addEventListener('scrollend', () => { resolve() }, { once: true })
        })),
        page.mouse.wheel(0, 180),
      ])
      await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
      await scroller.evaluate((element) => { element.scrollTo({ top: 0 }) })
      await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(0)
      expect(await row.getByText(subject, { exact: true }).evaluate(element =>
        element.scrollWidth <= element.clientWidth && getComputedStyle(element).whiteSpace === 'pre-wrap')).toBe(true)
      expect(await details.locator('p:not([data-team-task-owner])').evaluate(element => element.scrollHeight === element.clientHeight)).toBe(true)
      const ownerBounds = await details.locator('[data-team-task-owner]').boundingBox()
      const descriptionBounds = await details.locator('p:not([data-team-task-owner])').boundingBox()
      expect(ownerBounds).not.toBeNull()
      expect(descriptionBounds).not.toBeNull()
      expect(ownerBounds!.height).toBeLessThanOrEqual(18)
      expect(ownerBounds!.y).toBeGreaterThanOrEqual(descriptionBounds!.y + descriptionBounds!.height)
      const detailColor = await details.evaluate(element => getComputedStyle(element).color)
      expect(await details.locator('[data-team-task-owner], [data-team-task-owner] span')
        .evaluateAll(elements => elements.map(element => getComputedStyle(element).color)))
        .toEqual([detailColor, detailColor, detailColor])
      expect(await counts.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      const titleBounds = await board.getByText('Shared tasks', { exact: true }).boundingBox()
      const countBounds = await counts.boundingBox()
      expect(titleBounds).not.toBeNull()
      expect(countBounds).not.toBeNull()
      expect(countBounds!.y).toBeGreaterThanOrEqual(titleBounds!.y + titleBounds!.height)
      await compareOrRefreshGolden(RESIZE_EXPECTED, await captureStableAria(page, '[data-subagent-panel]', scaffold.workspaceCwd), MODE)
      await emptyRow.getByRole('button').click()
      expect(await row.getAttribute('data-expanded')).toBe('false')
      expect(await row.locator('[data-team-task-details]').count()).toBe(0)
      expect(await board.locator('[data-team-task-details]').count()).toBe(1)
      expect(await emptyRow.locator('[data-team-task-owner]').textContent()).toBe('Owner: lead')
      expect(await emptyRow.locator('[data-team-task-details] p:not([data-team-task-owner])').textContent()).toBe(completed.description)
      expect(await emptyRow.locator('dl, dt, dd').count()).toBe(0)
      expect(await emptyRow.locator('[data-team-task-details]').textContent()).not.toContain(completed.id)
      await emptyRow.getByRole('button').click()
      expect(await board.locator('[data-team-task-details]').count()).toBe(0)
      await page.setViewportSize(viewport)
      expect(await panel.evaluate(element => element.getBoundingClientRect().width)).toBe(360)
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
      await page.getByRole('switch', { name: 'Enable agent teamwork', exact: true }).click()
      await page.getByRole('dialog', { name: 'Disable agent teamwork?', exact: true }).waitFor()
    }
    await openConfirmation()
    const dialog = page.getByRole('dialog', { name: 'Disable agent teamwork?', exact: true })
    await assertWarningDialogLayout(dialog)
    expect(await page.getByRole('menu', { name: 'Model and reasoning effort', exact: true }).count()).toBe(0)
    expect(await dialog.getByRole('checkbox').count()).toBe(0)
    expect(scaffold.ctx.agentTeams.isEnabled(agent)).toBe(true)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'disable-confirmation.expected.md'),
      await captureStableAria(page, '[aria-modal="true"]', scaffold.workspaceCwd), MODE)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await expect.poll(() => page.getByRole('button', { name: /^Select model/u }).evaluate(element => element === document.activeElement)).toBe(true)
    expect(scaffold.ctx.agentTeams.isEnabled(agent)).toBe(true)
    await openConfirmation()
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await expect.poll(() => page.getByRole('button', { name: /^Select model/u }).evaluate(element => element === document.activeElement)).toBe(true)
    expect(scaffold.ctx.agentTeams.isEnabled(agent)).toBe(true)
    await openConfirmation()
    await dialog.getByRole('button', { name: 'Disable', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await expect.poll(() => page.getByRole('button', { name: /^Select model/u }).evaluate(element => element === document.activeElement)).toBe(true)
    await expect.poll(() => scaffold.ctx.agentTeams.isEnabled(agent)).toBe(false)
    await page.getByRole('button', { name: /^Select model/u }).click()
    await page.getByRole('switch', { name: 'Enable agent teamwork', exact: true }).click()
    await expect.poll(() => scaffold.ctx.agentTeams.isEnabled(agent)).toBe(true)
    expect(await dialog.count()).toBe(0)
    await page.keyboard.press('Escape')
    expect(agent.session.ownEvents().filter(event => event.type === 'command/run' || event.type === 'command/done')).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  })

  it('removes both section headings and the board divider when the last shared task is deleted', async () => {
    const agent = scaffold.ctx.agents.list()[0]!
    await page.getByRole('button', { name: '1 subagent', exact: true }).click()
    const panel = page.locator('[data-subagent-panel]')
    await panel.locator('[data-team-panel]').waitFor()
    for (const task of scaffold.ctx.agentTeams.listTasks(agent).toReversed()) {
      if (task.status === 'deleted') continue
      await scaffold.ctx.agentTeams.updateTask(agent, {
        taskId: task.id, expectedRevision: task.revision, action: 'delete',
      })
    }
    await panel.locator('[data-team-panel]').waitFor({ state: 'detached' })
    expect(await panel.locator('[data-subagent-section-header]').count()).toBe(0)
    expect(await panel.getByRole('heading').count()).toBe(0)
    expect(await panel.getByText('No shared tasks yet. Create them through the conversation.').count()).toBe(0)
    expect(await panel.getByRole('treeitem', { name: /Researcher/u }).count()).toBe(1)
    expect(await panel.evaluate(element => element.getBoundingClientRect().width)).toBe(360)
    await page.keyboard.press('Escape')
  })

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'task.expected.md', 'resize.expected.md', 'info.expected.md', 'task-only.expected.md',
      'disable-confirmation.expected.md', 'collaboration.zh.expected.md',
      'command-error.en.expected.md', 'command-error.zh.expected.md',
    ])
  })
})

it.each(RECEIPT_LOCALES)('toggles teamwork in $language without command records or Chat changes after reload', async (locale) => {
  await withTeamReceiptPage(locale, async (page, scaffold, tripwire) => {
    const agent = scaffold.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('Team receipt fixture has no Agent')
    const chat = page.locator('[data-chat-flow]').first()
    const recordedReady = await captureStableAria(page, '[data-chat-flow]', scaffold.workspaceCwd)
    expect(recordedReady).toContain('Ready.')
    expect(recordedReady).toContain('Open the task board.')
    const captureLayout = () => chat.evaluate((element) => {
      const flow = element.getBoundingClientRect()
      return {
        height: flow.height,
        rows: [...element.querySelectorAll('[data-chat-flow-key]')].map((row) => {
          const bounds = row.getBoundingClientRect()
          return { kind: row.getAttribute('data-chat-flow-kind'), top: bounds.top - flow.top, height: bounds.height }
        }),
      }
    })
    const recordedLayout = await captureLayout()
    const commandEvents = () => agent.session.snapshotEvents()
      .filter(event => event.type === 'command/run' || event.type === 'command/done')
    expect(commandEvents()).toEqual([])
    const input = page.locator('[data-composer-input]').first()
    await writeComposerDraft(page, input, '/')
    const suggestions = page.getByRole('listbox', { name: locale.suggestions, exact: true })
    await suggestions.getByRole('option').first().waitFor()
    const candidate = suggestions.getByRole('option').filter({ hasText: locale.commandLabel })
    expect(await candidate.count()).toBe(0)
    await writeComposerDraft(page, input, '/tea')
    await expect.poll(() => suggestions.getByRole('option').count()).toBe(0)
    expect(await candidate.count()).toBe(0)
    await input.press('Escape')
    await suggestions.waitFor({ state: 'hidden' })
    await writeComposerDraft(page, input, '')
    expect(commandEvents()).toEqual([])
    expect(scaffold.ctx.agentTeams.isEnabled(agent)).toBe(false)
    const assertChatUnchanged = async (): Promise<void> => {
      await chat.getByText('Ready.', { exact: true }).waitFor()
      expect(await page.locator('[data-team-command], [data-chat-flow-kind="command"], [data-command-input]').count()).toBe(0)
      expect(await captureStableAria(page, '[data-chat-flow]', scaffold.workspaceCwd)).toBe(recordedReady)
      await expect.poll(captureLayout).toEqual(recordedLayout)
    }
    for (const enabled of [true, false]) {
      await page.getByRole('button', { name: locale.modelButton }).click()
      const toggle = page.getByRole('switch', { name: locale.toggle, exact: true })
      await toggle.click()
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe(String(enabled))
      await expect.poll(() => scaffold.ctx.agentTeams.isEnabled(agent)).toBe(enabled)
      expect(scaffold.ctx.commands.list(agent).some(command => command.name === 'team')).toBe(false)
      expect(commandEvents()).toEqual([])
      await page.keyboard.press('Escape')
      await assertChatUnchanged()
    }
    await scaffold.ctx.sessions.flush(agent.session)
    const recordedCommands = commandEvents()
    expect(recordedCommands).toEqual([])
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await assertChatUnchanged()
    expect(commandEvents()).toEqual(recordedCommands)
    expect(scaffold.ctx.agentTeams.isEnabled(agent)).toBe(false)
    acknowledgeReloadConnectionLoss(tripwire, warningStart)

    // Historical receipts are read-only fixtures, not invocations of a registered command.
    for (const args of [' on', ' off']) {
      const commandId = CommandId(`historical-team-${args.trim()}`)
      agent.session.append('command/run', { commandId, name: 'team', args, source: { kind: 'user' } })
      agent.session.append('command/done', { commandId, kind: 'success', text: 'Team mode saved.' })
    }
    agent.session.append('command/run', {
      commandId: CommandId('historical-team-pending'), name: 'team', args: ' on', source: { kind: 'user' },
    })
    await scaffold.ctx.sessions.flush(agent.session)
    const historicalCommands = commandEvents()
    expect(historicalCommands.map(event => event.type)).toEqual([
      'command/run', 'command/done', 'command/run', 'command/done', 'command/run',
    ])
    const historicalWarningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await assertChatUnchanged()
    expect(commandEvents()).toEqual(historicalCommands)
    expect(scaffold.ctx.agentTeams.isEnabled(agent)).toBe(false)
    acknowledgeReloadConnectionLoss(tripwire, historicalWarningStart)
  })
})

it.each(RECEIPT_LOCALES)('renders historical Team failures in $language without a success receipt after reload', async (locale) => {
  await withTeamReceiptPage(locale, async (page, scaffold, tripwire) => {
    const agent = scaffold.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('Team failure fixture has no Agent')
    const commandId = CommandId('historical-team-error')
    agent.session.append('command/run', { commandId, name: 'team', args: ' invalid', source: { kind: 'user' } })
    agent.session.append('command/done', { commandId, kind: 'error', text: 'Use /team on or /team off.' })
    await scaffold.ctx.sessions.flush(agent.session)
    const row = page.locator('[data-team-command]')
    const captureFailure = async (): Promise<string> => {
      await row.getByText(locale.failure, { exact: true }).waitFor()
      expect(await row.count()).toBe(1)
      expect(await row.getAttribute('data-state')).toBe('error')
      expect(await row.getByText(locale.title, { exact: true }).count()).toBe(1)
      expect(await row.getByText(locale.enabled, { exact: true }).count()).toBe(0)
      expect(await row.getByText(locale.disabled, { exact: true }).count()).toBe(0)
      expect(scaffold.ctx.agentTeams.isEnabled(agent)).toBe(false)
      const collapsed = await captureStableAria(page, '[data-team-command]', scaffold.workspaceCwd)
      const disclosure = row.getByRole('button', { expanded: false })
      await disclosure.click()
      await row.getByRole('button', { expanded: true }).waitFor()
      await row.getByText('Use /team on or /team off.', { exact: true }).waitFor()
      const expanded = await captureStableAria(page, '[data-team-command]', scaffold.workspaceCwd)
      return `## Failed receipt\n\n${collapsed}\n\n## Raw error\n\n${expanded}`
    }
    const failure = await captureFailure()
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, `command-error.${locale.code}.expected.md`), failure, MODE)
    await scaffold.ctx.sessions.flush(agent.session)
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    expect(await captureFailure()).toBe(failure)
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
  })
})

it('shows the Chinese empty subagent section above compact shared tasks', async () => {
  await withTeamReceiptPage(RECEIPT_LOCALES[1], async (page, scaffold) => {
    const agent = scaffold.ctx.agents.list()[0]!
    await scaffold.ctx.agentTeams.setEnabled(agent, true)
    await scaffold.ctx.agentTeams.createTask(agent, {
      subject: '准备协作', description: '先准备共享任务，再创建子智能体。',
    })
    await page.getByRole('button', { name: '0 个子智能体', exact: true }).click()
    const panel = page.locator('[data-subagent-panel]')
    await panel.getByText('暂无子智能体', { exact: true }).waitFor()
    expect(await panel.locator('[data-subagent-section-header]').textContent()).toBe('子智能体')
    expect(await panel.locator('[data-subagent-section-header] button, h3 button').count()).toBe(0)
    expect(await panel.evaluate(element => element.getBoundingClientRect().width)).toBe(360)
    await panel.getByRole('heading', { name: '共享任务 1 待处理', exact: true }).waitFor()
    expect(await panel.locator('[data-team-task-details]').count()).toBe(0)
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
    await dialog.getByText('对话过程中停用智能体团队协作，将停止共享任务工具和团队协调指令。', { exact: true }).waitFor()
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
