// Keyless assembled-browser coverage for per-Session agent teamwork
// over the real Host projection frame flow.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-agent-team'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CommandId } from '@deepseek-ai/dsh-commands/types'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { abbreviateHomePath } from '@deepseek-ai/dsh-util-workspace-path'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import {
  assertWarningDialogLayout, connectFreshWorkspace, connectFreshWorkspaceZh, dismissSessionPanel, foldControlLayout, newEnglishPage,
  saveFailureShot, sessionPanelToggle, showSessionPanel, writeComposerDraft,
} from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/agent-team-panel', import.meta.url))
const PANEL_EXPECTED = join(SNAPSHOT_DIR, 'task.expected.md')
const RESIZE_EXPECTED = join(SNAPSHOT_DIR, 'resize.expected.md')
const MODE = webSnapshotMode()
const SUBAGENTS_SECTION = '[data-session-panel-section="subagents"]'
const SHARED_TASKS_SECTION = '[data-session-panel-section="shared-tasks"]'
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
    modelButton: /^选择模型/u, toggle: '开启智能体团队协作', title: '智能体团队协作',
    enabled: '已开启', disabled: '已停用',
    suggestions: '触发候选建议', commandLabel: '智能体团队协作',
    failure: '执行失败：Use /team on or /team off.',
  },
] as const

type ReceiptLocale = typeof RECEIPT_LOCALES[number]

/**
 * Show the Session panel and return its Subagents section once the panel's
 * entrance animation has ended, so geometry reads see its resting position.
 * @param page - the page under test.
 * @returns the section, hidden while it has nothing to show.
 */
async function showSubagentsSection(page: Page): Promise<Locator> {
  return (await showSessionPanel(page)).locator(SUBAGENTS_SECTION)
}

/**
 * Show the Session panel and return its Shared tasks section once the panel's
 * entrance animation has ended.
 * @param page - the page under test.
 * @returns the section, hidden while it has nothing to show.
 */
async function showSharedTasksSection(page: Page): Promise<Locator> {
  return (await showSessionPanel(page)).locator(SHARED_TASKS_SECTION)
}

/**
 * Wait until the Session panel's dock probe has reported the room of the window's current size, for a width
 * that does not use the sidebar drawer. A resize reaches the layout over several frames: the app frame takes
 * its sidebar mode from a measurement a frame later, and the Conversation body publishes its widths from size
 * observers. Until they all follow the window the probe can report room that the settled layout does not have,
 * and a toggle press then flips the docking preference instead of opening the panel over the conversation.
 * The wait ends one frame after the first frame whose inputs all follow the window: that frame lays the probe
 * out at its final width, and its size observers, the panel's own among them, report that width before the
 * next frame's callbacks run.
 * @param page - the page under test.
 */
async function settleDockProbe(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    const settled = (): boolean => {
      const body = document.querySelector('[data-session-panel-probe]')?.closest<HTMLElement>('[data-conversation-content]')
      const scroll = body?.querySelector<HTMLElement>('[data-conversation-scroll]')
      if (body === undefined || body === null || scroll === undefined || scroll === null) return false
      return document.querySelector('[data-sidebar-drawer]') === null
        && body.style.getPropertyValue('--dsh-conversation-column-width') === `${Math.round(body.getBoundingClientRect().width)}px`
        && body.style.getPropertyValue('--dsh-conversation-viewport-width') === `${scroll.clientWidth}px`
    }
    const frame = (): void => {
      requestAnimationFrame(settled() ? () => { resolve() } : frame)
    }
    requestAnimationFrame(frame)
  }))
}

async function openTeamSettings(page: Page, chinese = false): Promise<void> {
  const trigger = page.getByRole('button', { name: chinese ? /^选择模型/u : /^Select model/u })
  await trigger.click()
  await expect.poll(() => trigger.getAttribute('aria-expanded')).toBe('true')
  await page.getByRole('menuitem', { name: chinese ? /^智能体团队协作 /u : /^Agent teamwork /u }).click()
}

async function closeModelMenu(page: Page): Promise<void> {
  const trigger = page.getByRole('button', { name: /^(Select model|选择模型)/u })
  if (await trigger.getAttribute('aria-expanded') === 'true') await trigger.click()
  await expect.poll(() => trigger.getAttribute('aria-expanded')).toBe('false')
}

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

  it('shows the explanation and switch only on the detail pane and returns to the summary', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-team-info'))
    const trigger = page.getByRole('button', { name: /^Select model/u })
    await trigger.click()
    const menu = page.locator('[data-model-menu]')
    const summary = menu.getByRole('menuitem', { name: 'Agent teamwork Off', exact: true })
    await summary.waitFor()
    const stateColor = await summary.getByText('Off', { exact: true }).evaluate(element => getComputedStyle(element).color)
    const modelColor = await menu.getByRole('menuitem', { name: 'Model DeepSeek-V4-Flash', exact: true })
      .getByText('DeepSeek-V4-Flash', { exact: true }).evaluate(element => getComputedStyle(element).color)
    expect(stateColor).toBe(modelColor)
    const inspectArrow = (element: HTMLElement | SVGElement) => {
      const { left, right, width, height } = element.getBoundingClientRect()
      return { left, right, width, height, color: getComputedStyle(element).color, glyph: element.innerHTML }
    }
    const peerArrow = menu.getByRole('menuitem', { name: 'Model DeepSeek-V4-Flash', exact: true }).locator('svg').last()
    expect(await summary.locator('svg').evaluate(inspectArrow)).toEqual(await peerArrow.evaluate(inspectArrow))
    expect(await menu.getByRole('switch').count()).toBe(0)
    expect(await page.getByRole('button', { name: 'About agent teamwork', exact: true }).count()).toBe(0)
    const rootSnapshot = await captureStableAria(page, '[data-model-menu]', scaffold.workspaceCwd)
    const original = await menu.elementHandle()
    if (original === null) throw new Error('Model menu is missing')
    try {
      await summary.click()
      const toggle = menu.getByRole('switch', { name: 'Enable agent teamwork', exact: true })
      await toggle.waitFor()
      expect(await original.evaluate(element => element.isConnected)).toBe(true)
      await menu.getByText('Coordinate work and progress across agents with a shared task board for better results on complex tasks, with correspondingly higher token costs.', { exact: true }).waitFor()
      expect(await page.getByRole('tooltip').count()).toBe(0)
      expect(await toggle.getAttribute('aria-checked')).toBe('false')
      await page.mouse.move(0, 0)
      await toggle.press('ArrowDown')
      expect(await toggle.evaluate(element => ({
        rowBackground: getComputedStyle(element.parentElement!).backgroundColor,
        focusVisible: element.matches(':focus-visible'),
        outline: getComputedStyle(element).outlineStyle,
        descriptionGap: element.parentElement!.nextElementSibling!.getBoundingClientRect().top
          - element.parentElement!.getBoundingClientRect().bottom,
      }))).toEqual({ rowBackground: 'rgba(0, 0, 0, 0)', focusVisible: true, outline: 'solid', descriptionGap: 0 })
      const settingsSnapshot = await captureStableAria(page, '[data-model-menu]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'info.expected.md'),
        `## Root\n\n${rootSnapshot}\n\n## Team settings\n\n${settingsSnapshot}`, MODE)
      await page.keyboard.press('Escape')
      await expect.poll(() => summary.evaluate(element => element === document.activeElement)).toBe(true)
      expect(await menu.getByRole('switch').count()).toBe(0)
      await summary.press('Enter')
      await toggle.waitFor()
      await page.keyboard.press('Escape')
      await summary.waitFor()
      expect(await summary.evaluate(element => element === document.activeElement)).toBe(true)
      expect(scaffold.ctx.agentTeams.isEnabled(scaffold.ctx.agents.list()[0]!)).toBe(false)
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'hidden' })
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      await closeModelMenu(page)
      await original.dispose()
    }
  })

  it('aligns settings with the root menu and keeps explanatory text noninteractive in wide and narrow viewports', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-team-settings-page'))
    const viewport = page.viewportSize()!
    try {
      await openTeamSettings(page)
      const menu = page.locator('[data-model-menu]')
      const toggle = menu.getByRole('switch', { name: 'Enable agent teamwork', exact: true })
      const description = menu.getByText('Coordinate work and progress across agents with a shared task board for better results on complex tasks, with correspondingly higher token costs.', { exact: true })
      await description.click()
      expect(await menu.isVisible()).toBe(true)
      expect(await toggle.getAttribute('aria-checked')).toBe('false')
      for (const size of [viewport, { width: 390, height: 700 }]) {
        await page.setViewportSize(size)
        await page.keyboard.press('Escape')
        const summary = menu.getByRole('menuitem', { name: 'Agent teamwork Off', exact: true })
        await summary.waitFor()
        const rootBounds = await menu.evaluate((element) => {
          const { width, left, right } = element.getBoundingClientRect()
          return { width, left, right }
        })
        expect(rootBounds.width).toBe(240)
        await summary.click()
        await toggle.waitFor()
        await expect.poll(() => menu.evaluate((element) => {
          const { width, left, right } = element.getBoundingClientRect()
          return { width, left, right }
        })).toEqual(rootBounds)
        await expect.poll(() => menu.evaluate((element) => {
          const bounds = element.getBoundingClientRect()
          return bounds.left >= 12 && bounds.right <= innerWidth - 12
            && bounds.top >= 12 && bounds.bottom <= innerHeight - 12
            && element.scrollWidth <= element.clientWidth
        })).toBe(true)
        expect(await description.evaluate((element) => {
          const bounds = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return bounds.height > Number.parseFloat(style.lineHeight)
            && element.scrollHeight <= element.clientHeight && style.textOverflow !== 'ellipsis'
        })).toBe(true)
      }
      const labelBounds = await menu.getByText('Enable agent teamwork', { exact: true }).boundingBox()
      if (labelBounds === null) throw new Error('Team label is not visible')
      await page.mouse.click(labelBounds.x + labelBounds.width / 2, labelBounds.y + labelBounds.height / 2)
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
      await expect.poll(() => toggle.isEnabled()).toBe(true)
      await toggle.press('Escape')
      await menu.getByRole('menuitem', { name: 'Agent teamwork On', exact: true }).click()
      const gap = await toggle.evaluate((element) => {
        const control = element.getBoundingClientRect()
        const label = element.parentElement!.querySelector('span')!.getBoundingClientRect()
        return { x: (label.right + control.left) / 2, y: control.top + control.height / 2 }
      })
      await page.mouse.click(gap.x, gap.y)
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false')
      expect(await page.getByRole('tooltip').count()).toBe(0)
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      await closeModelMenu(page)
      await page.setViewportSize(viewport)
    }
  })

  it('defaults off and saves a Session selection in the model menu', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-team-mode'))
    const assertNoSubagentsSection = async (): Promise<void> => {
      expect(await (await showSubagentsSection(page)).locator('[data-subagents-section]').count()).toBe(0)
      await dismissSessionPanel(page)
    }
    await assertNoSubagentsSection()
    await openTeamSettings(page)
    const toggle = page.getByRole('switch', { name: 'Enable agent teamwork', exact: true })
    await toggle.waitFor()
    expect(await toggle.getAttribute('aria-checked')).toBe('false')
    await toggle.focus()
    await page.keyboard.press('Shift+Tab')
    expect(await page.getByRole('button', { name: /^Select model/u }).evaluate(element => element === document.activeElement)).toBe(true)
    expect(await toggle.count()).toBe(0)
    await openTeamSettings(page)
    expect(await toggle.evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Space')
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
    await closeModelMenu(page)
    await assertNoSubagentsSection()
    const agent = scaffold.ctx.agents.list()[0]!
    expect(scaffold.ctx.commands.list(agent).some(command => command.name === 'team')).toBe(false)
    expect(agent.session.ownEvents().filter(event => event.type === 'command/run' || event.type === 'command/done')).toEqual([])
    const other = await scaffold.ctx.agents.create({ sessionId: brandString<SessionId>('other-team-mode'), agentOptions: agent.options })
    expect(scaffold.ctx.agentTeams.isEnabled(other.agent)).toBe(false)
    await other.dispose()
    const beforeReload = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await assertNoSubagentsSection()
    await openTeamSettings(page)
    expect(await toggle.getAttribute('aria-checked')).toBe('true')
    await closeModelMenu(page)
    acknowledgeReloadConnectionLoss(tripwire, beforeReload)
  }, 60_000)

  it('toggles from the model menu and keeps text editing usable after refocusing', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-team-command-input'))
    const input = page.locator('[data-composer-input]').first()
    const agent = scaffold.ctx.agents.list()[0]!
    for (const enabled of [false, true]) {
      await openTeamSettings(page)
      const toggle = page.getByRole('switch', { name: 'Enable agent teamwork', exact: true })
      await toggle.click()
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe(String(enabled))
      await closeModelMenu(page)
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

  it('shows tasks in their own section without subagents and hides it after the last task is deleted', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-team-task-only'))
    const agent = scaffold.ctx.agents.list()[0]!
    const section = await showSharedTasksSection(page)
    expect(await section.locator('[data-team-panel]').count()).toBe(0)
    expect(await section.isVisible()).toBe(false)
    const task = await scaffold.ctx.agentTeams.createTask(agent, {
      subject: 'Plan before delegation', description: 'Prepare shared work before creating subagents',
    })
    const board = section.locator('[data-team-panel]')
    await board.getByText(task.subject, { exact: true }).waitFor()
    expect(await page.locator(SUBAGENTS_SECTION).isVisible()).toBe(false)
    expect(await section.getByRole('heading', { level: 2 }).locator('..').textContent()).toBe('Shared tasks1 pending')
    expect(await section.locator('h2 button, h3 button').count()).toBe(0)
    expect(await board.locator('[data-team-task-details]').count()).toBe(0)
    expect(await board.getByRole('button', { expanded: false }).count()).toBe(1)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'task-only.expected.md'),
      await captureStableAria(page, SHARED_TASKS_SECTION, scaffold.workspaceCwd), MODE)
    await scaffold.ctx.agentTeams.updateTask(agent, { taskId: task.id, expectedRevision: task.revision, action: 'delete' })
    await board.waitFor({ state: 'detached' })
    await section.waitFor({ state: 'hidden' })
    await dismissSessionPanel(page)
    expect(tripwire.pageErrors).toEqual([])
  })

  it('opens the member tree and live read-only tasks in their own sections', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-team-panel'))
    const projectionReads = vi.spyOn(scaffold.ctx.sessionController, 'projections')
    onTestFinished(() => { projectionReads.mockRestore() })
    const agent = scaffold.ctx.agents.list()[0]!
    const memberId = brandString<SessionId>('team-panel-researcher')
    agent.session.append('subagent/catalog', {
      version: 2, childId: memberId, childCreatedAt: Date.now(), mode: 'external',
      label: RESEARCHER_DESCRIPTION,
    })
    const toggle = sessionPanelToggle(page)
    await toggle.click()
    await toggle.click()
    await page.locator('[data-session-panel]').waitFor({ state: 'detached' })
    expect(await toggle.evaluate(element => element === document.activeElement)).toBe(true)
    const action = await showSubagentsSection(page)
    await action.getByRole('treeitem', { name: /Researcher/u }).waitFor()
    expect(await page.locator('[data-team-panel]').count()).toBe(0)
    expect(await page.getByText('No shared tasks yet. Create them through the conversation.').count()).toBe(0)
    expect(await action.locator('h2 button, h3 button').count()).toBe(0)
    expect(await action.getByRole('heading', { name: 'Members', exact: true }).count()).toBe(0)
    expect(projectionReads).not.toHaveBeenCalled()

    expect(await action.getByRole('button', { name: 'New task' }).count()).toBe(0)
    expect(await action.getByRole('button', { name: /Refresh/u }).count()).toBe(0)

    await action.getByRole('treeitem', { name: /Researcher/u }).waitFor()
    expect(await page.locator('[data-subagents-section]').count()).toBe(1)
    expect(await page.getByRole('button', { name: 'Task board', exact: true }).count()).toBe(0)
    const task = await scaffold.ctx.agentTeams.createTask(agent, {
      subject: 'Agent task', description: 'Created by the root agent', writeScopes: ['src/web'],
    })
    const tasks = page.locator(SHARED_TASKS_SECTION)
    const row = tasks.locator(`[data-team-task="${task.id}"]`)
    await row.getByRole('button', { name: 'Pending Agent task', exact: true, expanded: false }).waitFor()
    const head = action.getByRole('heading', { level: 2 }).locator('..')
    expect(await head.textContent()).toBe('Subagents1 external')
    expect(await action.locator('h2 button, h3 button').count()).toBe(0)
    expect(await action.evaluate((element, selector) => Boolean(
      element.compareDocumentPosition(document.querySelector(selector)!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ), SHARED_TASKS_SECTION)).toBe(true)
    expect(await row.evaluate(element => ({ tag: element.tagName, parent: element.parentElement?.tagName })))
      .toEqual({ tag: 'LI', parent: 'UL' })
    expect(await tasks.locator('[data-team-task-details], article').count()).toBe(0)
    const tasksHead = tasks.getByRole('heading', { level: 2 }).locator('..')
    expect(await tasksHead.textContent()).toBe('Shared tasks1 pending')
    expect(await tasks.getByRole('heading', { level: 2 }).evaluate(element => getComputedStyle(element).font))
      .toBe(await action.getByRole('heading', { level: 2 }).evaluate(element => getComputedStyle(element).font))
    const member = action.getByRole('treeitem', { name: /Researcher/u })
    const memberTitle = member.getByText(RESEARCHER_DESCRIPTION, { exact: true })
    const taskTitle = row.getByText('Agent task', { exact: true })
    const titleLefts = await Promise.all([
      memberTitle,
      taskTitle,
    ].map(locator => locator.evaluate(element => element.getBoundingClientRect().left)))
    expect(Math.max(...titleLefts) - Math.min(...titleLefts)).toBeLessThanOrEqual(1)
    const primaryStyles = await Promise.all([memberTitle, taskTitle].map(locator => locator.evaluate((element) => {
      const style = getComputedStyle(element)
      return { fontSize: style.fontSize, color: style.color }
    })))
    expect(primaryStyles.map(style => style.fontSize)).toEqual(['13px', '13px'])
    expect(primaryStyles[1]).toEqual(primaryStyles[0])
    // The member's name moves from the row to its hover card.
    expect(await member.getByText('team-panel-researcher', { exact: true }).count()).toBe(0)
    const memberHover = member.locator(':scope > div')
    for (const target of [member, memberHover]) {
      expect(await target.evaluate((element) => {
        const style = getComputedStyle(element)
        return [style.paddingTop, style.paddingBottom]
      })).toEqual(['4px', '4px'])
    }
    expect(await member.evaluate(element => getComputedStyle(element).minHeight)).toBe('28px')
    expect(await member.evaluate((element) => {
      const style = getComputedStyle(element)
      return { left: style.paddingLeft, right: style.paddingRight, gap: style.gap }
    })).toEqual({ left: '6px', right: '6px', gap: '8px' })
    expect(await memberHover.evaluate((element) => {
      const style = getComputedStyle(element)
      return { left: style.paddingLeft, right: style.paddingRight, gap: style.gap, margin: style.margin }
    })).toEqual({ left: '6px', right: '6px', gap: '8px', margin: '-4px -6px' })
    const taskHover = row.getByRole('button')
    expect(await taskHover.evaluate((element) => {
      const style = getComputedStyle(element)
      return [style.paddingTop, style.paddingBottom]
    })).toEqual(['4px', '4px'])
    expect(await taskHover.evaluate(element => element.getBoundingClientRect().height)).toBe(28)
    expect(await taskHover.evaluate((element) => {
      const style = getComputedStyle(element)
      return { left: style.paddingLeft, right: style.paddingRight, gap: style.gap, margin: style.margin }
    })).toEqual({ left: '6px', right: '6px', gap: '8px', margin: '0px' })
    // Status glyphs and trailing chevrons of both rows share their columns.
    const columns = await Promise.all([
      member.locator('[data-state]').first(), row.locator('[data-state]').first(),
    ].map(locator => locator.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return bounds.left + bounds.width / 2
    })))
    expect(Math.abs(columns[0]! - columns[1]!)).toBeLessThanOrEqual(0.5)
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
    })).toEqual({ fontSize: '12px', indent: '30px' })
    expect(await row.locator('[data-team-task-details] p, [data-team-task-owner]')
      .evaluateAll(elements => elements.every(element => getComputedStyle(element).fontSize === '12px'))).toBe(true)
    expect(await row.getByRole('button').getAttribute('aria-expanded')).toBe('true')
    await scaffold.ctx.agentTeams.updateTask(agent, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    await row.getByRole('img', { name: 'In progress', exact: true }).waitFor()
    await row.locator('[data-team-task-owner]').filter({ hasText: 'Owner: lead' }).waitFor()
    await tasks.getByText('1 in progress', { exact: true }).waitFor()
    expect(await tasks.getByRole('button', { name: /^(New task|Edit|Complete|Reopen|Delete)$/u }).count()).toBe(0)
    expect(await tasks.locator('input, select, textarea').count()).toBe(0)

    // The working directory row abbreviates the home directory, which holds the scratch workspace on CI.
    const snapshot = await captureStableAria(page, '[data-session-panel]', scaffold.workspaceCwd, {
      replacements: [[abbreviateHomePath(scaffold.workspaceCwd, homedir()), '{{cwd}}']],
    })
    await compareOrRefreshGolden(PANEL_EXPECTED, snapshot, MODE)
    expect(projectionReads).not.toHaveBeenCalled()
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await dismissSessionPanel(page)
  }, 60_000)

  it('hides the board while disabled and restores its tasks when re-enabled', async () => {
    await openTeamSettings(page)
    const toggle = page.getByRole('switch', { name: 'Enable agent teamwork', exact: true })
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false')
    await closeModelMenu(page)
    const section = await showSubagentsSection(page)
    await section.getByRole('treeitem', { name: /Researcher/u }).waitFor()
    expect(await page.locator('[data-subagents-section]').count()).toBe(1)
    expect(await page.locator('[data-team-panel]').count()).toBe(0)
    await dismissSessionPanel(page)
    await openTeamSettings(page)
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
    await closeModelMenu(page)
    await (await showSharedTasksSection(page)).getByText('Agent task', { exact: true }).waitFor()
    await dismissSessionPanel(page)
  })

  it('keeps the toggle focused in a narrow window and opens the catalog only on explicit activation', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-team-narrow-trigger'))
    const trigger = sessionPanelToggle(page)
    const panel = page.locator('[data-session-panel]')
    const viewport = page.viewportSize()!
    await trigger.focus()
    const original = await trigger.elementHandle()
    if (original === null) throw new Error('Session panel toggle is missing')
    try {
      await page.setViewportSize({ width: 390, height: 700 })
      expect(await original.evaluate(element => element.isConnected && element === document.activeElement)).toBe(true)
      await page.mouse.move(1, 1)
      await trigger.hover()
      // Hover alone opens nothing, even past the 150ms delay of hover-opened subagent menus.
      await page.waitForTimeout(200)
      expect(await panel.count()).toBe(0)
      await trigger.click()
      await panel.waitFor()
      expect(await panel.getAttribute('data-session-panel')).toBe('overlay')
      expect(await trigger.getAttribute('aria-expanded')).toBe('true')
      const section = panel.locator(SUBAGENTS_SECTION)
      await section.getByRole('treeitem', { name: /Researcher/u }).waitFor()
      await panel.locator('[data-team-task]').getByRole('button', { expanded: false }).waitFor()
      await trigger.click()
      await panel.waitFor({ state: 'detached' })
      expect(await trigger.getAttribute('aria-expanded')).toBe('false')
    } finally {
      await page.setViewportSize(viewport)
      await original.dispose()
    }
  })

  it('keeps the panel inside the viewport and closes on outside click or Escape', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-team-panel-keyboard'))
    const panel = page.locator('[data-session-panel]')
    const section = panel.locator(SUBAGENTS_SECTION)
    const tasksHeading = panel.locator(SHARED_TASKS_SECTION).getByRole('heading', { name: 'Shared tasks', exact: true })
    const trigger = sessionPanelToggle(page)
    const viewport = page.viewportSize()!
    try {
      for (const size of [{ width: 760, height: 540 }, { width: 600, height: 420 }, { width: 390, height: 700 }]) {
        await page.setViewportSize(size)
        await showSessionPanel(page)
        await tasksHeading.waitFor()
        await expect.poll(() => panel.evaluate((element) => {
          const rect = element.getBoundingClientRect()
          return element.getAttribute('data-session-panel') === 'overlay'
            && rect.left >= 0 && rect.top >= 0
            && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight
            && [[rect.left + 12, rect.top + 12], [rect.right - 12, rect.bottom - 12]]
              .every(([x, y]) => element.contains(document.elementFromPoint(x!, y!)))
        })).toBe(true)
      }
      const row = section.getByRole('treeitem', { name: /Researcher/u })
      const primary = row.getByText(RESEARCHER_DESCRIPTION, { exact: true })
      expect(await row.getByRole('button').count()).toBe(0)
      // The row keeps one line at every width: the description clips, and the name shows in its hover card.
      expect(await primary.evaluate(element => ({ tag: element.tagName, whiteSpace: getComputedStyle(element).whiteSpace })))
        .toEqual({ tag: 'SPAN', whiteSpace: 'nowrap' })
      expect(await row.getByText('team-panel-researcher', { exact: true }).count()).toBe(0)
      expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await primary.hover()
      const card = page.locator('[data-session-panel-details]')
      await card.waitFor()
      expect(await card.evaluate(element => [...element.children].slice(0, 2).map(child => child.textContent)))
        .toEqual([RESEARCHER_DESCRIPTION, 'Owner: team-panel-researcher'])
      // The window has room for the card on neither side of the row, and this description fills a card too
      // tall to open under or over the row, so the card covers the row; it stays inside the viewport.
      expect(await card.evaluate((element) => {
        // The details sit inside the fixed card.
        let fixed = element
        while (getComputedStyle(fixed).position !== 'fixed') fixed = fixed.parentElement!
        const rect = fixed.getBoundingClientRect()
        return rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight
      })).toBe(true)
      await page.mouse.move(20, 400)
      await card.waitFor({ state: 'detached' })
      // A card that fits under its row opens there, from the row's start edge and inside the viewport's
      // margin, so the row stays clear.
      const task = panel.locator('[data-team-task]').getByRole('button')
      await task.hover()
      await card.waitFor()
      const anchor = await task.locator('xpath=..').boundingBox()
      if (anchor === null) throw new Error('the task row has no box')
      const placed = await card.evaluate((element) => {
        let fixed = element
        while (getComputedStyle(fixed).position !== 'fixed') fixed = fixed.parentElement!
        const bounds = fixed.getBoundingClientRect()
        return { left: bounds.left, top: bounds.top, right: bounds.right, viewport: window.innerWidth }
      })
      expect({ below: placed.top - (anchor.y + anchor.height), start: placed.left - anchor.x }).toEqual({ below: 8, start: 0 })
      expect(placed.right).toBeLessThanOrEqual(placed.viewport - 8)
      const beforeClick = page.url()
      await primary.click()
      expect(page.url()).toBe(beforeClick)
      expect(await page.getByRole('tooltip').count()).toBe(0)
      await tasksHeading.click()
      expect(await panel.count()).toBe(1)
      await page.mouse.click(2, 2)
      await panel.waitFor({ state: 'detached' })
      // A width whose transcript cannot move aside for the panel, so the toggle opens it over the conversation.
      await page.setViewportSize({ width: 1100, height: viewport.height })
      await settleDockProbe(page)
      expect(await page.locator('[data-session-panel-probe]').evaluate(element => element.getBoundingClientRect().width)).toBe(0)
      await trigger.focus()
      await page.keyboard.press('Enter')
      await tasksHeading.waitFor()
      await panel.locator('[data-team-task]').getByRole('button').focus()
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

  it('keeps compact tasks ordered, opens one full detail at a time, and scrolls only the Session panel', async () => {
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
    const panel = page.locator('[data-session-panel]')
    const section = panel.locator(SHARED_TASKS_SECTION)
    const board = section.locator('[data-team-panel]')
    const row = board.locator(`[data-team-task="${task.id}"]`)
    const emptyRow = board.locator(`[data-team-task="${completed.id}"]`)
    onTestFinished(() => page.setViewportSize(viewport))
    // Constrain the panel so closed and expanded task rows both exercise its scrollbar, at a width whose transcript
    // cannot move aside for it: the panel opens over the conversation and stays mounted as the window narrows below.
    await page.setViewportSize({ width: 1100, height: 500 })
    await showSharedTasksSection(page)
    await row.waitFor()
    expect(await board.locator('[data-team-task-details], article').count()).toBe(0)
    expect(await board.getByRole('button', { expanded: false }).count()).toBe(4)
    expect(await board.locator('[data-team-task]').evaluateAll(elements => elements.map(element => element.getAttribute('data-status'))))
      .toEqual(['in_progress', 'pending', 'pending', 'completed'])
    const counts = section.getByText('1 completed\u2002·\u20021 in progress\u2002·\u20022 pending', { exact: true })
    await counts.waitFor()
    expect(await counts.textContent()).toBe('1 completed\u2002·\u20021 in progress\u2002·\u20022 pending')
    expect(await section.locator('h2 button, h3 button').count()).toBe(0)
    expect(await section.getByRole('button', { name: /^Show (more|less)$/u }).count()).toBe(0)
    await row.getByRole('img', { name: 'Blocked by dependencies', exact: true }).waitFor()
    // The panel itself scrolls; its client box ends where its scrollbar track begins.
    const measureScroll = async () => panel.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      const taskBounds = element.querySelector('[data-team-task] button')!.getBoundingClientRect()
      const trackLeft = bounds.left + element.clientLeft + element.clientWidth
      return {
        overflowing: element.scrollHeight > element.clientHeight,
        taskLeft: taskBounds.left, taskRight: taskBounds.right,
        arrowsBeforeTrack: [...element.querySelectorAll('[data-team-task] button svg')]
          .every(arrow => arrow.getBoundingClientRect().right <= trackLeft),
      }
    })
    const closedScroll = await measureScroll()
    expect(closedScroll.overflowing, JSON.stringify(closedScroll)).toBe(true)
    await row.getByRole('button').click()
    const expandedScroll = await measureScroll()
    expect(expandedScroll.overflowing).toBe(true)
    expect(expandedScroll.taskLeft).toBe(closedScroll.taskLeft)
    expect(expandedScroll.taskRight).toBe(closedScroll.taskRight)
    expect(expandedScroll.arrowsBeforeTrack).toBe(true)
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
        return element.getAttribute('data-session-panel') === 'overlay'
          && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
          && element.scrollWidth <= element.clientWidth
      })).toBe(true)
      expect(await panel.evaluate((panelElement) => {
        const scrollers = [panelElement, ...panelElement.querySelectorAll('*')].filter(element =>
          ['auto', 'scroll'].includes(getComputedStyle(element).overflowY)
          && element.scrollHeight > element.clientHeight)
        return scrollers.map(element => ({
          panel: element === panelElement,
          hasTree: element.querySelector('[role="tree"]') !== null,
          hasBoard: element.querySelector('[data-team-panel]') !== null,
          fitsWidth: element.scrollWidth <= element.clientWidth,
        }))
      })).toEqual([{ panel: true, hasTree: true, hasBoard: true, fitsWidth: true }])
      expect((await measureScroll()).arrowsBeforeTrack).toBe(true)
      await panel.hover({ position: { x: 20, y: 20 } })
      // A `scrollend` listener attached alongside the wheel can miss the event, which does not repeat; the offset
      // records the scroll either way.
      await page.mouse.wheel(0, 180)
      await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
      await panel.evaluate((element) => { element.scrollTo({ top: 0 }) })
      await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBe(0)
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
      // Long progress clips on the title's line; the title itself keeps its full width.
      const title = section.getByRole('heading', { name: 'Shared tasks', exact: true })
      expect(await title.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      const titleBounds = await title.boundingBox()
      const countBounds = await counts.boundingBox()
      const sectionBounds = await section.boundingBox()
      expect(titleBounds).not.toBeNull()
      expect(countBounds).not.toBeNull()
      expect(Math.abs((countBounds!.y + countBounds!.height / 2) - (titleBounds!.y + titleBounds!.height / 2))).toBeLessThanOrEqual(1)
      expect(countBounds!.x + countBounds!.width).toBeLessThanOrEqual(sectionBounds!.x + sectionBounds!.width)
      await compareOrRefreshGolden(RESIZE_EXPECTED, await captureStableAria(page, SHARED_TASKS_SECTION, scaffold.workspaceCwd), MODE)
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
    } finally {
      await page.keyboard.press('Escape')
      await page.setViewportSize(viewport)
    }
  })

  it('holds back the tasks past five behind the fold control and keeps the choice while the panel is hidden', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-team-task-fold'))
    const agent = scaffold.ctx.agents.list()[0]!
    const before = scaffold.ctx.agentTeams.listTasks(agent).filter(task => task.status !== 'deleted')
    // The tasks so far: one in progress, pending ones, and a completed one. Pending tasks bring the list to eight.
    for (let index = before.length; index < 8; index++) {
      await scaffold.ctx.agentTeams.createTask(agent, { subject: `Fold task ${String(index)}`, description: 'Fills the list.', writeScopes: [] })
    }
    const section = await showSharedTasksSection(page)
    const tasks = section.locator('[data-team-task]')
    const fold = section.locator('[data-session-panel-row="fold"]')
    const statuses = (): Promise<(string | null)[]> => tasks.evaluateAll(items => items.map(item => item.getAttribute('data-status')))
    // Five tasks show: the one in progress, then pending ones in source order. The completed task is held back.
    await expect.poll(statuses, { timeout: 15_000 }).toEqual(['in_progress', 'pending', 'pending', 'pending', 'pending'])
    expect(await fold.textContent()).toBe('Show 3 more')
    // The control follows the list, at the row height, with its chevron under the state marks and its text under the subjects.
    expect(await section.getByRole('list').locator('[data-session-panel-row="fold"]').count()).toBe(0)
    expect(await foldControlLayout(fold, tasks.first().getByRole('button'), '[class*="subject"]'))
      .toEqual({ heights: [28, 28], chevronOffset: 0, textOffset: 0, fontSize: '12px', expanded: 'false' })
    await section.getByRole('button', { name: 'Show 3 more (shared tasks)', exact: true }).click()
    await expect.poll(statuses).toEqual(['in_progress', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'completed'])
    const less = section.getByRole('button', { name: 'Show less (shared tasks)', exact: true })
    expect([await less.textContent(), await less.getAttribute('aria-expanded')]).toEqual(['Show less', 'true'])
    // The choice is the Session's: it holds while the panel is hidden.
    await dismissSessionPanel(page)
    await showSharedTasksSection(page)
    await expect.poll(() => tasks.count()).toBe(8)
    await less.click()
    await expect.poll(() => tasks.count()).toBe(5)
    expect(tripwire.pageErrors).toEqual([])
    await dismissSessionPanel(page)
  })

  it('confirms disabling after a recorded model request and keeps cancellation side-effect free', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-team-disable-confirmation'))
    const agent = scaffold.ctx.agents.list()[0]!
    const selection = agent.model.current()
    if (selection === undefined) throw new Error('Team fixture has no selected model')
    agent.session.append('request/header', { header: { config: selection }, reason: 'initial' })
    await scaffold.ctx.sessions.flush(agent.session)
    const openConfirmation = async (): Promise<void> => {
      await openTeamSettings(page)
      await page.getByRole('switch', { name: 'Enable agent teamwork', exact: true }).click()
      await page.getByRole('dialog', { name: 'Disable agent teamwork?', exact: true }).waitFor()
    }
    await openConfirmation()
    const dialog = page.getByRole('dialog', { name: 'Disable agent teamwork?', exact: true })
    await assertWarningDialogLayout(dialog)
    expect(await page.getByRole('group', { name: 'Agent teamwork', exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: /^Select model/u }).getAttribute('aria-expanded')).toBe('false')
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
    await openTeamSettings(page)
    await page.getByRole('switch', { name: 'Enable agent teamwork', exact: true }).click()
    await expect.poll(() => scaffold.ctx.agentTeams.isEnabled(agent)).toBe(true)
    expect(await dialog.count()).toBe(0)
    await closeModelMenu(page)
    expect(agent.session.ownEvents().filter(event => event.type === 'command/run' || event.type === 'command/done')).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  })

  it('hides the Shared tasks section when the last shared task is deleted', async () => {
    const agent = scaffold.ctx.agents.list()[0]!
    const tasks = await showSharedTasksSection(page)
    await tasks.locator('[data-team-panel]').waitFor()
    for (const task of scaffold.ctx.agentTeams.listTasks(agent).toReversed()) {
      if (task.status === 'deleted') continue
      await scaffold.ctx.agentTeams.updateTask(agent, {
        taskId: task.id, expectedRevision: task.revision, action: 'delete',
      })
    }
    await tasks.locator('[data-team-panel]').waitFor({ state: 'detached' })
    await tasks.waitFor({ state: 'hidden' })
    expect(await page.getByText('No shared tasks yet. Create them through the conversation.').count()).toBe(0)
    expect(await page.locator(SUBAGENTS_SECTION).getByRole('treeitem', { name: /Researcher/u }).count()).toBe(1)
    await dismissSessionPanel(page)
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
      await openTeamSettings(page, locale.code === 'zh')
      const toggle = page.getByRole('switch', { name: locale.toggle, exact: true })
      await toggle.click()
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe(String(enabled))
      await expect.poll(() => scaffold.ctx.agentTeams.isEnabled(agent)).toBe(enabled)
      expect(scaffold.ctx.commands.list(agent).some(command => command.name === 'team')).toBe(false)
      expect(commandEvents()).toEqual([])
      await closeModelMenu(page)
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
      const commandId = brandString<CommandId>(`historical-team-${args.trim()}`)
      agent.session.append('command/run', { commandId, name: 'team', args, source: { kind: 'user' } })
      agent.session.append('command/done', { commandId, kind: 'success', text: 'Team mode saved.' })
    }
    agent.session.append('command/run', {
      commandId: brandString<CommandId>('historical-team-pending'), name: 'team', args: ' on', source: { kind: 'user' },
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
    const commandId = brandString<CommandId>('historical-team-error')
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

it('shows the Chinese Shared tasks section without subagents', async () => {
  await withTeamReceiptPage(RECEIPT_LOCALES[1], async (page, scaffold) => {
    const agent = scaffold.ctx.agents.list()[0]!
    await scaffold.ctx.agentTeams.setEnabled(agent, true)
    await scaffold.ctx.agentTeams.createTask(agent, {
      subject: '准备协作', description: '先准备共享任务，再创建子智能体。',
    })
    const section = await showSharedTasksSection(page)
    await section.getByText('准备协作', { exact: true }).waitFor()
    expect(await section.getByRole('heading', { level: 2 }).locator('..').textContent()).toBe('共享任务1 待处理')
    expect(await section.locator('h2 button, h3 button').count()).toBe(0)
    expect(await section.locator('[data-team-task-details]').count()).toBe(0)
    expect(await page.locator(SUBAGENTS_SECTION).isVisible()).toBe(false)
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
    const trigger = page.getByRole('button', { name: /^选择模型/u })
    await trigger.click()
    await page.getByRole('menuitem', { name: '智能体团队协作 关闭', exact: true }).waitFor()
    await closeModelMenu(page)
    await scaffold.ctx.agentTeams.setEnabled(agent, true)
    const selection = agent.model.current()
    if (selection === undefined) throw new Error('Chinese Team fixture has no model')
    agent.session.append('request/header', { header: { config: selection }, reason: 'initial' })
    await scaffold.ctx.sessions.flush(agent.session)
    await trigger.click()
    await page.getByRole('menuitem', { name: '智能体团队协作 开启', exact: true }).click()
    const toggle = page.getByRole('switch', { name: '开启智能体团队协作', exact: true })
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
    await page.getByText('通过共享任务板协调多个智能体的分工与进度，复杂任务表现更佳，token 开销也相应更高。', { exact: true }).waitFor()
    expect(await page.getByRole('tooltip').count()).toBe(0)
    expect(await toggle.evaluate(element => element.parentElement!.scrollWidth <= element.parentElement!.clientWidth)).toBe(true)
    const menu = await captureStableAria(page, '[data-model-menu]', scaffold.workspaceCwd)
    await toggle.click()
    const dialog = page.getByRole('dialog', { name: '确认关闭智能体团队协作？', exact: true })
    await dialog.waitFor()
    await dialog.getByText('对话过程中关闭智能体团队协作，将停止共享任务工具和团队协调指令。', { exact: true }).waitFor()
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
