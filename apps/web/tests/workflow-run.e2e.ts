// Keyless shipped-Web acceptance for the durable workflow Conversation Node.
// Reuses the existing recorded workflow parent/child model fixtures; the real
// workflow tool, worker, subagent provider, Session log, browser plugin graph,
// and navigation all execute during replay.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  fixtureUserPrompts, launchWebScaffold, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import {
  connectFreshWorkspace, expandTurnProcesses, newEnglishPage, REPO_ROOT, saveFailureShot,
} from './support.ts'

const MODE = webSnapshotMode()
const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/workflow-run', import.meta.url))
const UI_LIVE_EXPECTED = join(SNAPSHOT_DIR, 'ui-live.expected.md')
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const PARENT_FIXTURE = join(REPO_ROOT, 'snapshots/session/workflow-run/session.v2.jsonl')
const CHILD_FIXTURE = join(REPO_ROOT, 'snapshots/session/workflow-run/session.1.v2.jsonl')
const CHILD_PROMPT = 'Reply with exactly the word WF_CHILD_OK and nothing else.'

describe.skipIf(MODE === 'record')('web e2e: durable workflow run in Chat', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let prompt: string

  const waitForParentSettlement = (): Promise<SessionId> => new Promise((resolve, reject) => {
    let dispose = (): void => {}
    dispose = scaffold.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (event.type !== 'turn/end' || session.header.origin === 'subagent') return
      dispose()
      void (async () => {
        await scaffold.ctx.agents.get(session.id)?.whenIdle()
        await scaffold.ctx.sessions.flush(session)
        resolve(session.id)
      })().catch(reject)
    })
  })

  beforeAll(async () => {
    const prompts = fixtureUserPrompts(await readFile(PARENT_FIXTURE, 'utf8'))
    expect(prompts).toHaveLength(1)
    prompt = prompts[0]!
    scaffold = await launchWebScaffold({
      replayFixture: PARENT_FIXTURE,
      replayChildFixtures: [CHILD_FIXTURE],
      paceMs: 50,
      compareReplaySession: false,
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('shows the live member, opens its local child, then retains the settled record beside the tool row', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workflow-run-live'))
    const settled = waitForParentSettlement()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(prompt)
    await input.press('Enter')

    const workflow = page.locator('[data-workflow-run][data-run-status="running"]')
    await workflow.waitFor({ timeout: 30_000 })
    const disclosures = workflow.locator('[data-disclosure-row]')
    await disclosures.nth(1).waitFor({ timeout: 15_000 })
    const runDisclosure = disclosures.nth(0)
    const phaseDisclosure = disclosures.nth(1)
    expect(await runDisclosure.getAttribute('role')).toBe('button')
    expect(await runDisclosure.getAttribute('aria-expanded')).toBe('true')
    expect(await phaseDisclosure.getAttribute('role')).toBe('button')
    expect(await phaseDisclosure.getAttribute('aria-expanded')).toBe('true')
    expect(await runDisclosure.evaluate(element => getComputedStyle(element).cursor)).toBe('pointer')
    expect(await phaseDisclosure.evaluate(element => getComputedStyle(element).cursor)).toBe('pointer')
    const member = page.getByRole('button', { name: /^Open Reply with exactly the word/ })
    await member.waitFor({ timeout: 15_000 })

    await phaseDisclosure.click()
    expect(await phaseDisclosure.getAttribute('aria-expanded')).toBe('false')
    expect(await member.count()).toBe(0)
    const liveSnapshot = await captureStableAria(page, '[data-workflow-run]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_LIVE_EXPECTED, liveSnapshot, MODE)
    await phaseDisclosure.press('Enter')
    await member.waitFor()
    await runDisclosure.click()
    expect(await runDisclosure.getAttribute('aria-expanded')).toBe('false')
    expect(await disclosures.count()).toBe(1)
    await runDisclosure.press('Space')
    expect(await disclosures.count()).toBe(2)
    expect(await phaseDisclosure.getAttribute('aria-expanded')).toBe('true')
    await member.focus()

    const lightColor = await member.locator('[data-member-label]').evaluate(element => getComputedStyle(element).color)
    await page.setViewportSize({ width: 560, height: 800 })
    await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', '') })
    const darkNarrow = await page.locator('[data-workflow-run]').evaluate((element) => {
      const panel = element as HTMLElement
      panel.style.width = '356px'
      const label = element.querySelector('[data-member-label]')
      const labelWrap = element.querySelector('[data-member-label-wrap]')
      const status = element.querySelector('[data-member-status-text]')
      const disclosures = element.querySelectorAll('[data-disclosure-row]')
      const runHeader = disclosures[0]
      const phaseHeader = disclosures[1]
      const phaseTitle = phaseHeader?.children.item(1) as HTMLElement | null
      const phaseStatus = element.querySelector('[data-phase-status-text]')
      const originalPhaseTitle = phaseTitle?.textContent ?? ''
      if (phaseTitle !== null) phaseTitle.textContent = 'A phase name long enough to require ellipsis in the narrow layout'
      const phaseTitleRight = phaseTitle?.getBoundingClientRect().right ?? 0
      const phaseStatusLeft = phaseStatus?.getBoundingClientRect().left ?? 0
      if (phaseTitle !== null) phaseTitle.textContent = originalPhaseTitle
      return {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        color: label === null ? '' : getComputedStyle(label).color,
        decoration: label === null ? '' : getComputedStyle(label).textDecorationLine,
        focusWidth: labelWrap === null ? '' : getComputedStyle(labelWrap).outlineWidth,
        statusWidth: status?.getBoundingClientRect().width ?? 0,
        statusFontSize: status === null ? '' : getComputedStyle(status).fontSize,
        runHeight: runHeader?.getBoundingClientRect().height ?? 0,
        phaseHeight: phaseHeader?.getBoundingClientRect().height ?? 0,
        phaseTitleRight,
        phaseStatusLeft,
      }
    })
    expect(darkNarrow.clientWidth).toBe(356)
    expect(darkNarrow.scrollWidth).toBeLessThanOrEqual(darkNarrow.clientWidth)
    expect(darkNarrow.color).not.toBe(lightColor)
    expect(darkNarrow.decoration).toContain('underline')
    expect(Number.parseFloat(darkNarrow.focusWidth)).toBeGreaterThanOrEqual(2)
    expect(darkNarrow.statusWidth).toBe(64)
    expect(darkNarrow.statusFontSize).toBe('13px')
    expect(darkNarrow.runHeight).toBe(32)
    expect(darkNarrow.phaseHeight).toBe(32)
    expect(darkNarrow.phaseTitleRight).toBeLessThanOrEqual(darkNarrow.phaseStatusLeft)
    await page.locator('[data-workflow-run]').evaluate((element) => {
      (element as HTMLElement).style.removeProperty('width')
      document.body.removeAttribute('data-ds-dark-theme')
    })
    await page.setViewportSize({ width: 1280, height: 800 })

    await member.click()
    await page.getByText(CHILD_PROMPT, { exact: true }).waitFor({ timeout: 15_000 })

    const sessions = page.getByRole('tree', { name: 'Sessions' })
    await sessions.getByRole('treeitem', { name: /Use the workflow tool exactly/ }).click()
    await settled
    await expandTurnProcesses(page)
    await page.locator('[data-workflow-run][data-run-status="completed"]').waitFor()

    expect(await page.locator('[data-chat-flow-kind="tool-call"]').count()).toBeGreaterThanOrEqual(1)
    expect(await page.locator('[data-chat-flow-kind="workflow-run"]').count()).toBe(1)
    const terminalWorkflow = page.getByRole('button', { name: /^snapshot-flow/ })
    await terminalWorkflow.waitFor()
    expect(await terminalWorkflow.getAttribute('aria-expanded')).toBe('false')
    expect(await terminalWorkflow.evaluate(element => getComputedStyle(element).cursor)).toBe('pointer')
    await terminalWorkflow.click()
    const terminalPhase = page.getByRole('button', { name: /^Run/ })
    await terminalPhase.waitFor()
    expect(await terminalPhase.getAttribute('aria-expanded')).toBe('false')
    expect(await terminalPhase.evaluate(element => getComputedStyle(element).cursor)).toBe('pointer')
    await terminalPhase.click()
    await page.getByText(CHILD_PROMPT, { exact: false }).waitFor()
    await expect.poll(
      () => page.getByRole('button', { name: /^Open Reply with exactly the word/ }).count(),
      { timeout: 10_000 },
    ).toBe(0)
  }, 90_000)

  it('rebuilds the terminal record from history after reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workflow-run-history'))
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await expandTurnProcesses(page)
    const workflow = page.getByRole('button', { name: /^snapshot-flow/ })
    await workflow.waitFor({ timeout: 15_000 })
    expect(await workflow.getAttribute('aria-expanded')).toBe('false')
    const snapshot = await captureStableAria(page, '[data-chat-flow]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    await workflow.click()
    const phase = page.getByRole('button', { name: /^Run/ })
    await phase.waitFor()
    expect(await phase.getAttribute('aria-expanded')).toBe('false')
    await phase.click()
    await page.getByText(CHILD_PROMPT, { exact: false }).waitFor()
    expect(await page.getByRole('button', { name: /^Open Reply with exactly the word/ }).count()).toBe(0)

  }, 60_000)

  it('stays clean and owns only its one golden', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui-live.expected.md', 'ui.expected.md'])
  })
})
