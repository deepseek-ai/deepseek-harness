/** Recency and saved manual order through the shipped Web composition. */
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page, type WebSocketRoute } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/workspace-recency', import.meta.url))
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const MODE = webSnapshotMode()
const TITLES = ['Newest conversation', 'Middle conversation', 'Oldest conversation']

describe('web e2e: workspace recency', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let socket: WebSocketRoute
  let holdWorkspace = false
  let releaseWorkspace: (() => void) | undefined

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const fixture = await readFile(SEED, 'utf8')
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const now = Date.now()
    const ids = []
    for (const [index, title] of TITLES.entries()) {
      const id = await seedSession(scaffold, fixture, `workspace-recency-${index}`, undefined, {
        createdAt: now - (index + 1) * 60_000,
      })
      await workspace.attachSession(id)
      await scaffold.ctx.sessionController.rename({ sessionId: id, title })
      ids.push(id)
    }
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.routeWebSocket('**/api/remote.mux', (route) => {
      socket = route
      const server = route.connectToServer()
      let heldStream: string | undefined
      const pending: (string | Buffer)[] = []
      server.onMessage((message) => {
        const frame = JSON.parse(String(message)) as {
          type: string
          streamId: string
          value?: { type: string; value?: { archivedSessionIds?: string[] } }
        }
        if (holdWorkspace && frame.type === 'item' && frame.value?.type === 'baseline'
          && frame.value.value?.archivedSessionIds !== undefined) {
          heldStream = frame.streamId
          releaseWorkspace = () => {
            heldStream = undefined
            for (const buffered of pending.splice(0)) route.send(buffered)
          }
        }
        if (frame.streamId === heldStream) pending.push(message)
        else route.send(message)
      })
    })
    await page.clock.setFixedTime(now)
    tripwire = watchConsole(page)
    await page.addInitScript(({ account, ids }) => {
      if (localStorage.getItem('dsh.workspace.view.v5') !== null) return
      localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: ids[0] }))
      localStorage.setItem('dsh.workspace.view.v5', JSON.stringify({
        groupBy: 'workspace', orderBy: 'updated', groupExpansion: { [account]: true },
        sessionOrderByAccount: { [account]: [...ids].reverse(), __flat_session_order__: [...ids].reverse() },
      }))
    }, { account: workspace.id, ids })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('pauses current recency in Manual, preserves drags on reload, and resets on Last updated', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workspace-recency'))
    const titles = () => page.locator('[role="treeitem"]:not([aria-expanded]) [class*="title"]').allTextContents()
    const pick = async (name: string): Promise<void> => {
      await page.getByRole('button', { name: 'View options' }).click()
      await page.getByRole('menuitem', { name, exact: true }).click()
    }
    const captureSidebar = async (): Promise<string> => {
      await page.getByRole('button', { name: 'View options' }).hover()
      await expect.poll(() => page.getByRole('button', { name: /^Session actions for / }).count()).toBe(0)
      return captureStableAria(page, '[role="tree"][aria-label="Sessions"]', scaffold.workspaceCwd)
    }
    await expect.poll(titles).toEqual(TITLES)
    await compareOrRefreshGolden(
      join(SNAPSHOT_DIR, 'sidebar.expected.md'),
      await captureSidebar(), MODE,
    )
    await pick('Manual')
    await expect.poll(titles).toEqual(TITLES)
    await pick('Last updated')
    await expect.poll(titles).toEqual(TITLES)
    const source = page.getByRole('treeitem').filter({ has: page.getByText(TITLES[2]!, { exact: true }) })
    const target = page.getByRole('treeitem').filter({ has: page.getByText(TITLES[0]!, { exact: true }) })
    await source.dragTo(target, { targetPosition: { x: 30, y: 3 } })
    const dragged = [TITLES[2], TITLES[0], TITLES[1]]
    await expect.poll(titles).toEqual(dragged)
    const manualWarningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await expect.poll(titles).toEqual(dragged)
    acknowledgeReloadConnectionLoss(tripwire, manualWarningStart)
    await pick('Last updated')
    await expect.poll(titles).toEqual(TITLES)
    await pick('In one list')
    await expect.poll(titles).toEqual(TITLES)
    const recencyWarningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await expect.poll(titles).toEqual(TITLES)
    acknowledgeReloadConnectionLoss(tripwire, recencyWarningStart)
    await pick('Manual')
    await expect.poll(titles).toEqual(TITLES)
    await pick('Last updated')
    await pick('WorkSpace')
    await pick('Manual')
    const reconnectWarningStart = tripwire.warnings.length
    holdWorkspace = true
    await socket.close()
    await expect.poll(() => releaseWorkspace !== undefined).toBe(true)
    const workspaceTitle = basename(scaffold.workspaceCwd)
    await page.getByRole('treeitem').filter({ has: page.getByText(workspaceTitle, { exact: true }) }).hover()
    await page.getByRole('button', { name: `New session in ${workspaceTitle}` }).click()
    await pick('In one list')
    await expect.poll(titles).toEqual(['New Session', ...TITLES])
    await expect.poll(() => page.evaluate(() => {
      const { sessionId } = JSON.parse(localStorage.getItem('dsh.sessions.current')!) as { sessionId: string }
      const { sessionOrderByAccount } = JSON.parse(localStorage.getItem('dsh.workspace.view.v5')!) as {
        sessionOrderByAccount: Record<string, string[]>
      }
      return sessionOrderByAccount.__flat_session_order__?.[0] === sessionId
    })).toBe(true)
    holdWorkspace = false
    releaseWorkspace!()
    await pick('WorkSpace')
    acknowledgeReloadConnectionLoss(tripwire, reconnectWarningStart)
    await expect.poll(titles).toEqual(['New Session', ...TITLES])
    await compareOrRefreshGolden(
      join(SNAPSHOT_DIR, 'manual-blank.expected.md'),
      await captureSidebar(), MODE,
    )
    const blank = page.getByRole('treeitem').filter({ has: page.getByText('New Session', { exact: true }) })
    await expect.poll(() => blank.getAttribute('draggable')).toBe('false')
    const blankWarningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await expect.poll(titles).toEqual(['New Session', ...TITLES])
    acknowledgeReloadConnectionLoss(tripwire, blankWarningStart)
    await pick('Last updated')
    await expect.poll(titles).toEqual(['New Session', ...TITLES])
    await pick('Manual')
    await expect.poll(titles).toEqual(['New Session', ...TITLES])
    await assertFixtureInventory(SNAPSHOT_DIR, ['sidebar.expected.md', 'manual-blank.expected.md'])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
