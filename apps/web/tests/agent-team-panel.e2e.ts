// Keyless assembled-browser coverage for the opt-in Agent Teams bundle
// over the real Host projection frame flow.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/agent-team-panel', import.meta.url))
const PANEL_EXPECTED = join(SNAPSHOT_DIR, 'task.expected.md')
const RESIZE_EXPECTED = join(SNAPSHOT_DIR, 'resize.expected.md')
const OVERLAY = fileURLToPath(new URL('./agent-team-panel.overlay.yml', import.meta.url))
const TEAM_PATCH = fileURLToPath(new URL('../../../packages/experimental/agent-team-profile/cordis.patch.yml', import.meta.url))
const INSTALL_ANCHORS = [
  fileURLToPath(new URL('../../../packages/experimental/agent-team-profile/package.json', import.meta.url)),
]
const MODE = webSnapshotMode()

function profileEntries(path: string): unknown[] {
  const parsed = yaml.load(readFileSync(path, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new Error(`profile layer at ${path} must be a list`)
  return parsed
}

describe('Agent Teams panel overlay', () => {
  it('matches the shipped Agent Teams bundle', () => {
    expect(profileEntries(OVERLAY)).toEqual(profileEntries(TEAM_PATCH))
  })
})

describe('web e2e: Agent Teams panel', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, extraInstallAnchors: INSTALL_ANCHORS })
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
      content: [{ type: 'text', text: 'Open the Agent Team controls.' }],
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

  it('displays agent-owned task changes through a read-only board without a refresh action', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-team-panel'))
    const projectionReads = vi.spyOn(scaffold.ctx.sessionController, 'projections')
    onTestFinished(() => { projectionReads.mockRestore() })
    await page.locator('[data-team-action]').getByRole('button', { name: /Agent Team/iu }).click()
    const action = page.getByRole('dialog', { name: 'Agent Team', exact: true })
    await action.getByText('No shared tasks yet. Create them through the conversation.').waitFor()
    await action.getByText('lead').waitFor()
    expect(projectionReads).not.toHaveBeenCalled()

    expect(await action.getByRole('button', { name: 'New task' }).count()).toBe(0)
    expect(await action.getByRole('button', { name: /Refresh/u }).count()).toBe(0)

    // Host-side Team mutations reach the open panel through projection frames only.
    const agent = scaffold.ctx.agents.list()[0]!
    const task = await scaffold.ctx.agentTeams.createTask(agent, {
      subject: 'Agent task', description: 'Created by the Team Lead', writeScopes: ['src/web'],
    })
    await action.getByText('Agent task', { exact: true }).waitFor()
    await action.getByText('Owner: Unowned', { exact: true }).waitFor()
    await scaffold.ctx.agentTeams.updateTask(agent, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    await action.getByText('In progress', { exact: true }).waitFor()
    await action.getByText('Owner: lead', { exact: true }).waitFor()
    expect(await action.getByRole('button', { name: /^(New task|Edit|Complete|Reopen|Delete)$/u }).count()).toBe(0)
    expect(await action.locator('input, select, textarea').count()).toBe(0)

    const snapshot = await captureStableAria(page, '[data-team-panel]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(PANEL_EXPECTED, snapshot, MODE)
    expect(projectionReads).not.toHaveBeenCalled()
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await page.keyboard.press('Escape')
  }, 60_000)

  it('keeps the panel inside the viewport and closes on outside click or Escape', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-team-panel-keyboard'))
    const panel = page.getByRole('dialog', { name: 'Agent Team', exact: true })
    const trigger = page.locator('[data-team-action]').getByRole('button', { name: /Agent Team/iu })
    const viewport = page.viewportSize()!
    await trigger.click()
    await panel.getByText('lead', { exact: true }).waitFor()
    try {
      for (const size of [{ width: 760, height: 540 }, { width: 600, height: 420 }]) {
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
      const outside = page.getByRole('button', { name: 'Settings', exact: true })
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
    const trigger = page.locator('[data-team-action]').getByRole('button', { name: 'Agent Team', exact: true })
    const panel = page.getByRole('dialog', { name: 'Agent Team', exact: true })
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
    const trigger = page.locator('[data-team-action]').getByRole('button', { name: 'Agent Team', exact: true })
    const panel = page.getByRole('dialog', { name: 'Agent Team', exact: true })
    const card = panel.locator('article').filter({ hasText: 'Responsive task' })
    await trigger.click()
    await card.waitFor()
    expect(await card.getByRole('button', { name: 'Show more' }).count()).toBe(0)
    try {
      await page.setViewportSize({ width: 360, height: 700 })
      await card.getByRole('button', { name: 'Show more' }).waitFor()
      expect(await card.locator('p').evaluate(p => p.scrollHeight > p.clientHeight)).toBe(true)
      await compareOrRefreshGolden(RESIZE_EXPECTED, await captureStableAria(page, '[data-team-panel]', scaffold.workspaceCwd), MODE)
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
