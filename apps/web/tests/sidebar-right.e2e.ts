// Keyless assembled-browser coverage for the shipped right Sidebar: the official
// roster row, the real plugin graph, and one Chromium. No overlay is applied —
// this scenario proves the surface is in the product's own composition.
//
// The frame owns the right column as a track; the Sidebar anchors its panel to
// the column's edge and slides it in and out. Which of the two presentations
// draws the panel is a recorded, reversible choice, so this file asserts against
// the frame's track as much as against the panel itself. The way back in while
// collapsed is not in the column at all: it is one button in the conversation
// header, and it leaves when the panel opens.
//
// Ordering is the product's own: the hero comes before any session, so the
// empty right edge is asserted first and the session-bound cases follow in a
// nested block that seeds one turn.
//
// Copy is asserted in English because this page advertises English, which is
// itself the point: every string in this column now comes from the dictionary,
// so an English page renders English. The Chinese draft the product ships is
// asserted, and captured for review, on its own page at the end.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, ConsoleMessage, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { acknowledgeReloadConnectionLoss, launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import {
  connectFreshWorkspace, newEnglishPage, saveFailureShot, ZH_BROWSER_LOCALE,
} from './support.ts'

/** The produced file the seeded turn writes, and what the preview should show. */
const SAMPLE_NAME = 'notes.txt'
const SAMPLE_TEXT = 'produced by the seeded turn\nsecond line\n'

/** Where this batch's accepted product forms are archived. */
const SHOT_DIR = fileURLToPath(new URL('../../../.artifacts/screenshots/0907-sidebar-rules', import.meta.url))

/** Archive one accepted product form; the batch receipt cites these by name. */
async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true })
}

/** Centre of a rendered element, in viewport coordinates. */
async function centre(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox()
  if (box === null) throw new Error('element is not rendered')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/**
 * Press a tab chip and release it over a point.
 *
 * The press stays left of the chip's nested close control. An optional preview
 * verifies the browser recognized the drop target before the release.
 */
async function dragTo(page: Page, tab: Locator, to: { x: number; y: number }, preview?: Locator): Promise<void> {
  const box = await tab.boundingBox()
  if (box === null) throw new Error('tab is not rendered')
  const from = { x: box.x + 6, y: box.y + box.height / 2 }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  try {
    await page.mouse.move(to.x, to.y, { steps: 8 })
    await preview?.waitFor({ state: 'visible' })
  } finally {
    await page.mouse.up()
  }
}

/** Press an element itself and release over a point (no tab-title indirection). */
async function dragElement(page: Page, handle: Locator, to: { x: number; y: number }): Promise<void> {
  const from = await centre(handle)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await page.mouse.up()
}

/** A point inside `locator`, offset by fractions of its own box. */
async function pointIn(locator: Locator, fx: number, fy: number): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox()
  if (box === null) throw new Error('element is not rendered')
  return { x: box.x + box.width * fx, y: box.y + box.height * fy }
}

/** Select panes by CSS column; retained tab hosts keep their independent DOM order. */
function paneAt(column: Locator, index: number): Locator {
  return column.locator(`[data-dockkit-pane][data-dockkit-column="${index}"]`)
}

/** Pause a docked host's next real transform transition at its midpoint. */
async function holdPanelSlide(panel: Locator) {
  return await panel.evaluateHandle((node) => {
    const controller = new AbortController()
    const state = { animation: null as Animation | null, columnsAtStart: '', dispose: () => { controller.abort() } }
    node.addEventListener('transitionrun', (event) => {
      const target = event.target
      if (!(target instanceof Element) || !target.matches('[data-dockkit-host="dock"]')
        || (event as TransitionEvent).propertyName !== 'transform') return
      const frame = node.closest('[style*="grid-template-columns"]')
      if (frame === null) throw new Error('panel frame is unavailable')
      state.columnsAtStart = getComputedStyle(frame).gridTemplateColumns
      const slide = target.getAnimations().find(animation =>
        'transitionProperty' in animation && animation.transitionProperty === 'transform')
      if (slide === undefined || slide.effect === null) throw new Error('panel transform transition is unavailable')
      slide.pause()
      slide.currentTime = Number(slide.effect.getComputedTiming().endTime) / 2
      state.animation = slide
      controller.abort()
    }, { signal: controller.signal })
    return state
  })
}

/** The expand button in the conversation header, present only while collapsed. */
function expandOf(page: Page): Locator {
  return page.locator('[data-sidebar-right-expand]')
}

/**
 * Make sure the panel is open.
 *
 * These cases share one page and run in order, so an earlier one may have left
 * the panel collapsed; a case that needs tabs says so rather than inheriting
 * whatever the previous one happened to leave. The way in while collapsed is the
 * header's expand button, which lives in the conversation, not the column.
 */
async function ensureExpanded(page: Page, column: Locator): Promise<void> {
  if (await column.locator('[data-sidebar-right-open]').count() > 0) return
  await expandOf(page).click()
  await column.locator('[data-sidebar-right-open]').waitFor({ timeout: 10_000 })
}

/** Clear only this fixture's saved layouts before an independent gesture case. */
async function resetSidebar(page: Page): Promise<Locator> {
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('dsh.sidebar-right.v1.')) localStorage.removeItem(key)
    }
  })
  await page.reload({ waitUntil: 'load' })
  const column = page.locator('[data-rightbar-col]')
  await expandOf(page).waitFor({ timeout: 15_000 })
  await ensureExpanded(page, column)
  await column.locator('[data-sidebar-right-guide-entry="files"]').click()
  await expect.poll(async () => await tabTitles(column)).toEqual(['Files'])
  await width(column)
  return column
}

/** Whether the element at the centre of `locator` is the locator's own element or a descendant. */
async function hitsItself(locator: Locator): Promise<boolean> {
  const point = await centre(locator)
  return await locator.evaluate((node, at) => {
    const hit = document.elementFromPoint(at.x, at.y)
    return hit !== null && node.contains(hit)
  }, point)
}

/**
 * Float a docked tab the way a user does: drag its chip clear of the docked
 * surface and release over the conversation.
 */
async function floatByDrag(page: Page, tab: Locator): Promise<void> {
  const surface = page.locator('[data-dockkit-surface]').first()
  const box = await surface.boundingBox()
  if (box === null) throw new Error('surface is not rendered')
  await dragTo(page, tab, { x: box.x - 240, y: box.y + box.height / 2 })
}

/**
 * Drag the frame's rightbar handle until the panel is `target` px wide (the
 * frame clamps to its own range). The handle sits on the panel's left edge, so
 * widening is a drag to the left.
 */
async function setPanelWidth(page: Page, target: number): Promise<void> {
  const panel = page.locator('[data-sidebar-right-panel]')
  const handle = page.locator('[data-side="rightbar"]').first()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const box = await panel.boundingBox()
    if (box === null) throw new Error('panel is not rendered')
    const delta = target - box.width
    if (Math.abs(delta) < 2) return
    const grip = await centre(handle)
    await page.mouse.move(grip.x, grip.y)
    await page.mouse.down()
    await page.mouse.move(grip.x - delta, grip.y, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(300)
  }
}

/** Tab titles inside one container, in strip order. */
/**
 * The closing prose's inline-code mention of the seeded file. The changed-files
 * card below the prose offers the same open under the same accessible name, so
 * the first match in document order is the prose's.
 */
function proseChip(root: Page): Locator {
  return root.getByRole('button', { name: `Open ${SAMPLE_NAME}` }).first()
}

async function tabTitles(root: Locator): Promise<string[]> {
  return await root.locator('[data-dockkit-tab-title]').allInnerTexts()
}

/** Compare the rendered glyph and text rather than their containing boxes. */
async function expectTitleAlignment(title: Locator): Promise<void> {
  const geometry = await title.evaluate((node) => {
    const icon = node.querySelector('svg')
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    let textBox: DOMRect | undefined
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent?.trim()) continue
      const range = document.createRange()
      range.selectNodeContents(walker.currentNode)
      const box = range.getBoundingClientRect()
      if (box.width > 0 && box.height > 0) {
        textBox = box
        break
      }
    }
    if (icon === null || textBox === undefined) throw new Error('tab icon or visible title text is missing')
    const iconBox = icon.getBoundingClientRect()
    return {
      gap: textBox.left - iconBox.right,
      centreOffset: Math.abs(iconBox.y + iconBox.height / 2 - textBox.y - textBox.height / 2),
    }
  })
  expect(geometry.gap).toBeCloseTo(5, 2)
  expect(geometry.centreOffset).toBeLessThan(1)
}

/**
 * A rendered width, read once the frame's track transition has settled.
 *
 * The frame eases its grid tracks, so a single sample taken right after a
 * gesture reports a frame of the animation. Column arithmetic is only exact at
 * rest, so this samples until three consecutive readings agree.
 */
async function width(locator: Locator): Promise<number> {
  let last = Number.NaN
  let steady = 0
  for (let attempt = 0; attempt < 80; attempt += 1) {
    // Layout width, not the visible box: a zero-width track is still an answer.
    const now = Math.round(await locator.evaluate(node => node.getBoundingClientRect().width))
    steady = now === last ? steady + 1 : 0
    if (steady === 2) return now
    last = now
    await locator.page().waitForTimeout(50)
  }
  throw new Error(`width never settled (last ${last}px)`)
}

describe('web e2e: shipped right Sidebar', () => {
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
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('shows nothing on the right while no session keys a surface', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-right-hero'))
    const frame = page.locator('[class*="frame"]').first()
    const column = page.locator('[data-rightbar-col]')
    await column.waitFor({ state: 'attached', timeout: 15_000 })

    // With no session there is no surface: no panel in the column, no expand
    // button in the header, and no track — the conversation reaches the frame's edge.
    expect(await frame.getAttribute('data-rightbar-collapsed')).toBe('true')
    expect(await column.locator('[data-sidebar-right-panel]').count()).toBe(0)
    expect(await expandOf(page).count()).toBe(0)
    expect(await width(column)).toBe(0)
    await shot(page, '01-hero-no-sidebar')

    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  describe('with a settled session', () => {
    beforeAll(async () => {
      await connectFreshWorkspace(page, scaffold.workspaceCwd)
      // A settled session is what keys the surface; seed one turn through the
      // real append path so the Chat surface is live before the Sidebar is driven.
      const agent = scaffold.ctx.agents.list()[0]
      if (agent === undefined) throw new Error('connected workspace did not create an Agent')
      // The wire parameter is `agentId`; the client passes a session id. If the
      // scaffold's Agent and Session carry different ids, that mismatch is the
      // silent lookup failure.
      expect(String(agent.id)).toBe(String(agent.session.id))
      agent.session.append('turn/start', { turn: 1 })
      agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Show the right sidebar.' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      agent.session.append('step/start', { turn: 1, step: 1 })
      // A successful mutation is what lets the closing prose link the file's
      // inline-code mention — the product's own way into the Sidebar. The file
      // is written for real because the preview reads it through the workspace
      // endpoint.
      //
      // It goes in the SESSION's cwd, not the scaffold's: the endpoint resolves
      // relative paths against the header-derived workspace root. Writing
      // anywhere else makes the read fail with workspace-file/not-found, which
      // is the endpoint being right.
      writeFileSync(join(agent.session.header.cwd ?? scaffold.workspaceCwd, SAMPLE_NAME), SAMPLE_TEXT, 'utf8')
      agent.session.append('tool/call', {
        turn: 1,
        step: 1,
        callId: 'call-write-1',
        name: 'write',
        arguments: JSON.stringify({ file_path: SAMPLE_NAME, content: SAMPLE_TEXT }),
      } as never)
      agent.session.append('tool/result', {
        turn: 1,
        step: 1,
        message: {
          id: 'result-call-write-1',
          role: 'tool',
          source: { kind: 'tool', callId: 'call-write-1' },
          toolCallId: 'call-write-1',
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
        },
      } as never, { surfaceOp: 'append' })
      agent.session.append('assistant/message', {
        stream: [],
        turn: 1,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: `Ready. Wrote \`${SAMPLE_NAME}\`.` }],
          source: { kind: 'model', provider: 'fixture', model: 'fixture' },
        }),
      }, { surfaceOp: 'append' })
      agent.session.append('step/end', { turn: 1, step: 1 })
      agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await scaffold.ctx.sessions.flush(agent.session)
      await page.getByText('Ready.').waitFor({ timeout: 10_000 })
    }, 120_000)

    it('CONTROL: the old fileReferences namespace answers over the same wire', async () => {
      const composer = page.locator('textarea, [contenteditable="true"]').first()
      await composer.click()
      await composer.pressSequentially('@')
      // Any candidate list means the agent-scoped lookup and the gateway route
      // both work in this scaffold; nothing rendered means the wire is the fault.
      const answered = await page.locator('[data-input-trigger], [role="listbox"], [data-reference-list]')
        .first().waitFor({ timeout: 10_000 }).then(() => true, () => false)
      await page.keyboard.press('Escape')
      // Leave the composer as it was found: these cases share one page, and a
      // stray '@' rides into every later assertion and screenshot. `fill('')`
      // does NOT clear this editor — it reported success while the character
      // stayed — so the reset is a real keystroke, and it is asserted rather
      // than assumed.
      await composer.click()
      await page.keyboard.press('ControlOrMeta+a')
      await page.keyboard.press('Backspace')
      await expect.poll(async () => (await composer.innerText()).trim()).toBe('')
      expect(answered).toBe(true)
    })

    it('starts collapsed behind a header button and squeezes the conversation when opened', async () => {
      onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-right'))
      const frame = page.locator('[class*="frame"]').first()
      const column = page.locator('[data-rightbar-col]')
      const conversation = page.locator('[class*="centerCol"]').first()
      const expand = expandOf(page)

      // Collapsed default: no track, the panel sits off the frame's edge, and
      // the only way in is the header button — on the same row as the other
      // header utilities, at its far right.
      await expand.waitFor({ timeout: 15_000 })
      expect(await frame.getAttribute('data-rightbar-collapsed')).toBe('true')
      expect(await column.locator('[data-sidebar-right-open]').count()).toBe(0)
      const utilities = page.locator('[class*="headerUtilities"]')
      const expandBox = await expand.boundingBox()
      const rowBox = await utilities.boundingBox()
      if (expandBox === null || rowBox === null) throw new Error('header utilities are not rendered')
      expect(Math.round(expandBox.y + expandBox.height / 2)).toBe(Math.round(rowBox.y + rowBox.height / 2))
      const more = utilities.getByRole('button', { name: 'More actions', exact: true })
      let hoverFill: string | undefined
      for (const action of [more, expand]) {
        await action.hover()
        const appearance = await action.evaluate((node) => {
          const style = getComputedStyle(node)
          const box = node.getBoundingClientRect()
          return { width: box.width, height: box.height, radius: style.borderRadius, fill: style.backgroundColor }
        })
        expect(appearance).toMatchObject({ width: 28, height: 28, radius: '8px' })
        expect(appearance.fill).not.toBe('rgba(0, 0, 0, 0)')
        if (hoverFill === undefined) hoverFill = appearance.fill
        else expect(appearance.fill).toBe(hoverFill)
      }
      // Its own corner seat, past the utilities' right edge — not a utility.
      expect(expandBox.x).toBeGreaterThan(rowBox.x + rowBox.width)
      const conversationBoxBefore = await conversation.boundingBox()
      if (conversationBoxBefore === null) throw new Error('conversation is not rendered')
      // How far the utilities' right edge sits from the conversation's own.
      const gapBefore = (conversationBoxBefore.x + conversationBoxBefore.width) - (rowBox.x + rowBox.width)
      const centerBefore = await width(conversation)
      await shot(page, '02a-collapsed-header-button')

      // Opening squeezes by default: the column takes a track of the panel's
      // width, the conversation gives up exactly that much room, and the header
      // button leaves with the panel's arrival.
      await expand.click()
      await expect.poll(async () => await frame.getAttribute('data-rightbar-collapsed')).toBe(null)
      await expect.poll(async () => await column.locator('[data-sidebar-right-open]').count()).toBe(1)
      const panelWidth = await width(column)
      expect(panelWidth).toBeGreaterThan(0)
      expect(await width(conversation)).toBe(centerBefore - panelWidth)
      await expect.poll(async () => await expand.count()).toBe(0)
      // The corner seat collapses with its button, so the utilities' right edge
      // moves out toward the conversation's own.
      const utilitiesAfter = await utilities.boundingBox()
      const conversationAfter = await conversation.boundingBox()
      if (utilitiesAfter === null || conversationAfter === null) throw new Error('header is not rendered')
      const gapAfter = (conversationAfter.x + conversationAfter.width) - (utilitiesAfter.x + utilitiesAfter.width)
      expect(gapAfter).toBeLessThan(gapBefore)

      // The panel is in the column, not over it, and carries the seeded tab —
      // whose body arrives through the Files type's keyed registration, not from
      // any dispatch inside the seat. Its two controls sit at the end of the
      // top-right pane's strip: the panel has no header row of its own.
      expect(await column.locator('[data-sidebar-right-panel="push"]').count()).toBe(1)
      const chrome = column.locator('[data-dockkit-strip-chrome]')
      expect(await chrome.count()).toBe(1)
      expect(await chrome.locator('[data-sidebar-right-mode]').count()).toBe(1)
      expect(await chrome.locator('[data-sidebar-right-toggle]').count()).toBe(1)

      // One centre line across the strip: chip text, split, and the two panel
      // controls all sit at the same height. The add control joins the check below.
      const centreY = async (selector: string): Promise<number> => {
        const box = await column.locator(selector).first().boundingBox()
        if (box === null) throw new Error(`${selector} is not rendered`)
        return Math.round(box.y + box.height / 2)
      }
      const textLine = await centreY('[data-dockkit-tab-title]')
      for (const selector of ['[data-dockkit-split-button]', '[data-sidebar-right-mode]', '[data-sidebar-right-toggle]']) {
        expect(await centreY(selector), selector).toBe(textLine)
      }

      await expect.poll(async () => await tabTitles(column)).toEqual(['Start'])
      await expectTitleAlignment(column.locator('[data-dockkit-tab-title]'))
      await expect.poll(async () => await column.locator('[data-sidebar-right-guide-entry]').count()).toBe(2)
      expect(await column.locator('[data-sidebar-right-guide-entry="browser"]').count()).toBe(0)
      await column.locator('[data-sidebar-right-guide-entry="files"]').click()

      // A manual guide is closable beside Files and suppresses another add
      // control in its pane until it is closed.
      const addTab = column.locator('[data-dockkit-add-tab]')
      const filesTab = column.locator('[data-dockkit-tab]').filter({ hasText: 'Files' })
      await expect.poll(async () => await tabTitles(column)).toEqual(['Files'])
      await expectTitleAlignment(filesTab.locator('[data-dockkit-tab-title]'))
      await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
      expect(await filesTab.locator('[data-dockkit-tab-close]').count()).toBe(1)
      await expect.poll(async () => await addTab.count()).toBe(1)
      expect(await centreY('[data-dockkit-add-tab]')).toBe(textLine)
      await addTab.click()
      await expect.poll(async () => await tabTitles(column)).toEqual(['Files', 'Start'])
      await expect.poll(async () => await column.locator('[data-sidebar-right-guide]').count()).toBe(1)
      await expect.poll(async () => await addTab.count()).toBe(0)
      expect(await filesTab.locator('[data-dockkit-tab-close]').count()).toBe(1)
      const guideTab = column.locator('[data-dockkit-tab]').filter({ hasText: 'Start' })
      expect(await guideTab.locator('[data-dockkit-tab-close]').count()).toBe(1)
      // Back to the seeded shape the cases below start from.
      await guideTab.hover()
      await guideTab.locator('[data-dockkit-tab-close]').click()
      await expect.poll(async () => await tabTitles(column)).toEqual(['Files'])
      await expect.poll(async () => await addTab.count()).toBe(1)
      await shot(page, '02-squeezed-panel')

      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    })

    it('covers the viewport in fullscreen without changing the underlying columns', async () => {
      onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-right-mode'))
      const frame = page.locator('[class*="frame"]').first()
      const column = page.locator('[data-rightbar-col]')
      const panel = column.locator('[data-sidebar-right-panel]')
      const conversation = page.locator('[class*="centerCol"]').first()
      const squeezed = await width(conversation)
      const before = await panel.boundingBox()
      const trackWidth = await width(column)

      await column.locator('[data-sidebar-right-mode="fullscreen"]').click()
      await expect.poll(async () => await panel.getAttribute('data-sidebar-right-panel')).toBe('fullscreen')
      expect(await frame.getAttribute('data-rightbar-collapsed')).toBe(null)
      expect(await width(conversation)).toBe(squeezed)
      expect(await width(column)).toBe(trackWidth)
      const viewport = page.viewportSize()
      if (viewport === null) throw new Error('expected a fixed viewport')
      await expect.poll(async () => await panel.boundingBox()).toEqual({ x: 0, y: 0, ...viewport })
      expect(await expandOf(page).count()).toBe(0)
      expect(await frame.locator('[data-side="rightbar"]').count()).toBe(0)
      await shot(page, '03-fullscreen-panel')

      await column.locator('[data-sidebar-right-mode="push"]').click()
      await expect.poll(async () => await panel.getAttribute('data-sidebar-right-panel')).toBe('push')
      expect(await width(conversation)).toBe(squeezed)
      expect(await panel.boundingBox()).toEqual(before)

      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    })

    it('keeps the conversation still during fullscreen entry and installs the hidden track without animation', async () => {
      onTestFailed(() => saveFailureShot(page, 'screenshots/0907-sidebar-rules/sidebar-right-fullscreen-entry'))
      mkdirSync(SHOT_DIR, { recursive: true })
      const column = await resetSidebar(page)
      const frame = page.locator('[class*="frame"]').first()
      const panel = column.locator('[data-sidebar-right-panel]')
      const viewport = page.viewportSize()
      if (viewport === null) throw new Error('expected a fixed viewport')
      const geometry = () => frame.evaluate(node => ({
        columns: getComputedStyle(node).gridTemplateColumns,
        transition: getComputedStyle(node).transitionProperty,
        handles: [...node.querySelectorAll('[data-side="sidebar"], [data-side="rightbar"]')]
          .map(handle => getComputedStyle(handle).transitionProperty),
        animatingGrid: node.getAnimations().some(animation =>
          'transitionProperty' in animation && animation.transitionProperty === 'grid-template-columns'
          && animation.playState !== 'finished' && animation.playState !== 'idle'),
      }))
      await frame.evaluate(async (node) => { await Promise.allSettled(node.getAnimations().map(animation => animation.finished)) })
      const normalColumns = (await geometry()).columns
      await column.locator('[data-sidebar-right-mode="fullscreen"]').click()
      await expect.poll(() => panel.boundingBox()).toEqual({ x: 0, y: 0, ...viewport })
      await column.locator('[data-sidebar-right-toggle]').click()
      await Promise.all([
        panel.evaluate(async (node) => {
          await Promise.allSettled(node.getAnimations({ subtree: true }).map(animation => animation.finished))
        }),
        frame.evaluate(async (node) => { await Promise.allSettled(node.getAnimations().map(animation => animation.finished)) }),
      ])
      const closedColumns = (await geometry()).columns
      expect(closedColumns).not.toBe(normalColumns)
      await page.emulateMedia({ reducedMotion: 'no-preference' })

      // Pause the real CSS transition at its midpoint so host scheduling cannot
      // skip the partly covered frame whose underlying width is under test.
      const held = await holdPanelSlide(panel)
      try {
        await expandOf(page).click()
        await expect.poll(() => held.evaluate(state => state.animation?.playState)).toBe('paused')
        const entering = await paneAt(column, 0).boundingBox()
        if (entering === null) throw new Error('entering panel is not rendered')
        expect(entering.x).toBeGreaterThan(0)
        expect(entering.x).toBeLessThan(viewport.width)
        expect((await geometry()).columns).toBe(closedColumns)
        expect((await geometry()).animatingGrid).toBe(false)
        expect(await frame.getAttribute('data-rightbar-fullscreen')).toBeNull()

        await held.evaluate((state) => { (state.animation as Animation).finish() })
        await expect.poll(() => frame.getAttribute('data-rightbar-fullscreen')).toBe('true')
        expect(await panel.boundingBox()).toEqual({ x: 0, y: 0, ...viewport })
        expect(await geometry()).toEqual({ columns: normalColumns, transition: 'none', handles: ['none'], animatingGrid: false })

        const exit = await holdPanelSlide(panel)
        try {
          await column.locator('[data-sidebar-right-toggle]').click()
          await expect.poll(() => exit.evaluate(state => state.animation?.playState)).toBe('paused')
          expect(await exit.evaluate(state => state.columnsAtStart)).toBe(closedColumns)
          const leaving = await paneAt(column, 0).boundingBox()
          if (leaving === null) throw new Error('leaving panel is not rendered')
          expect(leaving.x).toBeGreaterThan(0)
          expect(leaving.x).toBeLessThan(viewport.width)
          expect(await geometry()).toEqual({ columns: closedColumns, transition: 'none', handles: ['none'], animatingGrid: false })
          await exit.evaluate((state) => { (state.animation as Animation).finish() })
          expect((await geometry()).columns).toBe(closedColumns)
        } finally {
          await exit.evaluate((state) => {
            state.dispose()
            if (state.animation?.playState === 'paused') state.animation.finish()
          })
          await exit.dispose()
        }

        await expandOf(page).click()
        await expect.poll(() => frame.getAttribute('data-rightbar-fullscreen')).toBe('true')
        await column.locator('[data-sidebar-right-mode="push"]').click()
        expect((await geometry()).columns).toBe(normalColumns)
        expect((await geometry()).animatingGrid).toBe(false)

        await page.emulateMedia({ reducedMotion: 'reduce' })
        await column.locator('[data-sidebar-right-mode="fullscreen"]').click()
        await column.locator('[data-sidebar-right-toggle]').click()
        await expect.poll(() => frame.getAttribute('data-rightbar-fullscreen')).toBeNull()
        await expandOf(page).click()
        await expect.poll(() => frame.getAttribute('data-rightbar-fullscreen')).toBe('true')
        expect(await panel.boundingBox()).toEqual({ x: 0, y: 0, ...viewport })
        expect((await geometry()).columns).toBe(normalColumns)
        expect((await geometry()).animatingGrid).toBe(false)
      } finally {
        await held.evaluate((state) => {
          state.dispose()
          if (state.animation?.playState === 'paused') state.animation.finish()
        })
        await held.dispose()
        try {
          if (await panel.getAttribute('data-sidebar-right-panel') === 'fullscreen'
            && await panel.getAttribute('data-sidebar-right-open') !== null) {
            await column.locator('[data-sidebar-right-mode="push"]').click()
          }
        } finally {
          await page.emulateMedia({ reducedMotion: null })
        }
      }
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    })

    it('keeps a capacity-closed panel closed after widening and uses fullscreen on a narrow viewport', async () => {
      const viewport = page.viewportSize()
      if (viewport === null) throw new Error('expected a fixed viewport')
      const frame = page.locator('[class*="frame"]').first()
      const column = page.locator('[data-rightbar-col]')
      const sidebar = page.locator('[class*="sidebarCol"]').first()
      const panel = column.locator('[data-sidebar-right-panel]')
      try {
        await page.setViewportSize({ width: 1024, height: viewport.height })
        const leftGrip = frame.locator('[data-side="sidebar"]')
        const grip = await centre(leftGrip)
        await dragElement(page, leftGrip, { x: 420, y: grip.y })
        await expect.poll(async () => await width(sidebar)).toBe(420)
        await expect.poll(async () => await column.locator('[data-sidebar-right-open]').count()).toBe(0)
        await page.setViewportSize(viewport)
        await expect.poll(async () => await width(sidebar)).toBe(420)
        expect(await column.locator('[data-sidebar-right-open]').count()).toBe(0)
        await expandOf(page).click()
        await expect.poll(async () => await column.locator('[data-sidebar-right-open]').count()).toBe(1)

        await page.setViewportSize({ width: 767, height: viewport.height })
        await expect.poll(async () => await panel.getAttribute('data-sidebar-right-panel')).toBe('fullscreen')
        await expect.poll(async () => await width(panel)).toBe(767)
        await expect.poll(() => frame.getAttribute('data-rightbar-fullscreen')).toBe('true')
        expect(await frame.locator('[data-side="rightbar"]').count()).toBe(0)
        await column.locator('[data-sidebar-right-mode="push"]').click()
        await expect.poll(async () => await column.locator('[data-sidebar-right-open]').count()).toBe(0)
        await page.setViewportSize(viewport)
        await expect.poll(async () => await width(sidebar)).toBe(420)
        expect(await column.locator('[data-sidebar-right-open]').count()).toBe(0)
      } finally {
        await page.setViewportSize(viewport)
        const grip = await centre(frame.locator('[data-side="sidebar"]'))
        await dragElement(page, frame.locator('[data-side="sidebar"]'), { x: 280, y: grip.y })
        await expect.poll(async () => await width(sidebar)).toBe(280)
        await ensureExpanded(page, column)
      }
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    })

    it('survives grip drags past both clamps on a squeezed viewport', async () => {
      // Regression: an overshoot drag swept the panel through widths where a
      // width-blocked split control hid itself, which changed the very strip
      // measurement that had blocked it — a layout-effect feedback loop that
      // crashed the pane (React error #185) and unmounted the rightbar slot
      // entry while the column still believed it was expanded, so neither the
      // panel nor the header's expand button remained. The crash surfaces only
      // as a console error, which the scaffold tripwire does not watch, so this
      // case collects console errors itself.
      const viewport = page.viewportSize()
      if (viewport === null) throw new Error('expected a fixed viewport')
      const column = await resetSidebar(page)
      const frame = page.locator('[class*="frame"]').first()
      const panel = column.locator('[data-sidebar-right-panel]')
      const consoleErrors: string[] = []
      const collect = (message: ConsoleMessage): void => {
        if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 600))
      }
      page.on('console', collect)
      try {
        await page.setViewportSize({ width: 1000, height: viewport.height })
        await ensureExpanded(page, column)
        await width(column)
        const grip = frame.locator('[data-side="rightbar"]')
        // The frame reads the new viewport through a throttled ResizeObserver,
        // a couple of frames after the resize; until then the grip sits at the
        // old frame's coordinates. Press only a grip aligned with the panel's
        // left edge (the handle is 8px wide, centred on the seam).
        await expect.poll(async () => {
          const gripBox = await grip.boundingBox()
          const panelBox = await panel.boundingBox()
          if (gripBox === null || panelBox === null) return Number.NaN
          return Math.abs(gripBox.x + 4 - panelBox.x)
        }).toBeLessThanOrEqual(1)
        // Narrow with overshoot: drag the grip far right past the clamp floor.
        const from = await centre(grip)
        await page.mouse.move(from.x, from.y)
        await page.mouse.down()
        await page.mouse.move(980, from.y, { steps: 30 })
        await page.mouse.up()
        // The panel holds its floor, still open, with its grip still rendered.
        await expect.poll(async () => await width(panel)).toBeLessThanOrEqual(302)
        expect(await width(panel)).toBeGreaterThanOrEqual(300)
        expect(await column.locator('[data-sidebar-right-open]').count()).toBe(1)
        expect(await grip.count()).toBe(1)
        // Widen with overshoot to the far left: clamped by the frame's range.
        const back = await centre(grip)
        await page.mouse.move(back.x, back.y)
        await page.mouse.down()
        await page.mouse.move(20, back.y, { steps: 30 })
        await page.mouse.up()
        const widened = await width(panel)
        expect(widened).toBeGreaterThan(302)
        expect(widened).toBeLessThan(1000)
        expect(await column.locator('[data-sidebar-right-open]').count()).toBe(1)
        expect(await grip.count()).toBe(1)
        expect(consoleErrors).toEqual([])
        expect(tripwire.pageErrors).toEqual([])
        expect(tripwire.warnings).toEqual([])
      } finally {
        page.off('console', collect)
        await page.setViewportSize(viewport)
        await ensureExpanded(page, column)
        await setPanelWidth(page, Math.round(viewport.width * 0.45))
      }
    }, 60_000)

    it('CONTROL: the host endpoint answers when called directly, bypassing the wire', async () => {
      const files = (scaffold.ctx as {
        get(name: string): {
          read(
            scope: { sessionId: string; workspaceRoot: string },
            path: string,
            range: object,
            signal: AbortSignal,
          ): Promise<{ text: string; eof: boolean }>
        } | undefined
      }).get('workspaceFiles')
      if (files === undefined) throw new Error('host endpoint is not provided')
      const agent = scaffold.ctx.agents.list()[0]
      if (agent === undefined) throw new Error('no Agent to read for')
      const scope = {
        sessionId: agent.session.id,
        workspaceRoot: agent.session.header.cwd ?? scaffold.workspaceCwd,
      }

      // Raced against a timer so a hang reports a verdict instead of stalling
      // the suite: this case exists to tell host logic apart from the wire.
      // A page is the file's lines joined by `\n`, without the final terminator.
      const verdict = await Promise.race([
        files.read(scope, SAMPLE_NAME, {}, new AbortController().signal)
          .then(value => ({ kind: 'settled' as const, text: value.text, eof: value.eof }))
          .catch((error: unknown) => ({ kind: 'threw' as const, text: String(error), eof: false })),
        new Promise<{ kind: 'hung'; text: string; eof: boolean }>((resolve) => {
          setTimeout(() => { resolve({ kind: 'hung', text: 'no settlement in 10s', eof: false }) }, 10_000)
        }),
      ])
      expect(verdict).toEqual({ kind: 'settled', text: SAMPLE_TEXT.replace(/\n$/u, ''), eof: true })
    }, 30_000)

    it('opens content once, splits, and floats it outside the column', async () => {
      onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-right-content'))
      const column = page.locator('[data-rightbar-col]')
      const panes = column.locator('[data-dockkit-pane]')
      const floats = page.locator('[data-sidebar-right-session]:not([hidden]) [data-dockkit-float]')

      // Observation before action: does the read ever leave the browser? The
      // assertion states the healthy answer so a failure prints the real one.
      //
      // CAVEAT: `sent` is trustworthy — a request frame carries the endpoint
      // name. `received` is NOT: a response frame carries only its rpc id, so a
      // zero here means "my filter saw nothing", not "the host never answered".
      // Correlate by rpc id before drawing any conclusion from it.
      const wire = { sent: 0, received: 0 }
      const watch = (payload: string): void => {
        if (!payload.includes('workspaceFiles')) return
        wire.sent += 1
      }
      page.on('websocket', (ws) => {
        ws.on('framesent', (frame) => { watch(String(frame.payload)) })
        ws.on('framereceived', (frame) => {
          if (String(frame.payload).includes('workspaceFiles')) wire.received += 1
        })
      })
      page.on('request', (request) => {
        if (request.url().includes('workspaceFiles')) wire.sent += 1
      })

      // The product's own entry point: the closing prose's file mention. It
      // reaches the Sidebar through openFile → ctx.sidebarRight.openResource, and the
      // text type claims the address.
      const chip = proseChip(page)
      await chip.click()
      await expect.poll(async () => await tabTitles(column)).toEqual(['Files', SAMPLE_NAME])

      // Opening the same content again focuses rather than duplicating.
      await paneAt(column, 0).locator('[data-dockkit-tab]').first().click()
      await chip.click()
      await expect.poll(async () => await tabTitles(column)).toEqual(['Files', SAMPLE_NAME])

      // The body arrives through the text type's keyed registration, and its
      // content came over the wire from the real file.
      // A real Remote round-trip settles well after the default poll window.
      await column.locator('[data-textpreview-state="text"]')
        .waitFor({ timeout: 15_000 })
        .catch(() => { throw new Error(`preview never settled; wire=${JSON.stringify(wire)}`) })
      expect(await column.locator('pre').first().innerText()).toContain('produced by the seeded turn')
      // The whole batch-E chain in one frame: a file mention in the
      // conversation, the tab it opened, and the file's real content read over
      // the workspace endpoint.
      await shot(page, '06-produced-chip-to-preview')

      // The directory scenario's V1 behaviour, asserted in the shipped product:
      // the prose mention offers no folder affordance. `openFile('.')` would
      // name a directory, which a text preview correctly refuses. The only
      // folder action on the page is the changed-files card's header, and only
      // when the Host has a desktop.
      const folders = page.getByRole('button', { name: /folder/i })
      expect(await folders.count()).toBe(await page.locator('[data-changed-files]').getByRole('button', { name: /folder/i }).count())

      // Split, then dock-drag: the kit's gestures drive the store's actions.
      await paneAt(column, 0).locator('[data-dockkit-split-button]').click()
      await expect.poll(async () => await panes.count()).toBe(2)
      await dragTo(
        page,
        column.locator('[data-dockkit-tab]').filter({ hasText: SAMPLE_NAME }).first(),
        await pointIn(paneAt(column, 1), 0.5, 0.94),
      )
      await expect.poll(async () => await panes.count()).toBe(2)

      const splitGuide = paneAt(column, 1).locator('[data-dockkit-tab]').filter({ hasText: 'Start' })
      expect(await splitGuide.locator('[data-dockkit-tab-close]').count()).toBe(1)
      await dragTo(page, splitGuide, await pointIn(paneAt(column, 0), 0.5, 0.5))
      await expect.poll(async () => await tabTitles(paneAt(column, 1))).toEqual([SAMPLE_NAME])
      const movedGuide = paneAt(column, 0).locator('[data-dockkit-tab]').filter({ hasText: 'Start' })
      await movedGuide.hover()
      await movedGuide.locator('[data-dockkit-tab-close]').click()

      // Neither pane holds a guide, so both offer an add control.
      const filePane = panes.filter({ has: page.locator('[data-dockkit-tab-title]', { hasText: SAMPLE_NAME }) })
      await expect.poll(async () => await filePane.locator('[data-dockkit-add-tab]').count()).toBe(1)
      expect(await column.locator('[data-dockkit-add-tab]').count()).toBe(2)

      // A float stays in the DOM column but draws outside it and survives collapse.
      const tab = column.locator('[data-dockkit-tab]').filter({ hasText: SAMPLE_NAME }).first()
      await floatByDrag(page, tab)
      await expect.poll(async () => await floats.count()).toBe(1)
      expect(await column.locator('[data-dockkit-float]').count()).toBe(1)
      const floatBox = await floats.first().boundingBox()
      const columnBox = await column.boundingBox()
      if (floatBox === null || columnBox === null) throw new Error('float or column is not rendered')
      expect(floatBox.x).toBeLessThan(columnBox.x)
      await expect.poll(async () => await panes.count()).toBe(1)
      await shot(page, '04-split-and-float')

      await column.locator('[data-sidebar-right-toggle]').click()
      await expect.poll(async () => await column.locator('[data-sidebar-right-open]').count()).toBe(0)
      expect(await floats.count()).toBe(1)

      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    })

    // §9.2 (an explicit second copy of the same content) has no control on the
    // panel by product decision, and copy has no service method yet:
    // `duplicateTab` is a store/kit intent only, which service.client.spec.ts covers.

    it('keeps each session\'s surface to itself across switching and page reload', async () => {
      const fx = await newEnglishPage(browser)
      const fxTripwire = watchConsole(fx)
      onTestFailed(() => saveFailureShot(fx, 'web-e2e-sidebar-right-sessions'))
      try {
        await fx.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
        const settled = fx.getByRole('treeitem', { name: /Show the right sidebar\./u }).first()
        await settled.click()
        await expect.poll(async () => await settled.getAttribute('aria-selected')).toBe('true')
        const frame = fx.locator('[class*="frame"]').first()
        const column = fx.locator('[data-rightbar-col]')
        await ensureExpanded(fx, column)
        await width(column)
        await proseChip(fx).click()
        await column.locator('[data-textpreview-state="text"]').waitFor({ timeout: 15_000 })
        const wrap = column.locator('[data-textpreview-tool="wrap"]')
        expect(await wrap.getAttribute('aria-pressed')).toBe('true')
        await wrap.click()
        await expect.poll(async () => await wrap.getAttribute('aria-pressed')).toBe('false')
        await column.locator('[data-dockkit-split-button]').first().click()
        const panes = column.locator('[data-dockkit-pane]')
        await expect.poll(async () => await panes.count()).toBe(2)
        const records = async (): Promise<{ panes: string[]; tabs: string[]; titles: string[] }> => ({
          panes: await panes.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-dockkit-pane')!)),
          tabs: await column.locator('[data-dockkit-tab]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-dockkit-tab')!)),
          titles: await tabTitles(column),
        })
        const before = await records()

        // The real New Session action selects a distinct blank Session; its
        // collapsed surface must not inherit the settled Session's tabs.
        await fx.getByRole('button', { name: 'New session', exact: true }).last().click()
        await expect.poll(async () => await settled.getAttribute('aria-selected')).toBe('false')
        await expect.poll(async () => await frame.getAttribute('data-rightbar-collapsed')).toBe('true')
        expect(await column.locator('[data-sidebar-right-open]').count()).toBe(0)
        expect(await column.locator('[data-textpreview-state="text"]').count()).toBe(0)

        await settled.click()
        await expect.poll(async () => await settled.getAttribute('aria-selected')).toBe('true')
        await expect.poll(records, { timeout: 15_000 }).toEqual(before)
        expect(await column.locator('[data-sidebar-right-open]').count()).toBe(1)
        expect(await wrap.getAttribute('aria-pressed')).toBe('true')
        expect(await column.locator('pre').first().innerText()).toContain('produced by the seeded turn')
        let warningStart = fxTripwire.warnings.length
        await fx.reload({ waitUntil: 'load' })
        acknowledgeReloadConnectionLoss(fxTripwire, warningStart)
        await expect.poll(records, { timeout: 15_000 }).toEqual(before)
        await expect.poll(async () => await column.locator('pre').first().innerText()).toContain('produced by the seeded turn')
        await column.locator('[data-sidebar-right-toggle]').click()
        warningStart = fxTripwire.warnings.length
        await fx.reload({ waitUntil: 'load' })
        acknowledgeReloadConnectionLoss(fxTripwire, warningStart)
        await fx.locator('[data-sidebar-right-expand]').waitFor()
        expect(await column.locator('[data-sidebar-right-open]').count()).toBe(0)
        await fx.locator('[data-sidebar-right-expand]').click()
        await expect.poll(records, { timeout: 15_000 }).toEqual(before)
        expect(await width(column)).toBeGreaterThan(0)
        await column.locator('[data-sidebar-right-panel]').evaluate(async (node) => {
          await Promise.allSettled(node.getAnimations().map(animation => animation.finished))
        })
        await shot(fx, 'session-layout-restored')
        expect(fxTripwire.pageErrors).toEqual([])
        expect(fxTripwire.warnings).toEqual([])
      } finally {
        await fx.close()
      }
    }, 120_000)

    it('§9.3/§9.4 runs the whole pointer chain in a real browser', async () => {
      onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-right-gestures'))
      const column = await resetSidebar(page)
      const panes = column.locator('[data-dockkit-pane]')
      const floats = page.locator('[data-sidebar-right-session]:not([hidden]) [data-dockkit-float]')

      // Chromium cancels pointer capture if a render replaces the pressed
      // element; jsdom cannot establish that the whole gesture survives.

      // 1. Reorder inside one strip: drop the last tab left of its neighbours.
      //    The first pane needs two tabs for this — and for the move below to
      //    leave it standing, since a pane emptied by a move is dropped.
      const first = paneAt(column, 0)
      const strip = first.locator('[data-dockkit-strip]')
      await proseChip(page).click()
      await expect.poll(async () => await tabTitles(first)).toEqual(['Files', SAMPLE_NAME])
      const order = await tabTitles(first)
      // The insertion index is measured against chip midpoints, not strip width.
      await dragTo(page, first.locator('[data-dockkit-tab]').last(),
        await pointIn(first.locator('[data-dockkit-tab]').first(), 0.25, 0.5),
        strip.locator('[data-dockkit-caret="0"]'))
      await expect.poll(async () => await tabTitles(first)).toEqual([...order].reverse())

      // 2. Cross-pane move into a second pane: the tab leaves one pane's strip
      //    for another's.
      if (await panes.count() < 2) {
        await first.locator('[data-dockkit-split-button]').click()
        await expect.poll(async () => await panes.count()).toBe(2)
      }
      const moving = first.locator('[data-dockkit-tab]').first()
      const title = await moving.locator('[data-dockkit-tab-title]').innerText()
      await dragTo(page, moving, await pointIn(paneAt(column, 1), 0.5, 0.5))
      await expect.poll(async () => await tabTitles(paneAt(column, 1))).toContain(title)

      const splitButtons = column.locator('[data-dockkit-split-button]')
      await expect.poll(async () => await splitButtons.count()).toBe(2)
      expect(await splitButtons.evaluateAll(buttons => buttons.every(button => (button as HTMLButtonElement).disabled))).toBe(true)
      expect(await panes.count()).toBe(2)
      await setPanelWidth(page, 560)
      expect(await splitButtons.evaluateAll(buttons => buttons.every(button => (button as HTMLButtonElement).disabled))).toBe(true)

      const outer = column.locator('[data-dockkit-divider]').first()
      const before = await width(paneAt(column, 1))
      const grip = await centre(outer)
      await dragElement(page, outer, { x: grip.x - 100, y: grip.y })
      await expect.poll(async () => await width(paneAt(column, 1))).toBeGreaterThan(before)
      await dragElement(page, outer, { x: 0, y: grip.y })
      const ratio = async (): Promise<number> => {
        const left = await width(paneAt(column, 0))
        const right = await width(paneAt(column, 1))
        return left / (left + right)
      }
      await expect.poll(ratio).toBeCloseTo(0.2, 2)
      const surfaceBox = await column.locator('[data-dockkit-surface]').boundingBox()
      if (surfaceBox === null) throw new Error('surface is not rendered')
      await dragElement(page, outer, { x: surfaceBox.x + surfaceBox.width / 2, y: grip.y })
      await expect.poll(ratio).toBeCloseTo(0.5, 2)
      expect(await panes.count()).toBe(2)
      expect(await splitButtons.evaluateAll(buttons => buttons.every(button => (button as HTMLButtonElement).disabled))).toBe(true)

      // 5. The split's guide and the document float while Files stays docked.
      const floatOne = paneAt(column, 1).locator('[data-dockkit-tab]').filter({ hasText: SAMPLE_NAME })
      await floatByDrag(page, floatOne)
      await expect.poll(async () => await floats.count()).toBe(1)
      await expectTitleAlignment(floats.first().locator('[data-dockkit-tab-title]'))
      const box = await floats.first().boundingBox()
      if (box === null) throw new Error('float is not rendered')
      await dragElement(page, floats.first().locator('[data-dockkit-float-grip]'), { x: box.x + 140, y: box.y + 90 })
      await expect.poll(async () => (await floats.first().boundingBox())?.x ?? box.x).not.toBe(box.x)

      await expect.poll(async () => await tabTitles(paneAt(column, 1))).toEqual(['Start'])
      const second = paneAt(column, 1).locator('[data-dockkit-tab]').filter({ hasText: 'Start' })
      await floatByDrag(page, second)
      await expect.poll(async () => await floats.count()).toBe(2)
      await expectTitleAlignment(floats.last().locator('[data-dockkit-tab-title]'))

      // 6. Dock one back: the docked tree takes it, the other float stays. Dock
      //    the TOPMOST float — floats render bottom-to-top, so the newest one
      //    covers the older one's controls and would intercept the click.
      await floats.last().locator('[data-dockkit-float-dock]').click()
      await expect.poll(async () => await floats.count()).toBe(1)

      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    }, 90_000)

    it('drops a pane whose last tab closes, and follows the last-tab rule on the surface', async () => {
      onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-right-settle'))
      const column = await resetSidebar(page)
      const panes = column.locator('[data-dockkit-pane]')
      expect(await column.locator('[data-dockkit-tab-close]').count()).toBe(1)
      await proseChip(page).click()
      await expect.poll(async () => await tabTitles(paneAt(column, 0))).toEqual(['Files', SAMPLE_NAME])
      await paneAt(column, 0).locator('[data-dockkit-split-button]').click()
      await expect.poll(async () => await panes.count()).toBe(2)

      // Closing a pane's last tab drops the pane: there is no separate
      // "close pane" gesture, and none is needed.
      await paneAt(column, 1).locator('[data-dockkit-tab]').first().hover()
      await paneAt(column, 1).locator('[data-dockkit-tab-close]').first().click()
      await expect.poll(async () => await panes.count()).toBe(1)
      await expect.poll(async () => await tabTitles(column)).toEqual(['Files', SAMPLE_NAME])

      // Leave a guide as the sole docked tab.
      const files = column.locator('[data-dockkit-tab]').filter({ hasText: 'Files' })
      await files.hover()
      await files.locator('[data-dockkit-tab-close]').click()
      await column.locator('[data-dockkit-add-tab]').click()
      await expect.poll(async () => await tabTitles(column)).toEqual([SAMPLE_NAME, 'Start'])
      const sample = column.locator('[data-dockkit-tab]').filter({ hasText: SAMPLE_NAME })
      await sample.hover()
      await sample.locator('[data-dockkit-tab-close]').click()
      await expect.poll(async () => await tabTitles(column)).toEqual(['Start'])

      // The guide standing as the docked surface's only tab draws no close
      // control, sits quiet (no capsule, no hover fill), and a secondary press
      // opens no menu: an empty menu never shows.
      expect(await column.locator('[data-dockkit-tab-close]').count()).toBe(0)
      expect(await column.locator('[data-dockkit-tab-quiet]').count()).toBe(1)
      await column.locator('[data-dockkit-tab]').first().click({ button: 'right' })
      expect(await page.locator('[data-dockkit-tab-menu]').isVisible()).toBe(false)
      expect(await page.getByRole('menu').count()).toBe(0)

      // Any other tab standing alone closes together with the column. Open the
      // sample file, close the guide (an ordinary close with two tabs), then
      // close the file: the column collapses in the same gesture, and the
      // settle rule reseeds the current default, so reopening shows Start.
      await proseChip(page).click()
      await expect.poll(async () => await tabTitles(column)).toEqual(['Start', SAMPLE_NAME])
      await column.locator('[data-dockkit-tab]').first().hover()
      await column.locator('[data-dockkit-tab-close]').first().click()
      await expect.poll(async () => await tabTitles(column)).toEqual([SAMPLE_NAME])
      await column.locator('[data-dockkit-tab]').first().hover()
      await column.locator('[data-dockkit-tab-close]').first().click()
      await expect.poll(async () => await column.locator('[data-sidebar-right-open]').count()).toBe(0)
      await expandOf(page).click()
      await expect.poll(async () => await tabTitles(column)).toEqual(['Start'])
      expect(await column.locator('[data-sidebar-right-guide]').count()).toBe(1)

      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    }, 90_000)

    it('preserves the open surface after a reload', async () => {
      onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-right-reload'))
      const frame = page.locator('[class*="frame"]').first()
      const column = page.locator('[data-rightbar-col]')
      await ensureExpanded(page, column)
      const titles = await tabTitles(column)
      await page.reload({ waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await column.waitFor({ state: 'attached', timeout: 15_000 })
      await expect.poll(async () => await tabTitles(column)).toEqual(titles)
      await expect.poll(async () => await frame.getAttribute('data-rightbar-collapsed')).toBe(null)
      expect(await expandOf(page).count()).toBe(0)
      expect(await column.locator('[data-sidebar-right-open]').count()).toBe(1)
    })

    it('opens a context menu on right-click that the strip cannot clip', async () => {
      onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-right-menu'))
      const column = page.locator('[data-rightbar-col]')

      await ensureExpanded(page, column)
      await expect.poll(async () => await column.locator('[data-dockkit-tab]').count()).toBeGreaterThan(0)
      await column.locator('[data-sidebar-right-guide-entry="files"]').click()
      await column.locator('[data-dockkit-add-tab]').click()
      await expect.poll(async () => await tabTitles(column)).toEqual(['Files', 'Start'])
      // No "more" control on the chip: the chip carries its close, and the menu
      // is the secondary press.
      expect(await column.locator('[data-dockkit-tab-more]').count()).toBe(0)
      await column.locator('[data-dockkit-tab]').filter({ hasText: 'Start' }).click({ button: 'right' })
      const menu = page.locator('[data-dockkit-tab-menu]')
      await expect.poll(async () => await menu.count()).toBe(1)

      // The kit's one item; the extension seat is declared and rendered, and
      // with no registrant it contributes nothing, which is what "declared, not
      // speculative" looks like from the outside.
      await expect.poll(async () => await menu.getByRole('menuitem').allInnerTexts()).toEqual(['Close'])
      // The menu hangs below the strip that clips its overflow. Its pixels are
      // its own: a hit test at its centre lands on it, not on whatever the
      // strip would have shown through a clipped box.
      expect(await hitsItself(menu)).toBe(true)
      const box = await menu.boundingBox()
      const viewport = page.viewportSize()
      if (box === null || viewport === null) throw new Error('menu or viewport is not measurable')
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
      await page.keyboard.press('Escape')

      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    })

    // The product ships Chinese; the cases above advertise English so their role
    // locators stay stable. This is the other half of the same seam, and the
    // screenshot it takes is what the copy draft gets reviewed from. It lives in
    // this block because a settled session is its precondition too — a case that
    // depends on a sibling block's setup passes only in the right order.
    it('renders the shipped Chinese copy on a Chinese page', async () => {
      const zhPage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
      await zhPage.addInitScript(() => { Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' }) })
      const zhTripwire = watchConsole(zhPage)
      onTestFailed(() => saveFailureShot(zhPage, 'web-e2e-sidebar-right-zh'))
      try {
        await zhPage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
        await zhPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
        // A fresh page opens the workspace on a blank session's hero, which has
        // no session header and so no expand button. The settled session is the
        // second row of the tree; pick it the way a user would.
        await zhPage.getByRole('treeitem', { name: /Show the right sidebar\./u }).first().click()
        const column = zhPage.locator('[data-rightbar-col]')
        await expandOf(zhPage).waitFor({ timeout: 20_000 })
        await expandOf(zhPage).click()
        await expect.poll(async () => await tabTitles(column)).toEqual(['开始'])
        await column.locator('[data-sidebar-right-guide-entry="files"]').click()
        await expect.poll(async () => await tabTitles(column)).toEqual(['文件'])
        await column.locator('[data-dockkit-add-tab]').click()

        const guide = column.locator('[data-sidebar-right-guide]')
        await expect.poll(async () => await guide.count()).toBe(1)
        // Wait for the track, not just the panel: the copy is only legible once
        // the column has the width, and a screenshot taken mid-transition reads
        // as a layout defect that is not there.
        expect(await width(column)).toBeGreaterThan(300)
        await expect.poll(async () => await tabTitles(column)).toEqual(['文件', '开始'])
        await expect.poll(async () => await guide.locator('[data-sidebar-right-guide-entry="files"]').innerText())
          .toBe('工作区文件\n浏览会话工作区的文件\n⌥\n⌘\nP')
        const fileEntry = guide.locator('[data-sidebar-right-guide-entry="files"]')
        const terminalEntry = guide.locator('[data-sidebar-right-guide-entry="terminal"]')
        for (const entry of [fileEntry, terminalEntry]) {
          expect(await entry.evaluate(node => getComputedStyle(node).borderRadius)).toBe('20px')
        }
        expect(await terminalEntry.evaluate(node => getComputedStyle(node).overflow)).toBe('hidden')
        const terminalActions = terminalEntry.getByRole('button')
        const terminalButtons = await terminalActions.all()
        for (const [index, action] of terminalButtons.entries()) {
          expect(await action.evaluate(node => getComputedStyle(node).borderRadius)).toBe(index === 0 ? '0px' : '4px')
          await action.hover()
          expect(await action.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
        }
        await terminalActions.first().hover()
        await shot(zhPage, '05-guide-copy-zh')

        expect(zhTripwire.pageErrors).toEqual([])
        expect(zhTripwire.warnings).toEqual([])
      } finally {
        await zhPage.close()
      }
    }, 120_000)
  })
})
