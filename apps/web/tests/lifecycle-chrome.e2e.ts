// Web e2e scenarios: lifecycle & chrome — the workspace-aware first-send
// flow over the real wire, reload recovery, and the dark-mode token cascade.
// One tiny recorded turn (text-only) drives the whole spec: the empty-state
// hero materializes a real Workspace + Session on first send (the jsdom
// workspace-flow suite pins the object-layer state machine over the fixture
// client; THIS spec pins the same flow through HTTP RPC + WebSocket + the host
// gateway), reload replays everything from the log (zero further model
// calls), and the theme scenario proves the shipped dark palette actually
// cascades: attribute -> alias token flip -> painted surface change. No
// theme/layout golden: aria snapshots are color-blind (lane scope: the
// browser-e2e-lane Agent Note); the hero's waiting state gets the one golden
// here.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page, WebSocketRoute } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureExpandedTurnProcessAria,
  captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import {
  connectFreshWorkspace, expandOwningTurnProcess, newEnglishPage, saveFailureShot, writeComposerDraft, ZH_BROWSER_LOCALE,
} from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/lifecycle-chrome', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v3.jsonl')
const REPLAY_OVERRIDE = join(SNAPSHOT_DIR, 'replay.override.json')
const HERO_EXPECTED = join(SNAPSHOT_DIR, 'hero.expected.md')
const COMMAND_MENU_EXPECTED = join(SNAPSHOT_DIR, 'command-menu.expected.md')
const COMMAND_MENU_ZH_EXPECTED = join(SNAPSHOT_DIR, 'command-menu-zh.expected.md')
const FUZZY_COMMAND_MENU_EXPECTED = join(SNAPSHOT_DIR, 'command-menu-fuzzy.expected.md')
const PLAN_ACTIVE_EXPECTED = join(SNAPSHOT_DIR, 'plan-active.expected.md')
const CONNECTION_ERROR_EXPECTED = join(SNAPSHOT_DIR, 'connection-error.expected.md')
// Post-reload golden: the same settled conversation rebuilt purely from
// persistence + history — byte-equal rendering is exactly the recovery claim.
const RELOADED_EXPECTED = join(SNAPSHOT_DIR, 'reloaded.expected.md')
const RELOADED_EXPANDED_EXPECTED = join(SNAPSHOT_DIR, 'reloaded-expanded.expected.md')
const MODE = webSnapshotMode()

const PROMPT = 'Reply with the single word LIGHTHOUSE and stop.'
const REPLAY_PACE_MS = 100

describe('web e2e: lifecycle & chrome (workspace flow / reload / dark mode)', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold(MODE === 'record'
      ? {}
      : { replayFixture: FIXTURE, replayOverride: REPLAY_OVERRIDE, paceMs: REPLAY_PACE_MS })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // Fresh world: connect a Workspace so the composer scenarios start live.
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it.skipIf(MODE === 'record')('opens the shared slash menu from plus with only Command candidates', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-command-menu-launcher'))
    const input = page.locator('[data-composer-input]').first()
    onTestFinished(async () => {
      await input.press('Escape')
      await writeComposerDraft(page, input, '')
      await page.getByRole('listbox', { name: 'Trigger suggestions' }).waitFor({ state: 'hidden' })
    })
    const launcher = page.getByRole('button', { name: 'Add files or run commands' })
    await launcher.click()
    const menu = page.getByRole('listbox', { name: 'Trigger suggestions' })
    await menu.getByRole('option').first().waitFor({ timeout: 10_000 })
    await menu.getByRole('status').waitFor({ state: 'hidden', timeout: 10_000 })
    const snapshot = await captureStableAria(page, '[role="listbox"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(COMMAND_MENU_EXPECTED, snapshot, MODE)
    expect(snapshot).toContain('text: Add')
    expect(snapshot).toContain('text: Commands')
    expect(snapshot).not.toContain('text: Skills')
    expect(snapshot).not.toContain('text: Subagents')
    const launchedBox = await menu.boundingBox()
    await page.locator('[data-composer-input]').first().press('Escape')
    await expect.poll(() => menu.count()).toBe(0)
    await writeComposerDraft(page, input, '/')
    await menu.getByRole('option').first().waitFor({ timeout: 10_000 })
    await menu.getByRole('status').waitFor({ state: 'hidden', timeout: 10_000 })
    const typedBox = await menu.boundingBox()
    expect(launchedBox).not.toBeNull()
    expect(typedBox).not.toBeNull()
    expect(Math.abs(launchedBox!.x - typedBox!.x)).toBeLessThan(1)
    expect(Math.abs(
      launchedBox!.y + launchedBox!.height - typedBox!.y - typedBox!.height,
    )).toBeLessThan(1)
    await writeComposerDraft(page, input, '/cpt')
    await expect.poll(() => menu.getByRole('option').allTextContents()).toEqual([
      'CompactCompact older conversation history',
    ])
    const fuzzySnapshot = await captureStableAria(page, '[role="listbox"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(FUZZY_COMMAND_MENU_EXPECTED, fuzzySnapshot, MODE)
    await writeComposerDraft(page, input, '')
    await expect.poll(() => menu.count()).toBe(0)
  })

  it.skipIf(MODE === 'record')('localizes slash-command descriptions from the browser language', async () => {
    const zhPage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    const zhTripwire = watchConsole(zhPage)
    onTestFailed(() => saveFailureShot(zhPage, 'web-e2e-command-menu-zh'))
    try {
      await zhPage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await zhPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      const launcher = zhPage.getByRole('button', { name: '添加文件或调用指令' })
      await launcher.click()
      const menu = zhPage.getByRole('listbox', { name: '触发候选建议' })
      await menu.getByRole('option').first().waitFor({ timeout: 10_000 })
      await menu.getByRole('status').waitFor({ state: 'hidden', timeout: 10_000 })
      const snapshot = await captureStableAria(zhPage, '[role="listbox"]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(COMMAND_MENU_ZH_EXPECTED, snapshot, MODE)
      expect(zhTripwire.pageErrors).toEqual([])
      expect(zhTripwire.warnings).toEqual([])
    } finally {
      await zhPage.close()
    }
  })

  it.skipIf(MODE === 'record').each([
    { locale: 'en-US', token: '/goal', row: 'Goal Set or view the goal for a long-running task', hint: 'describe the objective for a long-running task' },
    { locale: 'en-US', token: '/plan', row: 'Plan Enter or leave plan mode', hint: 'describe your task to generate plan' },
    { locale: ZH_BROWSER_LOCALE, token: '/目标', row: '目标 goal 设置或查看长期任务目标', hint: '输入目标，智能体将持续执行' },
    { locale: ZH_BROWSER_LOCALE, token: '/计划', row: '计划 plan 进入或退出计划模式', hint: '描述你的任务以生成计划' },
  ])('keeps $token claimed across separator edits and hides hints during IME composition', async ({ locale, token, row, hint }) => {
    const inputPage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale })
    const inputTripwire = watchConsole(inputPage)
    onTestFailed(() => saveFailureShot(inputPage, `web-e2e-command-input-${locale}-${token.slice(1)}`))
    try {
      await inputPage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await inputPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      const input = inputPage.locator('[data-composer-input]').first()
      await writeComposerDraft(inputPage, input, '/')
      await inputPage.getByRole('listbox').getByRole('option', { name: row, exact: true }).click()
      await expect.poll(() => input.textContent()).toBe(`${token} `)
      await input.press('End')
      await inputPage.keyboard.insertText('这是任务')
      await expect.poll(() => input.textContent()).toBe(`${token} 这是任务`)
      for (let i = 0; i < 5; i++) await input.press('Backspace')
      const tokenText = () => input.locator('[data-lexical-text][style*="warn-label"]').textContent()
      await expect.poll(() => input.textContent()).toBe(token)
      await expect.poll(() => input.getAttribute('data-phase')).toBe('claimed')
      await expect.poll(tokenText).toBe(token)
      await input.press('Space')
      await expect.poll(() => input.getAttribute('data-phase')).toBe('claimed')
      await expect.poll(() => input.textContent()).toBe(`${token} `)
      await expect.poll(async () => (await tokenText())?.trimEnd()).toBe(token)
      const shownHint = () => input.locator('p').last().evaluate(element => getComputedStyle(element, '::after').content)
      await expect.poll(shownHint).toBe(JSON.stringify(hint))
      const cdp = await inputPage.context().newCDPSession(inputPage)
      await cdp.send('Input.imeSetComposition', { text: 'z', selectionStart: 1, selectionEnd: 1 })
      await expect.poll(shownHint).toBe('none')
      await cdp.send('Input.imeSetComposition', { text: 'zh', selectionStart: 2, selectionEnd: 2 })
      await expect.poll(shownHint).toBe('none')
      await cdp.send('Input.insertText', { text: '这' })
      await expect.poll(() => input.textContent()).toBe(`${token} 这`)
      await expect.poll(shownHint).toBe('none')
      await input.press('Backspace')
      await expect.poll(shownHint).toBe(JSON.stringify(hint))
      await cdp.send('Input.imeSetComposition', { text: 'z', selectionStart: 1, selectionEnd: 1 })
      await expect.poll(shownHint).toBe('none')
      await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
      await expect.poll(shownHint).toBe(JSON.stringify(hint))
      await input.press('Backspace')
      await input.press('Backspace')
      await expect.poll(() => input.getAttribute('data-phase')).toBe('plain')
      await writeComposerDraft(inputPage, input, '')
      const placeholder = inputPage.locator('[data-composer-placeholder]').first()
      await expect.poll(() => placeholder.isVisible()).toBe(true)
      await cdp.send('Input.imeSetComposition', { text: 'z', selectionStart: 1, selectionEnd: 1 })
      await expect.poll(() => placeholder.isVisible()).toBe(false)
      await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
      await expect.poll(() => placeholder.isVisible()).toBe(true)
      await cdp.detach()
      expect(inputTripwire.pageErrors).toEqual([])
      expect(inputTripwire.warnings).toEqual([])
    } finally {
      await inputPage.close()
    }
  })

  it.skipIf(MODE === 'record')('shows active Plan as the warn-state status action', async () => {
    const activeScaffold = await launchWebScaffold()
    const activePage = await newEnglishPage(browser)
    const activeTripwire = watchConsole(activePage)
    try {
      await activePage.goto(activeScaffold.authenticatedUrl, { waitUntil: 'load' })
      await activePage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await connectFreshWorkspace(activePage, activeScaffold.workspaceCwd)
      const input = activePage.locator('[data-composer-input]').first()
      await activePage.getByRole('button', { name: 'Add files or run commands' }).click()
      const menu = activePage.getByRole('listbox', { name: 'Trigger suggestions' })
      await menu.waitFor({ timeout: 10_000 })
      await menu.getByRole('option', { name: 'Plan Enter or leave plan mode' }).click()
      await expect.poll(() => input.textContent()).toBe('/plan ')
      await input.press('Enter')
      const planButton = activePage.getByRole('button', { name: 'Plan mode on, press to turn off' })
      await planButton.waitFor({ timeout: 10_000 })
      // The golden encodes an empty composer, and the button arriving does not
      // mean the submitted text is gone yet: under load the capture can catch
      // a textbox still holding `/plan`.
      await expect.poll(() => input.textContent(), { timeout: 10_000 }).toBe('')
      const planSnapshot = await captureStableAria(activePage, '[class*="frame"]', activeScaffold.workspaceCwd)
      await compareOrRefreshGolden(PLAN_ACTIVE_EXPECTED, planSnapshot, MODE)
      const planStyle = await planButton.evaluate((element) => {
        const probe = document.createElement('span')
        probe.style.color = 'var(--dsw-alias-state-warn-label)'
        probe.style.backgroundColor = 'var(--dsw-alias-state-warn-tertiary)'
        document.body.append(probe)
        const actual = getComputedStyle(element)
        const reference = getComputedStyle(probe)
        const result = {
          color: actual.color,
          backgroundColor: actual.backgroundColor,
          borderRadius: actual.borderRadius,
          fontSize: actual.fontSize,
          referenceColor: reference.color,
          referenceBackgroundColor: reference.backgroundColor,
        }
        probe.remove()
        return result
      })
      expect(planStyle.color).toBe(planStyle.referenceColor)
      expect(planStyle.backgroundColor).toBe(planStyle.referenceBackgroundColor)
      expect(planStyle.borderRadius).toBe('999px')
      expect(planStyle.fontSize).toBe('13px')
      await planButton.click()
      await expect.poll(() => planButton.count()).toBe(0)
      expect(activeTripwire.pageErrors).toEqual([])
      expect(activeTripwire.warnings).toEqual([])
    } catch (error) {
      await saveFailureShot(activePage, 'web-e2e-plan-active').catch(() => undefined)
      throw error
    } finally {
      await activePage.close()
      await activeScaffold.close()
    }
  })

  it('sends the first prompt from the empty-state hero (all modes)', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-lifecycle-send'))
    if (MODE !== 'record') {
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    }
    // The blank frame renders the hero, not the resident composer: the
    // headline plus the guidance placeholder are the empty state's anchors.
    await expect.poll(() => page.getByText('Into the Unknown', { exact: false }).count(), { timeout: 15_000 }).toBe(1)
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })
    if (MODE !== 'record') {
      await page.getByText('Into the Unknown', { exact: false }).hover()
      await expect.poll(() => page.getByRole('tooltip').count()).toBe(0)
      // Golden of the hero's stable waiting state (captured before any send;
      // the conversation-region goldens belong to the other scenarios).
      const snapshot = await captureStableAria(page, '[class*="frame"]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(HERO_EXPECTED, snapshot, MODE)
    }
    const settled = scaffold.whenTurnSettled()
    await writeComposerDraft(page, input, PROMPT)
    const observeTurn = async () => {
      const originalViewport = page.viewportSize() ?? { width: 1680, height: 1000 }
      if (MODE !== 'record') await page.setViewportSize({ width: 480, height: 1000 })
      const observedReasoning = Promise.withResolvers<undefined>()
      const releaseStream = MODE === 'record' ? undefined : scaffold.ctx.on('llm/stream', async function* (_options, next) {
        let reasoning = false
        for await (const chunk of next()) {
          if (reasoning && chunk.type !== 'reasoning-delta') {
            await observedReasoning.promise
          }
          if (chunk.type === 'reasoning-delta') reasoning = true
          yield chunk
        }
      })
      try {
        await input.press('Enter')
        if (MODE !== 'record') {
          const thinking = page.locator('[data-variant="think"][data-state="running"]')
          await expect.poll(() => thinking.getByRole('button').getAttribute('aria-expanded')).toBe('false')
          const liveTail = thinking.locator('[data-follow-end]')
          await expect.poll(async () => {
            if (await liveTail.count() !== 1) return false
            return await liveTail.evaluate((element) => {
              const text = element.firstElementChild
              if (!(text instanceof HTMLElement)) return false
              const viewport = element.getBoundingClientRect()
              const content = text.getBoundingClientRect()
              return content.width > viewport.width && Math.abs(content.right - viewport.right) <= 1
            })
          }, { timeout: 10_000, interval: 10 }).toBe(true)
        }
        observedReasoning.resolve(undefined)
        return await settled
      } finally {
        observedReasoning.resolve(undefined)
        releaseStream?.()
        if (MODE !== 'record') await page.setViewportSize(originalViewport)
      }
    }
    const sessionId = await observeTurn()
    if (MODE === 'record') {
      await recordFixture(scaffold, sessionId, FIXTURE)
    }
  }, 200_000)

  it.skipIf(MODE === 'record')('materialized a real Workspace and Session over the wire', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-lifecycle-materialize'))
    // Browser: the sidebar tree now carries the auto-created workspace group
    // with its one session, and the opened session is the selected row. The
    // compact layout dropped group session counts, so the group row itself is
    // the barrier.
    await expect.poll(
      () => page.locator('[role="treeitem"][aria-expanded]').filter({ hasText: 'workspace' }).count(),
      { timeout: 15_000 },
    ).toBeGreaterThanOrEqual(1)
    await expect.poll(() => page.locator('[role="treeitem"][aria-selected="true"]').count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => page.getByText('LIGHTHOUSE', { exact: true }).count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    // The usage pill's one label span concatenates the billed total and the cache-hit share.
    await expect.poll(() => page.getByRole('button', { name: /Cache hit 99\.5%/ }).count(), { timeout: 15_000 }).toBe(1)
    // Host: the session's durable header cwd is the folder the workspace
    // flow created and adopted (<workspaceCwd>/workspace) — the proof the
    // send went through workspace materialization rather than a bare
    // default-cwd session.
    const cwds = scaffold.ctx.sessions.list().map(session => session.header.cwd)
    expect(cwds).toEqual([join(scaffold.workspaceCwd, 'workspace')])
    const turnEnds = sessionEvents.filter(e => e.type === 'turn/end')
    expect(turnEnds).toHaveLength(1)
    expect((turnEnds[0] as SessionEvent & { data: { reason: { kind: string } } }).data.reason.kind).toBe('completed')
  }, 60_000)

  it.skipIf(MODE === 'record')('pins an open Think header to the conversation scrollport (real layout)', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-think-sticky'))
    // The settled turn collapses its process row, which hides the Think row.
    // The fixture's recorded reasoning is one line, too short to overflow the
    // scrollport, so this case proves the CSS resolves onto the Think header in
    // a real browser (jsdom computes no sticky layout); the pinned-while-
    // scrolling and z-rank evidence belongs to the compaction path in
    // seeded-history.e2e.ts, whose summary length that suite controls.
    const thinkRow = page.locator('[data-variant="think"]').first()
    await thinkRow.waitFor({ state: 'attached', timeout: 15_000 })
    const process = page.locator('[data-turn-process]').first()
    const processWasOpen = await process.getAttribute('aria-expanded') === 'true'
    try {
      await expandOwningTurnProcess(page, thinkRow)
      const collapsedHeader = thinkRow.locator('[data-disclosure-row]').first()
      await collapsedHeader.waitFor({ timeout: 10_000 })
      // Collapsed, the rule's `data-open` gate is absent and the header stays in
      // flow. It is `relative` here — the row is the sweep-glare overlay anchor
      // — so the assertion is the absence of `sticky`, not a specific value.
      expect(await collapsedHeader.evaluate(element => getComputedStyle(element).position)).not.toBe('sticky')
      await collapsedHeader.click()
      const openHeader = page.locator('[data-variant="think"] [data-open] [data-disclosure-row]').first()
      await openHeader.waitFor({ timeout: 10_000 })
      const openStyle = await openHeader.evaluate((element) => {
        const style = getComputedStyle(element)
        return { position: style.position, top: style.top }
      })
      expect(openStyle.position).toBe('sticky')
      expect(openStyle.top).toBe('0px')
    } finally {
      // Restore the settled state the reload goldens below are captured in.
      const openThinkRow = page.locator('[data-variant="think"] [data-open] [data-disclosure-row]')
      if (await openThinkRow.count() > 0) await openThinkRow.first().click()
      if (!processWasOpen && await process.getAttribute('aria-expanded') === 'true') await process.click()
    }
    await expect.poll(() => page.locator('[data-variant="think"] [data-open]').count(), { timeout: 5_000 }).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('recovers the whole surface across a reload from the log alone', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-lifecycle-reload'))
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    // Selection persisted (dsh.sessions.current) and history replayed: the
    // recorded turn re-renders from a Session Controller page with zero model calls —
    // the replay cursor was fully consumed before the reload, so any stray
    // request would fail the scenario loudly at close().
    await expect.poll(() => page.getByText('LIGHTHOUSE', { exact: true }).count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    await expect.poll(() => page.locator('[role="treeitem"][aria-selected="true"]').count(), { timeout: 10_000 }).toBe(1)
    // Golden of the recovered conversation region: rebuilt from the log, it
    // must render the same settled transcript the live turn produced.
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(RELOADED_EXPECTED, snapshot, MODE)
    const expanded = await captureExpandedTurnProcessAria(
      page,
      '[class*="centerCol"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(RELOADED_EXPANDED_EXPECTED, expanded, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it.skipIf(MODE === 'record')('cascades the dark theme from the body attribute to painted surfaces', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-lifecycle-dark'))
    // This scenario pins the ThemeRuntime's DOM contract directly (the
    // body[data-ds-dark-theme] attribute -> stylesheet cascade); the REAL
    // user gesture above it (Settings -> Appearance cubes) is owned by
    // settings-chrome.e2e.ts. Driving the attribute here keeps the cascade
    // pinned independently of the settings surface's own lifecycle.
    const sample = async (): Promise<{ token: string; sidebarBg: string; bodyBg: string }> =>
      await page.evaluate(() => {
        const sidebar = document.querySelector('[class*="sidebar"], [class*="rail"]') ?? document.body
        return {
          token: getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim(),
          sidebarBg: getComputedStyle(sidebar).backgroundColor,
          bodyBg: getComputedStyle(document.body).backgroundColor,
        }
      })
    const light = await sample()
    await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', '') })
    const dark = await sample()
    // The alias token itself must flip — the cascade's root fact.
    expect(dark.token).not.toBe(light.token)
    // And a real painted surface must consume it (not just variables in a
    // void): at least one of the sampled backgrounds repaints.
    expect(dark.sidebarBg !== light.sidebarBg || dark.bodyBg !== light.bodyBg).toBe(true)
    // Removing the attribute restores the light values exactly (the palettes
    // live in one stylesheet; activation is attribute-only by design).
    await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme') })
    const restored = await sample()
    expect(restored).toEqual(light)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('shows automatic and user-requested connection recovery beside Settings', async () => {
    const recoveryPage = await newEnglishPage(browser)
    const recoveryTripwire = watchConsole(recoveryPage)
    const sockets: WebSocketRoute[] = []
    let rejectConnections = false
    let holdConnections = false
    await recoveryPage.routeWebSocket('**/api/remote.mux', (route) => {
      sockets.push(route)
      if (rejectConnections || holdConnections) return
      route.connectToServer()
    })
    onTestFailed(() => saveFailureShot(recoveryPage, 'web-e2e-connection-recovery'))
    try {
      await recoveryPage.clock.install()
      await recoveryPage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await recoveryPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await expect.poll(() => sockets.length).toBe(1)
      rejectConnections = true
      await recoveryPage.context().setOffline(true)
      await expect.poll(() => recoveryPage.evaluate(() => navigator.onLine)).toBe(false)
      const offline = recoveryPage.getByRole('button', {
        name: 'Disconnected, reconnect now', exact: true,
      })
      await offline.waitFor({ timeout: 2_000 })
      await recoveryPage.clock.fastForward(60_000)
      expect(sockets).toHaveLength(1)

      await recoveryPage.context().setOffline(false)
      await expect.poll(() => recoveryPage.evaluate(() => navigator.onLine)).toBe(true)
      const connecting = recoveryPage.getByRole('button', {
        name: 'Reconnecting, reconnect now', exact: true,
      })
      await connecting.waitFor({ timeout: 10_000 })
      expect(await connecting.innerText()).toMatch(/^Reconnecting\.{1,3}$/)
      const connectingGeometry = await connectionIndicatorGeometry(connecting)
      expect(await connectionIndicatorTextAlignment(connecting)).toBe('left')
      // Hover keeps the state label; the pill never swaps copy or resizes.
      await connecting.hover()
      expect(await connecting.innerText()).toMatch(/^Reconnecting\.{1,3}$/)
      expect(await connectionIndicatorGeometry(connecting)).toEqual(connectingGeometry)
      await recoveryPage.mouse.move(0, 0)

      for (let count = 2; count <= 9; count++) {
        await recoveryPage.clock.fastForward(10_000)
        await expect.poll(() => sockets.length).toBe(count)
        if (count === 2) {
          await recoveryPage.clock.fastForward(1_000)
          expect(sockets).toHaveLength(count)
        }
        await sockets.at(-1)!.close({ code: 4001, reason: 'connection recovery test' })
        // Drain the close event's promise continuations before advancing the next retry timer.
        await recoveryPage.evaluate(() => {})
      }
      const indicator = connecting
      expect(await connectionIndicatorGeometry(indicator)).toEqual(connectingGeometry)
      expect(await connectionIndicatorTextAlignment(indicator)).toBe('left')
      const snapshot = await captureStableAria(recoveryPage, '[class*="footArea"]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(CONNECTION_ERROR_EXPECTED, snapshot, MODE)
      const expectedColors = await recoveryPage.evaluate(() => {
        const probe = document.createElement('span')
        probe.style.color = 'var(--dsw-alias-state-warn-label)'
        probe.style.backgroundColor = 'var(--dsw-alias-state-warn-tertiary)'
        document.body.append(probe)
        const reference = getComputedStyle(probe)
        const result = {
          background: reference.backgroundColor,
          color: reference.color,
        }
        probe.remove()
        return result
      })
      // CSS transitions use the browser's animation clock independently of the mocked retry timers.
      await expect.poll(() => indicator.evaluate((element) => {
        const actual = getComputedStyle(element)
        return { background: actual.backgroundColor, color: actual.color }
      })).toEqual(expectedColors)
      expect(await indicator.locator('svg').count()).toBe(1)
      expect(await indicator.getAttribute('title')).toBeNull()
      rejectConnections = false
      await recoveryPage.clock.fastForward(10_000)
      await expect.poll(() => sockets.length).toBe(10)
      const automaticRecovery = recoveryPage.getByRole('status')
      await automaticRecovery.waitFor({ timeout: 10_000 })
      expect(await automaticRecovery.innerText()).toBe('Connected')
      await recoveryPage.clock.fastForward(2_000)
      await automaticRecovery.waitFor({ state: 'detached' })

      holdConnections = true
      await sockets.at(-1)!.close({ code: 4001, reason: 'manual recovery test' })
      await connecting.waitFor()
      await recoveryPage.clock.fastForward(500)
      await expect.poll(() => sockets.length).toBe(11)
      await indicator.hover()
      expect(await indicator.innerText()).toMatch(/^Reconnecting\.{1,3}$/)
      const hoverBackground = await indicator.evaluate(element => getComputedStyle(element).backgroundColor)
      await recoveryPage.mouse.down()
      await expect.poll(() => indicator.evaluate(element => getComputedStyle(element).backgroundColor))
        .not.toBe(hoverBackground)
      holdConnections = false
      await recoveryPage.mouse.up()

      await expect.poll(() => sockets.length).toBe(12)
      const recovered = recoveryPage.getByRole('status')
      await recovered.waitFor({ timeout: 10_000 })
      expect(await recovered.innerText()).toBe('Connected')
      // The pill sizes to its current label; chrome height and icon box stay fixed.
      const recoveredGeometry = await connectionIndicatorGeometry(recovered)
      expect(recoveredGeometry.outer[3]).toBe(connectingGeometry.outer[3])
      expect(recoveredGeometry.icon).toEqual(connectingGeometry.icon)
      expect(await connectionIndicatorTextAlignment(recovered)).toBe('left')
      await recoveryPage.clock.fastForward(2_000)
      await recovered.waitFor({ state: 'detached', timeout: 5_000 })
      expect(recoveryTripwire.pageErrors).toEqual([])
      expect(recoveryTripwire.warnings.filter(warning => /connection lost, retry #/i.test(warning)))
        .toHaveLength(11)
    } finally {
      await recoveryPage.close()
    }
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'session.v3.jsonl', 'replay.override.json', 'command-menu.expected.md',
      'command-menu-fuzzy.expected.md', 'command-menu-zh.expected.md', 'connection-error.expected.md',
      'hero.expected.md', 'plan-active.expected.md',
      'reloaded.expected.md', 'reloaded-expanded.expected.md',
    ])
  })
})

async function connectionIndicatorGeometry(locator: ReturnType<Page['getByRole']>): Promise<{
  readonly outer: readonly number[]
  readonly icon: readonly number[]
  readonly label: readonly number[]
}> {
  return await locator.evaluate((element) => {
    const outer = element.getBoundingClientRect()
    const icon = element.children.item(0)?.getBoundingClientRect()
    const label = element.children.item(1)?.getBoundingClientRect()
    if (icon === undefined || label === undefined) throw new Error('connection indicator children missing')
    const rounded = (values: readonly number[]): readonly number[] => values.map(value => Math.round(value * 100) / 100)
    return {
      outer: rounded([outer.x, outer.y, outer.width, outer.height]),
      icon: rounded([icon.x - outer.x, icon.y - outer.y, icon.width, icon.height]),
      label: rounded([label.x - outer.x, label.y - outer.y, label.width, label.height]),
    }
  })
}

async function connectionIndicatorTextAlignment(
  locator: ReturnType<Page['getByRole']>,
): Promise<string> {
  return await locator.evaluate((element) => {
    const label = element.children.item(1)
    if (label === null) throw new Error('connection indicator label missing')
    return getComputedStyle(label).textAlign
  })
}
