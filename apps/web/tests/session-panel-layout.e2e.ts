/**
 * Session panel layout in the shipped Web composition. The panel's stylesheet
 * decides whether the docked panel has room, in the Chat View's end gutter or
 * by the transcript moving into its start gutter, and tells the plugin
 * through a 1px dock probe, and it lays out the rows that contributors mark.
 * jsdom cannot evaluate that stylesheet, so this measures the probe, the
 * panel, the toggle, the transcript, the composer, and the width handles
 * around the docking boundaries, a width drag beside the docked panel, the
 * drag that reorders sections, and the working folder row without and with a
 * directory context menu.
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
import { saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v3.jsonl', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = brandString<SessionId>('session-panel-layout-web-e2e')
/** The default transcript width in a frame wide enough to dock. */
const TRANSCRIPT = 880
/** The gutter that holds the docked panel: 40px clear of the transcript, its 300px minimum width, and the 8px edge inset. */
const DOCK_GUTTER = 348

/** What a frame or a sought moment of the panel's motion shows; the panel's fields are null while it does not render. */
interface MotionFrame {
  /** The scrollport's end inset. */
  readonly inset: number
  /** The panel's motion mark, `none` at rest. */
  readonly motion: string | null
  readonly opacity: number | null
  /** The distance from the panel's end edge to the scrollport's. */
  readonly edge: number | null
  /** The scrollport's sideways scroll range. */
  readonly sideways: number
}

/** What the motion page's window carries for the test: its init script's frame reader, the sampled frames, and the held animations. */
interface MotionWindow {
  readonly motionFrame: () => MotionFrame | null
  sampled: MotionFrame[]
  held: Animation[]
}

/**
 * A page at the lane's baseline size whose origin stores no docking choice.
 * The lane's standard page starts with docking off; this file measures the
 * panel as a reader first meets it.
 */
function newPanelPage(browser: Browser): Promise<Page> {
  return browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US', timezoneId: 'Asia/Shanghai' })
}

/** What the layout says about docking: the gutter, the probe, the panel's presentation and insets, and the toggle. */
function docking(page: Page) {
  return page.evaluate(() => {
    const layer = document.querySelector<HTMLElement>('[data-chat-aside]')
    const column = document.querySelector<HTMLElement>('[data-chat-flow]')
    const probe = document.querySelector<HTMLElement>('[data-session-panel-probe]')
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
  await page.locator('[data-session-panel-probe]').waitFor({ state: 'attached', timeout: 30_000 })
}

/**
 * What the layout says around the panel: the frame and the transcript column
 * in it, the scrollport's end inset, how far the composer card's center sits
 * from the column's, each width handle's width and its distance from the
 * column edge it follows, the dock probe, the panel, and the toggle.
 */
function layout(page: Page) {
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
    const handle = (side: 'left' | 'right'): { width: number; gap: number } => {
      const strip = need(`[data-width-handle="${side}"]`).getBoundingClientRect()
      return { width: strip.width, gap: side === 'left' ? flow.left - strip.right : strip.left - flow.right }
    }
    return {
      frame: frame.width,
      column: flow.width,
      before: flow.left - frame.left,
      after: frame.right - flow.right,
      inset: getComputedStyle(need('[data-conversation-scroll]')).paddingInlineEnd,
      composerOffset: (card.left + card.right - flow.left - flow.right) / 2,
      handles: { left: handle('left'), right: handle('right') },
      probe: need('[data-session-panel-probe]').getBoundingClientRect().width,
      presentation: panel?.dataset['sessionPanel'] ?? null,
      expanded: need('[data-session-panel-toggle]').getAttribute('aria-expanded'),
      panel: box === undefined ? null : { width: box.width, clear: box.left - flow.right, edge: frame.right - box.right },
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

  /** Resize the window so the gutter on each side of the centered 880px transcript is exactly `gutter`. */
  function setGutter(gutter: number): Promise<void> {
    return setFrame(TRANSCRIPT + 2 * gutter)
  }

  /** Forget a dragged transcript width, so the next resize publishes the default again. */
  function forgetWidth(): Promise<void> {
    return page.evaluate(() => { localStorage.removeItem('dsh.conversation.contentWidth') })
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    await seedSession(scaffold, await readFile(FIXTURE, 'utf8'), SEED_ID)
    browser = await chromium.launch()
    page = await newPanelPage(browser)
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

  it('docks in the end gutter where it holds the panel, and elsewhere has the transcript move into its start gutter', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-panel-dock'))
    await openSession()
    expect(Number.isInteger(chrome)).toBe(true)
    const toggle = page.locator('[data-session-panel-toggle]')
    const docked = { probe: 1, presentation: 'docked', expanded: 'true' }

    // A wide gutter: the transcript is centered and the panel is at its maximum width.
    await setGutter(DOCK_GUTTER + 100)
    await shows(page, 'docked')
    const wide = await layout(page)
    expect(wide).toMatchObject({
      column: TRANSCRIPT, before: DOCK_GUTTER + 100, after: DOCK_GUTTER + 100, inset: '0px', composerOffset: 0, ...docked,
      panel: { width: 360, clear: 80, edge: 8 },
    })
    expect([wide.handles.left.width, wide.handles.right.width]).toEqual([10, 10])

    // The narrowest gutter that holds the panel by itself.
    await setGutter(DOCK_GUTTER)
    expect(await layout(page)).toMatchObject({
      before: DOCK_GUTTER, after: DOCK_GUTTER, inset: '0px', ...docked, panel: { width: 300, clear: 40, edge: 8 },
    })

    // One pixel short: the column moves that pixel toward the start edge, at its own width, and the panel stays docked.
    await setGutter(DOCK_GUTTER - 1)
    expect(await layout(page)).toMatchObject({
      column: TRANSCRIPT, before: DOCK_GUTTER - 2, after: DOCK_GUTTER, inset: '2px', composerOffset: 0, ...docked,
      panel: { width: 300, clear: 40, edge: 8 },
    })

    // A 260px gutter: the column and the composer move 88px, twice over, and keep their width.
    await setGutter(260)
    const moved = await layout(page)
    expect(moved).toMatchObject({
      column: TRANSCRIPT, before: 172, after: DOCK_GUTTER, inset: '176px', composerOffset: 0, ...docked,
      panel: { width: 300, clear: 40, edge: 8 },
    })
    // The width handles moved with the column and keep their width.
    expect([moved.handles.left.width, moved.handles.right.width]).toEqual([10, 10])
    expect(moved.handles.left.gap).toBeCloseTo(wide.handles.left.gap, 1)
    expect(moved.handles.right.gap).toBeCloseTo(wide.handles.right.gap, 1)
    // Neither a press in the transcript's start gutter nor Escape closes the docked panel.
    await page.locator('[data-conversation-scroll]').click({ position: { x: 8, y: 8 } })
    await page.keyboard.press('Escape')
    expect(await layout(page)).toMatchObject({ before: 172, after: DOCK_GUTTER, ...docked })

    // The toggle hides it, which gives the room back, and shows it again.
    await toggle.click()
    await shows(page, null)
    expect(await layout(page)).toMatchObject({ before: 260, after: 260, inset: '0px', probe: 1, presentation: null, expanded: 'false' })
    await toggle.click()
    await shows(page, 'docked')
    expect(await layout(page)).toMatchObject({ before: 172, after: DOCK_GUTTER, inset: '176px', ...docked })

    // A reload docks it again, with the transcript already moved.
    await page.reload({ waitUntil: 'load' })
    await openSeed(page)
    await shows(page, 'docked')
    expect(await layout(page)).toMatchObject({ column: TRANSCRIPT, before: 172, after: DOCK_GUTTER, inset: '176px', ...docked })
    expect(tripwire.pageErrors).toEqual([])
  })

  it('leaves the transcript centered where its start gutter cannot give the room, floats on request, and docks once it can', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-panel-overlay'))
    await openSession()
    const toggle = page.locator('[data-session-panel-toggle]')
    // A stored width holds the column at 880px in these frames, so the boundary is 880 + 32 + 348.
    await page.evaluate(() => { localStorage.setItem('dsh.conversation.contentWidth', '880') })
    onTestFinished(forgetWidth)

    // The narrowest frame that makes room leaves the column its 32px side inset at the start edge.
    await setFrame(TRANSCRIPT + 32 + DOCK_GUTTER)
    await shows(page, 'docked')
    const last = await layout(page)
    expect(last).toMatchObject({
      column: TRANSCRIPT, before: 32, after: DOCK_GUTTER, inset: '316px', composerOffset: 0, probe: 1, expanded: 'true',
      panel: { width: 300, clear: 40, edge: 8 },
    })
    // The start handle has no gutter left to sit in; the end handle keeps its place before the panel.
    expect([last.handles.left.width, last.handles.right.width]).toEqual([0, 10])

    // One pixel less makes none: the column stays centered at its width and the panel hides.
    await setFrame(TRANSCRIPT + 32 + DOCK_GUTTER - 1)
    await shows(page, null)
    expect(await layout(page)).toMatchObject({
      column: TRANSCRIPT, before: 189.5, after: 189.5, inset: '0px', probe: 0, expanded: 'false', panel: null,
    })

    // The toggle then opens it over the transcript, narrower than docked and at the same edge inset.
    await toggle.click()
    await shows(page, 'overlay')
    const overlay = await layout(page)
    expect(overlay).toMatchObject({ before: 189.5, inset: '0px', probe: 0, presentation: 'overlay', expanded: 'true', panel: { width: 280, edge: 8 } })
    expect(overlay.panel?.clear).toBeLessThan(0)
    await page.keyboard.press('Escape')
    await shows(page, null)
    expect((await layout(page)).expanded).toBe('false')

    // An open overlay gives way to the docked panel once the frame can make the room.
    await toggle.click()
    await shows(page, 'overlay')
    await setFrame(TRANSCRIPT + 32 + DOCK_GUTTER)
    await shows(page, 'docked')
    expect(await layout(page)).toMatchObject({ before: 32, after: DOCK_GUTTER, expanded: 'true', panel: { width: 300, clear: 40, edge: 8 } })
    expect(tripwire.pageErrors).toEqual([])
  })

  it('resizes the transcript from either width handle beside the docked panel, moving only its start edge', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-panel-width'))
    await openSession()
    await forgetWidth()
    onTestFinished(forgetWidth)
    await setGutter(260)
    await shows(page, 'docked')
    /** Drag a width handle `dx` pixels in one move and wait for the width it stores. */
    const drag = async (side: 'left' | 'right', dx: number, stored: string): Promise<void> => {
      const strip = (await page.locator(`[data-width-handle="${side}"]`).boundingBox())!
      const x = strip.x + strip.width / 2
      await page.mouse.move(x, 400)
      await page.mouse.down()
      await page.mouse.move(x + dx, 400)
      await page.mouse.up()
      await expect.poll(() => page.evaluate(() => localStorage.getItem('dsh.conversation.contentWidth'))).toBe(stored)
    }
    const beside = { presentation: 'docked', panel: { width: 300, clear: 40, edge: 8 } }

    // The panel holds the column's end edge: 40px of travel on the start handle moves the start edge 40px.
    await drag('left', -40, '920')
    expect(await layout(page)).toMatchObject({ column: 920, before: 132, after: DOCK_GUTTER, ...beside })
    // The end handle sits between the column and the panel; travel toward the panel widens the column the same way.
    await drag('right', 20, '940')
    expect(await layout(page)).toMatchObject({ column: 940, before: 112, after: DOCK_GUTTER, ...beside })
    await drag('left', 60, '880')
    expect(await layout(page)).toMatchObject({ column: TRANSCRIPT, before: 172, after: DOCK_GUTTER, ...beside })

    // In a gutter that holds the panel the column is centered, and both edges move with the pointer.
    await setGutter(DOCK_GUTTER + 100)
    await drag('right', 20, '920')
    expect(await layout(page)).toMatchObject({ column: 920, before: 428, after: 428, inset: '0px', presentation: 'docked' })

    // Dragged wider than the start gutter can give, the column takes its room back: the panel hides and the column centers.
    await setGutter(260)
    expect(await layout(page)).toMatchObject({ column: 920, before: 132, after: DOCK_GUTTER, ...beside })
    await drag('left', -110, '1030')
    await shows(page, null)
    expect(await layout(page)).toMatchObject({ column: 1030, before: 185, after: 185, inset: '0px', probe: 0, expanded: 'false' })
    // Narrowed again, the panel docks without the toggle.
    await drag('left', 20, '990')
    await shows(page, 'docked')
    expect(await layout(page)).toMatchObject({ column: 990, before: 62, after: DOCK_GUTTER, ...beside })
    expect(tripwire.pageErrors).toEqual([])
  })

  it('moves the transcript with the panel when a press shows or hides it, and shows it at once on a reload', async () => {
    await openSession()
    // A page that does not ask for reduced motion, as the page of the other cases does.
    const moving = await newPanelPage(browser)
    onTestFinished(() => moving.close())
    onTestFailed(() => saveFailureShot(moving, 'web-e2e-session-panel-motion'))
    const errors = watchConsole(moving)
    await moving.addInitScript(() => {
      Object.assign(window, {
        motionFrame: (): MotionFrame | null => {
          const scroll = document.querySelector<HTMLElement>('[data-conversation-scroll]')
          const panel = document.querySelector<HTMLElement>('[data-session-panel]')
          if (scroll === null) return null
          return {
            inset: Number.parseFloat(getComputedStyle(scroll).paddingInlineEnd),
            motion: panel === null ? null : panel.dataset['sessionPanelMotion'] ?? 'none',
            opacity: panel === null ? null : Number(getComputedStyle(panel).opacity),
            edge: panel === null ? null : scroll.getBoundingClientRect().left + scroll.clientWidth - panel.getBoundingClientRect().right,
            sideways: scroll.scrollWidth - scroll.clientWidth,
          }
        },
      })
    })
    // A 260px gutter: the panel docks by the transcript moving 88px, an end inset of 176px.
    await moving.setViewportSize({ width: TRANSCRIPT + 2 * 260 + chrome, height: 1000 })
    await moving.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await openSeed(moving)
    await shows(moving, 'docked')
    /**
     * Sample what each frame shows until the page settles, in a task queued from the frame callback: it runs after
     * that frame's style, layout, size observers, and paint, so a state a size observer replaces is not reported.
     */
    const startSampling = () => moving.evaluate(() => {
      const recorder = window as never as MotionWindow
      recorder.sampled = []
      const channel = new MessageChannel()
      channel.port1.onmessage = (): void => {
        const frame = recorder.motionFrame()
        if (frame !== null) recorder.sampled.push(frame)
        requestAnimationFrame(() => { channel.port2.postMessage(0) })
      }
      requestAnimationFrame(() => { channel.port2.postMessage(0) })
    })
    const sampled = () => moving.evaluate(() => (window as never as MotionWindow).sampled.splice(0))
    /**
     * Pause the motion of the next press before any frame shows it: in the task of the press, once the dock probe
     * takes its moving mark, hold every animation that this style change started on the panel, the scrollport, and
     * the aside layer. A part that would start moving in a later frame has no animation yet and is missing.
     */
    const holdMotion = () => moving.evaluate(() => {
      const recorder = window as never as MotionWindow
      recorder.held = []
      const probe = document.querySelector('[data-session-panel-probe]')!
      const observer = new MutationObserver(() => {
        if (!probe.hasAttribute('data-session-panel-moving')) return
        observer.disconnect()
        for (const animation of document.getAnimations()) {
          const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null
          if (target?.matches('[data-session-panel], [data-conversation-scroll], [data-chat-aside]') !== true) continue
          animation.pause()
          recorder.held.push(animation)
        }
      })
      observer.observe(probe, { attributeFilter: ['data-session-panel-moving'] })
    })
    /**
     * Seek the held animations together to each sixteenth of their duration, report what every moment shows and
     * how long each part moves, then play them from the start, so the press ends as it would have. The end itself is
     * left to that playback: the panel's animation sought to its end fires its end event, which ends the motion.
     */
    const seekHeld = async () => {
      await expect.poll(() => moving.evaluate(() => (window as never as MotionWindow).held.length), { timeout: 10_000 }).toBe(3)
      return moving.evaluate(() => {
        const { held, motionFrame } = window as never as MotionWindow
        const parts = held.map((animation) => {
          const target = (animation.effect as KeyframeEffect).target!
          return {
            part: target.matches('[data-session-panel]') ? 'panel' : target.matches('[data-chat-aside]') ? 'aside' : 'scroll',
            end: Number(animation.effect!.getComputedTiming().endTime),
          }
        }).sort((a, b) => a.part.localeCompare(b.part))
        const end = Math.max(...parts.map(part => part.end))
        const moments: MotionFrame[] = []
        for (let step = 0; step < 16; step += 1) {
          for (const animation of held) animation.currentTime = end * step / 16
          moments.push(motionFrame()!)
        }
        for (const animation of held) {
          animation.currentTime = 0
          animation.play()
        }
        return { parts, moments }
      })
    }
    /** All three parts move for the panel's 160ms. */
    const together = [{ part: 'aside', end: 160 }, { part: 'panel', end: 160 }, { part: 'scroll', end: 160 }]
    /**
     * One time and one curve: in every frame or moment of the motion, the panel's opacity and its slide across its
     * 8px edge inset follow the end inset's progress, and the inset moves one way only. The slide stays inside the
     * scrollport: a panel past its end edge would give the body a sideways scroll range, whose bar lifts the composer
     * for as long as it shows.
     */
    const followsInset = (frames: readonly MotionFrame[], motion: 'enter' | 'exit'): void => {
      for (const frame of frames.filter(frame => frame.motion === motion)) {
        expect(Math.abs(frame.opacity! - frame.inset / 176)).toBeLessThan(0.06)
        expect(Math.abs(frame.edge! - 8 * frame.inset / 176)).toBeLessThan(0.8)
      }
      const ordered = (before: number, after: number): boolean => motion === 'exit' ? after <= before : after >= before
      expect(frames.every((frame, index) => index === 0 || ordered(frames[index - 1]!.inset, frame.inset))).toBe(true)
      expect(frames.map(frame => frame.sideways).filter(range => range !== 0)).toEqual([])
    }
    const toggle = moving.locator('[data-session-panel-toggle]')
    await startSampling()

    // The toggle hides the panel: it leaves over the same time and curve the transcript takes its room back in.
    await holdMotion()
    await toggle.click()
    const exit = await seekHeld()
    expect(exit.parts).toEqual(together)
    expect(exit.moments[0]).toMatchObject({ inset: 176, motion: 'exit', opacity: 1 })
    // The transcript is on its way at every later moment, not at once at either end.
    expect(exit.moments.slice(1).filter(moment => moment.motion !== 'exit' || moment.inset <= 0 || moment.inset >= 176)).toEqual([])
    followsInset(exit.moments, 'exit')
    await shows(moving, null)
    const leaving = await sampled()
    followsInset(leaving, 'exit')
    expect(leaving.at(-1)).toEqual({ inset: 0, motion: null, opacity: null, edge: null, sideways: 0 })

    // The toggle shows it again: the same motion in reverse.
    await holdMotion()
    await toggle.click()
    const enter = await seekHeld()
    expect(enter.parts).toEqual(together)
    expect(enter.moments[0]).toMatchObject({ inset: 0, motion: 'enter', opacity: 0 })
    expect(enter.moments.slice(1).filter(moment => moment.motion !== 'enter' || moment.inset <= 0 || moment.inset >= 176)).toEqual([])
    followsInset(enter.moments, 'enter')
    await shows(moving, 'docked')
    await expect.poll(() => moving.locator('[data-session-panel]').getAttribute('data-session-panel-motion')).toBeNull()
    const entering = await sampled()
    followsInset(entering, 'enter')
    expect(entering.at(-1)).toEqual({ inset: 176, motion: 'none', opacity: 1, edge: 8, sideways: 0 })

    // A window resized past the room and back shows and hides the panel at once: no frame is in between.
    const viewport = moving.viewportSize()!
    await moving.setViewportSize({ width: 1100, height: viewport.height })
    await shows(moving, null)
    await moving.setViewportSize(viewport)
    await shows(moving, 'docked')
    const resized = await sampled()
    expect(resized.filter(frame => frame.motion === 'enter' || frame.motion === 'exit')).toEqual([])
    expect(resized.map(frame => frame.sideways).filter(range => range !== 0)).toEqual([])
    expect(resized.filter(frame => frame.motion === 'none').every(frame => frame.opacity === 1 && frame.edge === 8)).toBe(true)

    // A reload, like a switch to another Session, mounts the panel shown: it is opaque and in place in its first frame.
    await moving.reload({ waitUntil: 'load' })
    await startSampling()
    await openSeed(moving)
    await shows(moving, 'docked')
    await moving.waitForTimeout(300)
    const arriving = (await sampled()).filter(frame => frame.motion !== null)
    expect(arriving.length).toBeGreaterThan(0)
    expect(new Set(arriving.map(frame => JSON.stringify(frame)))).toEqual(new Set([JSON.stringify({ inset: 176, motion: 'none', opacity: 1, edge: 8, sideways: 0 })]))
    expect(errors.pageErrors).toEqual([])
  })

  it('reorders sections by dragging a title row, keeps Environment first, and keeps the order across a reload', async () => {
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
    // With Environment and one other section there is nowhere to move it: its title row offers no drag.
    const lone = page.locator('[data-session-panel] [data-session-panel-section="subagents"]').locator('h2').locator('..')
    await lone.waitFor({ timeout: 20_000 })
    await lone.hover()
    expect(await lone.evaluate(element => ({
      cursor: getComputedStyle(element).cursor,
      handle: getComputedStyle(element.querySelector('[data-session-panel-grip]')!).opacity,
      trailing: getComputedStyle(element.children[1]!).visibility,
    }))).toEqual({ cursor: 'auto', handle: '0', trailing: 'visible' })
    const start = (await lone.boundingBox())!
    await page.mouse.move(start.x + 40, start.y + start.height / 2)
    await page.mouse.down()
    await page.mouse.move(start.x + 40, start.y - 30, { steps: 6 })
    expect(await page.locator('[data-session-panel-section][data-dragging]').count()).toBe(0)
    await page.mouse.up()
    scaffold.ctx.jobs.start({
      kind: 'bash', label: 'pnpm run build', owner: agent.id,
      run: () => ({ done: release.promise, cancel: () => { release.resolve({ status: 'completed' }) } }),
    })
    const panel = page.locator('[data-session-panel]')
    const section = (id: string) => panel.locator(`[data-session-panel-section="${id}"]`)
    const head = (id: string) => section(id).locator('h2').locator('..')
    /** The ids of the sections that show, top to bottom. */
    const order = (): Promise<(string | null)[]> => panel.evaluate(element => [...element.querySelectorAll('[data-session-panel-section]')]
      .filter(node => getComputedStyle(node).display !== 'none').map(node => node.getAttribute('data-session-panel-section')))
    const stored = async (): Promise<unknown> =>
      JSON.parse(await page.evaluate(() => localStorage.getItem('dsh.sessionPanel.sectionOrder')) ?? 'null')
    const registered = ['environment', 'subagents', 'background-jobs']
    await expect.poll(order, { timeout: 20_000 }).toEqual(registered)
    expect(await panel.locator('[data-session-panel-section]:visible').evaluateAll(sections => sections.map(element => [
      getComputedStyle(element).marginTop, getComputedStyle(element).borderTopStyle,
    ]))).toEqual([['0px', 'none'], ['2px', 'solid'], ['2px', 'solid']])

    const toggle = page.locator('[data-session-panel-toggle]')
    await toggle.click()
    await shows(page, null)
    const dot = toggle.locator('[data-jobs-running]')
    expect(await dot.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const button = element.closest('button')!.getBoundingClientRect()
      return [box.width, box.height, box.top - button.top, button.right - box.right]
    })).toEqual([6, 6, 5, 5])
    expect(await page.getByRole('button', { name: /Background jobs running: 1/u }).count()).toBe(1)
    await toggle.click()
    await shows(page, 'docked')
    expect(await dot.count()).toBe(0)

    // At rest the handle does not show and takes no room: the title's trailing count runs to the row's 6px padding.
    // Over the title row the handle shows on the rows' More column in place of the count, which keeps its box.
    await page.mouse.move(5, 5)
    const handle = (id: string) => head(id).evaluate((element) => {
      const mark = element.querySelector<HTMLElement>('[data-session-panel-grip]')!
      const trailing = element.children[1] as HTMLElement
      const box = element.getBoundingClientRect()
      const target = mark.getBoundingClientRect()
      return {
        cursor: getComputedStyle(element).cursor,
        opacity: getComputedStyle(mark).opacity,
        size: [target.width, target.height],
        center: box.right - (target.left + target.width / 2),
        trailing: trailing.textContent,
        trailingEnd: box.right - trailing.getBoundingClientRect().right,
        shown: getComputedStyle(trailing).visibility === 'visible',
      }
    })
    const resting = { cursor: 'grab', size: [24, 24], center: 14, trailing: '1 external', trailingEnd: 6 }
    expect(await handle('subagents')).toEqual({ ...resting, opacity: '0', shown: true })
    await head('subagents').hover()
    await expect.poll(async () => (await handle('subagents')).opacity).toBe('1')
    expect(await handle('subagents')).toEqual({ ...resting, opacity: '1', shown: false })
    expect(await head('background-jobs').locator('[data-session-panel-grip]').evaluate(element => getComputedStyle(element).opacity)).toBe('0')
    await head('background-jobs').hover()
    expect(await handle('background-jobs')).toMatchObject({ cursor: 'grab', opacity: '1', shown: false })
    // Environment does not move: its title row is no drag source and has no handle.
    expect(await head('environment').evaluate(element => ({
      draggable: (element as HTMLElement).draggable,
      cursor: getComputedStyle(element).cursor,
      handles: element.querySelectorAll('[data-session-panel-grip]').length,
    }))).toEqual({ draggable: false, cursor: 'auto', handles: 0 })
    // The handle is a mark: the panel's title rows hold no button for it.
    expect(await panel.locator('h2 ~ [data-session-panel-grip]').evaluateAll(marks => marks.map(mark => mark.tagName))).toEqual(['SPAN', 'SPAN', 'SPAN'])

    /** Drag a section's title row to a point `dy` below the top of another section, resting there. */
    const dragOnto = async (from: string, onto: string, dy: number): Promise<void> => {
      const source = (await head(from).boundingBox())!
      const target = (await section(onto).boundingBox())!
      await page.mouse.move(source.x + 40, source.y + source.height / 2)
      await page.mouse.down()
      await page.mouse.move(source.x + 40, source.y - 12, { steps: 4 })
      await page.mouse.move(target.x + 40, target.y + dy, { steps: 8 })
      // A move onto a new element reports only the enter and the leave; one more within it reports the drag over it.
      await page.mouse.move(target.x + 42, target.y + dy)
    }
    const marks = () => panel.evaluate(element => [...element.querySelectorAll<HTMLElement>('[data-session-panel-section]')]
      .filter(node => getComputedStyle(node).display !== 'none')
      .map(node => [node.dataset['sessionPanelSection'], node.hasAttribute('data-dragging'), node.dataset['dropTarget'] ?? null]))

    // Drag Background jobs by its title row onto the upper half of Subagents.
    await dragOnto('background-jobs', 'subagents', 6)
    await expect.poll(marks).toEqual([['environment', false, null], ['subagents', false, 'before'], ['background-jobs', true, null]])
    // The landing line: 2px in the accent color on Subagents' top edge; the dragged section dims.
    const line = await section('subagents').evaluate((element) => {
      const style = getComputedStyle(element, '::after')
      return { height: style.height, top: style.top, painted: style.backgroundColor !== 'rgba(0, 0, 0, 0)' }
    })
    expect(line).toEqual({ height: '2px', top: '-1px', painted: true })
    expect(await section('background-jobs').evaluate(element => getComputedStyle(element).opacity)).toBe('0.5')
    await page.mouse.up()
    await expect.poll(order).toEqual(['environment', 'background-jobs', 'subagents'])
    // The stored order names every live section, including Shared tasks, which shows nothing in this Session.
    expect(await stored()).toEqual(['environment', 'background-jobs', 'subagents', 'shared-tasks'])
    await expect.poll(marks).toEqual([['environment', false, null], ['background-jobs', false, null], ['subagents', false, null]])

    // Over the upper half of Environment the line is on its bottom edge: a section lands after it, never before.
    await dragOnto('subagents', 'environment', 6)
    await expect.poll(marks).toEqual([['environment', false, 'after'], ['background-jobs', false, null], ['subagents', true, null]])
    await page.mouse.up()
    await expect.poll(order).toEqual(registered)
    expect(await stored()).toEqual(['environment', 'subagents', 'background-jobs', 'shared-tasks'])

    // The order survives a reload.
    await dragOnto('background-jobs', 'subagents', 6)
    await page.mouse.up()
    await expect.poll(order).toEqual(['environment', 'background-jobs', 'subagents'])
    await page.reload({ waitUntil: 'load' })
    await openSeed(page)
    await shows(page, 'docked')
    await expect.poll(order, { timeout: 20_000 }).toEqual(['environment', 'background-jobs', 'subagents'])
    // The arrow keys move nothing: only a drag reorders.
    await head('background-jobs').click()
    await page.keyboard.press('ArrowDown')
    expect(await order()).toEqual(['environment', 'background-jobs', 'subagents'])
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
    const other = await newPanelPage(browser)
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
