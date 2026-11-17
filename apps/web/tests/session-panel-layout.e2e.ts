/**
 * Session panel layout in the shipped Web composition. The panel's stylesheet
 * decides whether the Chat View's end gutter holds the docked panel, or the
 * transcript can make that room for a pinned panel, and tells the plugin
 * through two 1px probes, and it lays out the rows that contributors mark.
 * jsdom cannot evaluate that stylesheet, so this measures the probes, the
 * panel, and the toggle around the docking boundary, the transcript, the
 * composer, and the width handles around a pinned panel, the drag that
 * reorders sections, and the working folder row without and with a directory
 * context menu.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v3.jsonl', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = brandString<SessionId>('session-panel-layout-web-e2e')
/** The default transcript width in a frame wide enough to dock. */
const TRANSCRIPT = 880
/** The gutter that holds the docked panel: 40px clear of the transcript, its 300px minimum width, and the 8px edge inset. */
const DOCK_GUTTER = 348

/** What the layout says about docking: the gutter, the probe, the panel's presentation and insets, and the toggle. */
function docking(page: Page) {
  return page.evaluate(() => {
    const layer = document.querySelector<HTMLElement>('[data-chat-aside]')
    const column = document.querySelector<HTMLElement>('[data-chat-flow]')
    const probe = document.querySelector<HTMLElement>('[data-session-panel-probe="gutter"]')
    const toggle = document.querySelector<HTMLElement>('[data-session-panel-toggle]')
    if (layer === null || column === null || probe === null || toggle === null) {
      throw new Error('aside layer, transcript column, dock probe, or panel toggle is missing')
    }
    const frame = layer.getBoundingClientRect()
    const flow = column.getBoundingClientRect()
    const panel = document.querySelector<HTMLElement>('[data-session-panel]')
    const box = panel?.getBoundingClientRect()
    return {
      gutter: (frame.width - flow.width) / 2,
      probe: probe.getBoundingClientRect().width,
      presentation: panel?.dataset['sessionPanel'] ?? null,
      expanded: toggle.getAttribute('aria-expanded'),
      panel: box === undefined ? null : { width: box.width, clear: box.left - flow.right, edge: frame.right - box.right },
    }
  })
}

/** Open the seeded Session through the sidebar and wait for the panel's dock probe. */
async function openSeed(page: Page): Promise<void> {
  const session = page.locator(`[data-row-key="session:${SEED_ID}"]`)
  await expect.poll(async () => {
    if (await session.isVisible()) return true
    const group = page.locator('[role="treeitem"][aria-expanded]').first()
    if (await group.count() > 0 && await group.getAttribute('aria-expanded') === 'false') await group.click()
    return session.isVisible()
  }, { timeout: 15_000 }).toBe(true)
  await session.click()
  await page.locator('[data-session-panel-probe="gutter"]').waitFor({ state: 'attached', timeout: 30_000 })
}

/**
 * What the layout says around a pinned panel: the frame and the transcript
 * column in it, the scrollport's end inset, how far the composer card's
 * center sits from the column's, the width handles, both probes, the panel,
 * and its pin. `pin.center` is the glyph column's distance from the panel's
 * end edge and `pin.top` the button's from its top edge.
 */
function pinning(page: Page) {
  return page.evaluate(() => {
    const need = (selector: string): HTMLElement => {
      const element = document.querySelector<HTMLElement>(selector)
      if (element === null) throw new Error(`${selector} is missing`)
      return element
    }
    const frame = need('[data-chat-aside]').getBoundingClientRect()
    const flow = need('[data-chat-flow]').getBoundingClientRect()
    const card = need('[data-composer-card]').getBoundingClientRect()
    const panel = document.querySelector<HTMLElement>('[data-session-panel]')
    const box = panel?.getBoundingClientRect()
    const pin = panel?.querySelector<HTMLElement>('[data-session-panel-pin]')
    const pinBox = pin?.getBoundingClientRect()
    return {
      frame: frame.width,
      column: flow.width,
      before: flow.left - frame.left,
      after: frame.right - flow.right,
      inset: getComputedStyle(need('[data-conversation-scroll]')).paddingInlineEnd,
      composerOffset: (card.left + card.right - flow.left - flow.right) / 2,
      handles: [...document.querySelectorAll<HTMLElement>('[data-width-handle]')].map(handle => handle.getBoundingClientRect().width),
      probes: {
        gutter: need('[data-session-panel-probe="gutter"]').getBoundingClientRect().width,
        reserve: need('[data-session-panel-probe="reserve"]').getBoundingClientRect().width,
      },
      presentation: panel?.dataset['sessionPanel'] ?? null,
      expanded: need('[data-session-panel-toggle]').getAttribute('aria-expanded'),
      panel: box === undefined ? null : { width: box.width, clear: box.left - flow.right, edge: frame.right - box.right },
      pin: pin === null || pin === undefined || pinBox === undefined || box === undefined
        ? null
        : {
          pressed: pin.getAttribute('aria-pressed'),
          target: [pinBox.width, pinBox.height],
          center: box.right - (pinBox.left + pinBox.width / 2),
          top: pinBox.top - box.top,
        },
    }
  })
}

/** Wait until the panel shows this way (null: not at all) and its entrance has finished. */
async function shows(page: Page, presentation: 'docked' | 'overlay' | null): Promise<void> {
  await expect.poll(async () => (await docking(page)).presentation, { timeout: 10_000 }).toBe(presentation)
  if (presentation === null) return
  await page.locator('[data-session-panel]').evaluate(async (element) => {
    await Promise.all(element.getAnimations().map(animation => animation.finished))
  })
}

/**
 * The working folder row as laid out: its line, how far the centers of its
 * icon and menu columns sit from its edges, the room after its text, and what
 * the pointer state shows. `menu` is null while the menu part renders nothing.
 */
function rowLayout(page: Page) {
  return page.locator('[data-session-panel] [data-session-panel-project]').evaluate((element) => {
    const box = element.getBoundingClientRect()
    const icon = element.querySelector('[data-row-part="icon"]')!.getBoundingClientRect()
    const content = element.querySelector('[data-row-part="content"]')!
    const menu = element.querySelector<HTMLElement>('[data-row-part="menu"]')!
    const column = menu.getBoundingClientRect()
    const button = menu.querySelector('button')?.getBoundingClientRect()
    return {
      height: box.height,
      iconCenter: icon.left + icon.width / 2 - box.left,
      iconSize: [icon.width, icon.height],
      clipped: getComputedStyle(content).textOverflow,
      afterText: box.right - content.getBoundingClientRect().right,
      menu: button === undefined
        ? null
        : {
          center: box.right - (column.left + column.width / 2),
          target: [button.width, button.height],
          opacity: getComputedStyle(menu).opacity,
        },
      hovered: element.matches(':hover'),
      highlighted: getComputedStyle(element).backgroundColor !== 'rgba(0, 0, 0, 0)',
    }
  })
}

describe.skipIf(MODE === 'record')('web e2e: Session panel layout', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  /** Viewport width the application keeps outside the Chat frame. */
  let chrome = 0

  /** Resize the window so the Chat View's end gutter is exactly `gutter`, and wait for the layout to follow. */
  async function setGutter(gutter: number): Promise<void> {
    await page.setViewportSize({ width: TRANSCRIPT + 2 * gutter + chrome, height: page.viewportSize()!.height })
    await expect.poll(async () => (await docking(page)).gutter, { timeout: 10_000 }).toBe(gutter)
  }

  /**
   * Resize the window so the Chat frame is exactly `width` wide, and wait for
   * the layout to follow: the body publishes the scrollport's width a frame
   * after the resize, and the end inset derives from it.
   */
  async function setFrame(width: number): Promise<void> {
    await page.setViewportSize({ width: width + chrome, height: page.viewportSize()!.height })
    await expect.poll(() => page.evaluate(() => {
      const body = document.querySelector<HTMLElement>('[data-conversation-content]')
      const scroll = document.querySelector<HTMLElement>('[data-conversation-scroll]')
      const frame = document.querySelector<HTMLElement>('[data-chat-aside]')
      if (body === null || scroll === null || frame === null) return null
      const published = body.style.getPropertyValue('--dsh-conversation-viewport-width')
      return published === `${scroll.clientWidth}px` ? frame.getBoundingClientRect().width : null
    }), { timeout: 10_000 }).toBe(width)
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    await seedSession(scaffold, await readFile(FIXTURE, 'utf8'), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  }, 120_000)

  /** Open the seeded Session and learn how much of the window lies outside the Chat frame. */
  async function openSession(): Promise<void> {
    if (chrome !== 0) return
    await openSeed(page)
    const frame = await page.locator('[data-chat-aside]').evaluate(element => element.getBoundingClientRect().width)
    chrome = page.viewportSize()!.width - frame
  }

  afterAll(async () => {
    const failures: unknown[] = []
    try { await browser?.close() } catch (error) { failures.push(error) }
    try { await scaffold?.close() } catch (error) { failures.push(error) }
    if (failures.length > 0) throw new AggregateError(failures, 'Session panel layout teardown failed')
  })

  it('docks exactly from the gutter that holds the panel at its minimum width', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-panel-dock'))
    await openSession()
    expect(Number.isInteger(chrome)).toBe(true)

    await setGutter(DOCK_GUTTER - 1)
    await shows(page, null)
    expect(await docking(page)).toEqual({ gutter: DOCK_GUTTER - 1, probe: 0, presentation: null, expanded: 'false', panel: null })

    // Half a pixel short, the probe is half a pixel wide and the panel stays hidden.
    await setGutter(DOCK_GUTTER - 0.5)
    expect(await docking(page)).toEqual({ gutter: DOCK_GUTTER - 0.5, probe: 0.5, presentation: null, expanded: 'false', panel: null })

    await setGutter(DOCK_GUTTER)
    await shows(page, 'docked')
    expect(await docking(page)).toEqual({
      gutter: DOCK_GUTTER, probe: 1, presentation: 'docked', expanded: 'true', panel: { width: 300, clear: 40, edge: 8 },
    })

    // A wider gutter widens the panel to its maximum at the same edge inset; the probe stays 1px.
    await setGutter(DOCK_GUTTER + 100)
    expect(await docking(page)).toEqual({
      gutter: DOCK_GUTTER + 100, probe: 1, presentation: 'docked', expanded: 'true', panel: { width: 360, clear: 80, edge: 8 },
    })

    await setGutter(DOCK_GUTTER - 1)
    await shows(page, null)
    expect((await docking(page)).expanded).toBe('false')
    expect(tripwire.pageErrors).toEqual([])
  })

  it('floats narrower than it docks, at the same edge inset, and docks once the gutter holds it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-panel-overlay'))
    await openSession()
    const toggle = page.locator('[data-session-panel-toggle]')
    await setGutter(260)
    await shows(page, null)
    await toggle.click()
    await shows(page, 'overlay')
    const overlay = await docking(page)
    expect(overlay).toMatchObject({ probe: 0, presentation: 'overlay', expanded: 'true', panel: { width: 280, edge: 8 } })
    // The overlay covers part of the transcript instead of keeping clear of it.
    expect(overlay.panel?.clear).toBeLessThan(0)

    await page.keyboard.press('Escape')
    await shows(page, null)
    expect((await docking(page)).expanded).toBe('false')

    // An open overlay gives way to the docked panel when the window widens enough.
    await toggle.click()
    await shows(page, 'overlay')
    await setGutter(DOCK_GUTTER)
    await shows(page, 'docked')
    expect(await docking(page)).toMatchObject({ probe: 1, expanded: 'true', panel: { width: 300, clear: 40, edge: 8 } })
    expect(tripwire.pageErrors).toEqual([])
  })

  it('has the transcript make room for a pinned panel, down to a 480px column, and gives the room back when unpinned', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-panel-pin'))
    await openSession()
    const toggle = page.locator('[data-session-panel-toggle]')
    const pin = page.locator('[data-session-panel] [data-session-panel-pin]')
    const stored = (): Promise<string | null> => page.evaluate(() => localStorage.getItem('dsh.sessionPanel.held'))
    /** Press the scrollport's start corner, outside the panel and off the transcript. */
    const pressOutside = (): Promise<void> => page.locator('[data-conversation-scroll]').click({ position: { x: 8, y: 8 } })
    const held = { presentation: 'docked', expanded: 'true', panel: { width: 300, clear: 40, edge: 8 } }
    const pressed = { pressed: 'true', target: [24, 24], center: 22, top: 10 }

    // A 260px gutter: the 880px column leaves no room to dock, and the transcript could make it.
    await setFrame(TRANSCRIPT + 2 * 260)
    await shows(page, null)
    expect(await pinning(page)).toMatchObject({
      column: TRANSCRIPT, before: 260, after: 260, inset: '0px', handles: [10, 10], probes: { gutter: 0, reserve: 1 }, expanded: 'false',
    })
    await toggle.click()
    await shows(page, 'overlay')
    // The pin sits on the first title line, its glyph in the column of the rows' More buttons: 8px of panel inset and 14px.
    expect((await pinning(page)).pin).toEqual({ ...pressed, pressed: 'false' })
    expect(await stored()).toBeNull()

    // Pinned, the panel docks: the column and the composer move aside by the missing 88px, twice over, and keep their width.
    await pin.click()
    await shows(page, 'docked')
    expect(await pinning(page)).toEqual({
      frame: TRANSCRIPT + 2 * 260, column: TRANSCRIPT, before: 172, after: DOCK_GUTTER, inset: '176px', composerOffset: 0,
      handles: [0, 0], probes: { gutter: 0, reserve: 1 }, ...held, pin: pressed,
    })
    expect(await stored()).toBe('true')
    // Neither an outside press nor Escape closes it.
    await pressOutside()
    await page.keyboard.press('Escape')
    expect(await pinning(page)).toMatchObject(held)

    // The start gutter is down to the transcript's 32px side inset: the column narrows instead.
    await setFrame(1000)
    expect(await pinning(page)).toMatchObject({ column: 620, before: 32, after: DOCK_GUTTER, inset: '316px', composerOffset: 0, ...held })
    // The narrowest frame that makes room leaves a 480px column.
    await setFrame(860)
    expect(await pinning(page)).toMatchObject({ column: 480, before: 32, after: DOCK_GUTTER, inset: '316px', ...held })
    // One pixel less makes none: the transcript centers again and the panel is left to the overlay.
    await setFrame(859)
    await shows(page, null)
    expect(await pinning(page)).toMatchObject({
      column: 680, before: 89.5, after: 89.5, inset: '0px', handles: [10, 10], probes: { gutter: 0, reserve: 0 }, expanded: 'false', panel: null,
    })
    await toggle.click()
    await shows(page, 'overlay')
    expect(await pinning(page)).toMatchObject({ inset: '0px', panel: { width: 280, edge: 8 }, pin: pressed })
    await page.keyboard.press('Escape')
    await shows(page, null)
    // Once the frame makes room again, the pinned panel docks without the toggle.
    await setFrame(860)
    await shows(page, 'docked')
    expect(await pinning(page)).toMatchObject({ column: 480, after: DOCK_GUTTER, ...held })

    // The pin survives a reload: the panel comes back beside the transcript.
    await setFrame(TRANSCRIPT + 2 * 260)
    await page.reload({ waitUntil: 'load' })
    await openSeed(page)
    await shows(page, 'docked')
    expect(await pinning(page)).toMatchObject({ column: TRANSCRIPT, before: 172, after: DOCK_GUTTER, inset: '176px', ...held, pin: pressed })

    // The toggle hides a pinned panel, which gives the room back, and shows it again.
    await toggle.click()
    await shows(page, null)
    expect(await pinning(page)).toMatchObject({ before: 260, after: 260, inset: '0px', handles: [10, 10], expanded: 'false' })
    await toggle.click()
    await shows(page, 'docked')
    expect(await pinning(page)).toMatchObject({ before: 172, after: DOCK_GUTTER, inset: '176px', handles: [0, 0], ...held })

    // A gutter that holds the panel by itself needs no room made: the transcript stays centered and keeps its handles.
    await setFrame(TRANSCRIPT + 2 * (DOCK_GUTTER + 100))
    expect(await pinning(page)).toMatchObject({
      before: DOCK_GUTTER + 100, after: DOCK_GUTTER + 100, inset: '0px', handles: [10, 10], probes: { gutter: 1, reserve: 1 },
      presentation: 'docked', panel: { width: 360, clear: 80, edge: 8 }, pin: pressed,
    })

    // Unpinned where only the pin held it, the panel stays open as the overlay, which an outside press closes.
    await setFrame(TRANSCRIPT + 2 * 260)
    await shows(page, 'docked')
    await pin.click()
    await shows(page, 'overlay')
    expect(await pinning(page)).toMatchObject({
      before: 260, after: 260, inset: '0px', handles: [10, 10], expanded: 'true', panel: { width: 280, edge: 8 },
      pin: { ...pressed, pressed: 'false' },
    })
    expect(await stored()).toBe('false')
    await pressOutside()
    await shows(page, null)
    expect(tripwire.pageErrors).toEqual([])
  })

  it('reorders sections by dragging a title row or with the arrow keys on its handle, and keeps the order across a reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-panel-order'))
    await openSession()
    await setGutter(DOCK_GUTTER + 100)
    await shows(page, 'docked')
    // Give the Session a subagent and a running background job, so the panel shows three sections.
    const agent = scaffold.ctx.agents.get(SEED_ID)
    if (agent === undefined) throw new Error('the seeded Session has no live Agent')
    const release = Promise.withResolvers<{ status: 'completed' }>()
    onTestFinished(() => { release.resolve({ status: 'completed' }) })
    agent.session.append('subagent/catalog', {
      version: 2, childId: brandString<SessionId>('session-panel-layout-external'), childCreatedAt: Date.now(), mode: 'external',
      label: 'Review the docking rules',
    })
    scaffold.ctx.jobs.start({
      kind: 'bash', label: 'pnpm run build', owner: agent.id,
      run: () => ({ done: release.promise, cancel: () => { release.resolve({ status: 'completed' }) } }),
    })
    const panel = page.locator('[data-session-panel]')
    const section = (id: string) => panel.locator(`[data-session-panel-section="${id}"]`)
    const head = (id: string) => section(id).locator('h2').locator('..')
    const grip = (id: string) => section(id).locator('[data-session-panel-grip]')
    /** The ids of the sections that show, top to bottom. */
    const order = (): Promise<(string | null)[]> => panel.evaluate(element => [...element.querySelectorAll('[data-session-panel-section]')]
      .filter(node => getComputedStyle(node).display !== 'none').map(node => node.getAttribute('data-session-panel-section')))
    const stored = async (): Promise<unknown> =>
      JSON.parse(await page.evaluate(() => localStorage.getItem('dsh.sessionPanel.sectionOrder')) ?? 'null')
    const registered = ['environment', 'subagents', 'background-jobs']
    await expect.poll(order, { timeout: 20_000 }).toEqual(registered)

    // At rest the handle does not show and takes no room: the title's trailing count runs to the row's 6px padding.
    // Over the title row the handle shows on the rows' More column, and the count stays where it was and fades under it.
    await page.mouse.move(5, 5)
    const handle = (id: string) => head(id).evaluate((element) => {
      const button = element.querySelector<HTMLElement>('[data-session-panel-grip]')!
      const trailing = element.children[1] as HTMLElement
      const box = element.getBoundingClientRect()
      const target = button.getBoundingClientRect()
      return {
        cursor: getComputedStyle(element).cursor,
        opacity: getComputedStyle(button).opacity,
        target: [target.width, target.height],
        center: box.right - (target.left + target.width / 2),
        trailing: trailing.textContent,
        trailingEnd: box.right - trailing.getBoundingClientRect().right,
        faded: getComputedStyle(trailing).maskImage !== 'none',
      }
    })
    const resting = { cursor: 'grab', target: [24, 24], center: 14, trailing: '1 external', trailingEnd: 6 }
    expect(await handle('subagents')).toEqual({ ...resting, opacity: '0', faded: false })
    await head('subagents').hover()
    await expect.poll(async () => (await handle('subagents')).opacity).toBe('1')
    expect(await handle('subagents')).toEqual({ ...resting, opacity: '1', faded: true })
    expect(await grip('background-jobs').evaluate(element => getComputedStyle(element).opacity)).toBe('0')

    // Drag Background jobs by its title row onto the upper half of Environment.
    const from = (await head('background-jobs').boundingBox())!
    const onto = (await section('environment').boundingBox())!
    await page.mouse.move(from.x + 40, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + 40, from.y - 12, { steps: 4 })
    await page.mouse.move(onto.x + 40, onto.y + 6, { steps: 8 })
    // A move onto a new element reports only the enter and the leave; one more within it reports the drag over it.
    await page.mouse.move(onto.x + 42, onto.y + 6)
    const marks = () => panel.evaluate(element => [...element.querySelectorAll<HTMLElement>('[data-session-panel-section]')]
      .filter(node => getComputedStyle(node).display !== 'none')
      .map(node => [node.dataset['sessionPanelSection'], node.hasAttribute('data-dragging'), node.dataset['dropTarget'] ?? null]))
    await expect.poll(marks).toEqual([['environment', false, 'before'], ['subagents', false, null], ['background-jobs', true, null]])
    // The landing line: 2px in the accent color on Environment's top edge; the dragged section dims.
    const line = await section('environment').evaluate((element) => {
      const style = getComputedStyle(element, '::after')
      return { height: style.height, top: style.top, painted: style.backgroundColor !== 'rgba(0, 0, 0, 0)' }
    })
    expect(line).toEqual({ height: '2px', top: '-1px', painted: true })
    expect(await section('background-jobs').evaluate(element => getComputedStyle(element).opacity)).toBe('0.5')
    await page.mouse.up()
    await expect.poll(order).toEqual(['background-jobs', 'environment', 'subagents'])
    // The stored order names every live section, including Shared tasks, which shows nothing in this Session.
    expect(await stored()).toEqual(['background-jobs', 'environment', 'subagents', 'shared-tasks'])
    await expect.poll(marks).toEqual([['background-jobs', false, null], ['environment', false, null], ['subagents', false, null]])
    // The pin stays on the first shown section's title line.
    expect((await pinning(page)).pin).toEqual({ pressed: 'false', target: [24, 24], center: 22, top: 10 })

    // The order survives a reload.
    await page.reload({ waitUntil: 'load' })
    await openSeed(page)
    await shows(page, 'docked')
    await expect.poll(order, { timeout: 20_000 }).toEqual(['background-jobs', 'environment', 'subagents'])

    // The arrow keys on a handle move its section past one neighbor at a time, and focus stays on the handle.
    await grip('background-jobs').focus()
    await page.keyboard.press('ArrowDown')
    await expect.poll(order).toEqual(['environment', 'background-jobs', 'subagents'])
    await page.keyboard.press('ArrowDown')
    await expect.poll(order).toEqual(registered)
    expect(await page.evaluate(() => document.activeElement?.closest('[data-session-panel-section]')?.getAttribute('data-session-panel-section')))
      .toBe('background-jobs')
    // The last section has nowhere further to go.
    await page.keyboard.press('ArrowDown')
    expect(await order()).toEqual(registered)
    // A keyboard move lands beside the shown neighbor, so the hidden section stays after it.
    expect(await stored()).toEqual(['environment', 'subagents', 'background-jobs', 'shared-tasks'])
    expect(tripwire.pageErrors).toEqual([])
  })

  it('lays the working folder row out by its marks, with no room or highlight for a menu that renders nothing', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-panel-row'))
    await openSession()
    await setGutter(DOCK_GUTTER + 100)
    await shows(page, 'docked')
    const row = page.locator('[data-session-panel] [data-session-panel-project]')
    await row.waitFor()
    await page.mouse.move(5, 5)
    // This composition registers no directory menu entries, so the shared More button renders nothing:
    // the text runs to the row's 6px padding, and the row has nothing to highlight for.
    const resting = { height: 28, iconCenter: 14, iconSize: [16, 16], clipped: 'ellipsis', afterText: 6, menu: null, highlighted: false }
    expect(await rowLayout(page)).toEqual({ ...resting, hovered: false })
    await row.hover()
    expect(await rowLayout(page)).toEqual({ ...resting, hovered: true })
    expect(tripwire.pageErrors).toEqual([])
  })

  it('puts a rendered menu on the panel end column and shows it, with the row highlight, on hover', async () => {
    // The directory context menu comes from Open In; SSH facts keep it from probing this runner's native applications.
    const withMenu = await launchWebScaffold({ openInAppEnvironment: createLaunchEnvironmentSnapshot([
      { source: 'process', values: { SSH_CONNECTION: '10.0.0.2 55000 10.0.0.9 22' } },
    ]) })
    onTestFinished(() => withMenu.close())
    await seedSession(withMenu, await readFile(FIXTURE, 'utf8'), SEED_ID)
    const other = await newEnglishPage(browser)
    onTestFinished(() => other.close())
    onTestFailed(() => saveFailureShot(other, 'web-e2e-session-panel-row-menu'))
    await other.emulateMedia({ reducedMotion: 'reduce' })
    const errors = watchConsole(other)
    // Wide enough for the gutter to hold the docked panel.
    await other.setViewportSize({ width: 2200, height: 1000 })
    await other.goto(withMenu.authenticatedUrl, { waitUntil: 'load' })
    await openSeed(other)
    await shows(other, 'docked')
    const row = other.locator('[data-session-panel] [data-session-panel-project]')
    await row.locator('[data-row-part="menu"] button').waitFor({ state: 'attached' })
    await other.mouse.move(5, 5)
    // The 16px menu column and the 8px gap before it follow the text; the 24px target reaches past the column.
    const resting = { height: 28, iconCenter: 14, iconSize: [16, 16], clipped: 'ellipsis', afterText: 30 }
    expect(await rowLayout(other)).toEqual({
      ...resting, menu: { center: 14, target: [24, 24], opacity: '0' }, hovered: false, highlighted: false,
    })
    await row.hover()
    await expect.poll(async () => (await rowLayout(other)).menu?.opacity).toBe('1')
    expect(await rowLayout(other)).toEqual({
      ...resting, menu: { center: 14, target: [24, 24], opacity: '1' }, hovered: true, highlighted: true,
    })
    await other.mouse.move(5, 5)
    await expect.poll(async () => (await rowLayout(other)).highlighted).toBe(false)
    // The row's open menu keeps the row highlighted and the More button shown after the pointer leaves for the menu.
    await row.locator('[data-row-part="menu"] button').click()
    await other.getByRole('menu').waitFor()
    await other.mouse.move(5, 5)
    expect(await rowLayout(other)).toEqual({
      ...resting, menu: { center: 14, target: [24, 24], opacity: '1' }, hovered: false, highlighted: true,
    })
    await other.keyboard.press('Escape')
    await expect.poll(async () => (await rowLayout(other)).highlighted).toBe(false)
    expect(errors.pageErrors).toEqual([])
  })
})
