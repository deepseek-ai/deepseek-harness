/** Browser selection and focus after presses in the composer's unused space. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, webkit, type Page } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import {
  assertFixtureInventory, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/composer-focus', import.meta.url))
const EXPECTED = join(SNAPSHOT_DIR, 'focus.expected.md')

/**
 * Observe focus and both ends of the browser selection, including its direction.
 * @param page - Page containing the active composer.
 * @returns The editor's focus, draft and DOM selection.
 */
async function selectionState(page: Page) {
  return await page.locator('[data-composer-input]').evaluate((input) => {
    const selection = window.getSelection()
    return {
      focused: document.activeElement === input,
      draft: input.textContent,
      text: selection?.toString(),
      anchor: selection?.anchorOffset,
      focus: selection?.focusOffset,
    }
  })
}

/**
 * Format observed browser focus and selection for the golden file.
 * @param state - Current browser selection.
 * @returns Focus, selected text and directed offsets.
 */
function describeSelection(state: Awaited<ReturnType<typeof selectionState>>): string {
  return `${state.focused ? 'focused' : 'unfocused'}; selection ${JSON.stringify(state.text)} (${state.anchor} → ${state.focus})`
}

/**
 * Keep the visible composer still when keyboard panning changes viewport coordinates.
 * @param page - Page with the focused composer.
 * @returns The observed page and composer scroll behavior.
 */
async function exerciseKeyboardViewport(page: Page): Promise<string> {
  const input = page.locator('[data-composer-input][contenteditable="true"]')
  const restore = await page.evaluateHandle(() => {
    const viewport = window.visualViewport
    if (viewport === null) throw new Error('Expected a visual viewport')
    const style = document.documentElement.style
    const height = style.getPropertyValue('height')
    const priority = style.getPropertyPriority('height')
    const scroll = window.scrollY
    const offset = Object.getOwnPropertyDescriptor(viewport, 'offsetTop')
    style.setProperty('height', `${window.innerHeight * 2}px`)
    const input = document.querySelector<HTMLElement>('[data-composer-input]')!
    window.scrollTo(0, input.getBoundingClientRect().top + scroll - window.innerHeight / 4)
    // Safari can report the keyboard's page displacement as offsetTop even
    // though DOM rectangles already account for that page scroll.
    Object.defineProperty(viewport, 'offsetTop', { configurable: true, get: () => window.scrollY })
    window.dispatchEvent(new Event('scroll'))
    return () => {
      if (offset === undefined) Reflect.deleteProperty(viewport, 'offsetTop')
      else Object.defineProperty(viewport, 'offsetTop', offset)
      if (height === '') style.removeProperty('height')
      else style.setProperty('height', height, priority)
      window.scrollTo(0, scroll)
      window.dispatchEvent(new Event('scroll'))
    }
  })
  try {
    const before = await input.evaluate(el => ({ top: el.getBoundingClientRect().top, scroll: window.scrollY }))
    expect(before.scroll).toBeGreaterThan(0)
    expect(before.top).toBeGreaterThanOrEqual(0)
    await page.keyboard.insertText('z')
    const after = await input.evaluate(el => new Promise<{ top: number; scroll: number }>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        resolve({ top: el.getBoundingClientRect().top, scroll: window.scrollY })
      }))
    }))
    expect(after).toEqual(before)
    return '- typing with a keyboard-panned viewport preserves page scroll and composer position'
  } finally {
    await restore.evaluate((dispose) => { dispose() })
    await restore.dispose()
  }
}

/**
 * Exercise the card's top, inter-row gap, toolbar gap and bottom padding.
 * @param page - Page containing an editable composer.
 * @returns Stable behavior observations for the expected-output file.
 */
async function exerciseComposer(page: Page): Promise<string[]> {
  const input = page.locator('[data-composer-input][contenteditable="true"]')
  await input.click()
  // Let the editor observe its insertText selection before native arrow moves;
  // a coalesced first notification can otherwise be treated as its own update.
  await input.evaluate((el) => {
    const onSelectionChange = (): void => {
      const selection = el.ownerDocument.getSelection()
      if (selection === null || !el.contains(selection.anchorNode) || !el.contains(selection.focusNode)) return
      if (selection.isCollapsed && selection.anchorOffset === 16 && el.textContent === 'alpha beta gamma') {
        el.dataset.selectionReady = 'inserted'
        return
      }
      if (selection.toString() !== 'beta' || selection.anchorOffset !== 10 || selection.focusOffset !== 6) return
      el.dataset.selectionReady = 'selected'
      el.ownerDocument.removeEventListener('selectionchange', onSelectionChange)
    }
    el.ownerDocument.addEventListener('selectionchange', onSelectionChange)
  })
  await page.keyboard.insertText('alpha beta gamma')
  await expect.poll(() => input.getAttribute('data-selection-ready')).toBe('inserted')
  await page.keyboard.press('Home')
  for (let index = 0; index < 10; index++) await page.keyboard.press('ArrowRight')
  for (let index = 0; index < 4; index++) await page.keyboard.press('Shift+ArrowLeft')
  const selected = { focused: true, draft: 'alpha beta gamma', text: 'beta', anchor: 10, focus: 6 }
  await expect.poll(() => selectionState(page)).toEqual(selected)

  const points = await page.locator('[data-composer-card]').evaluate((card) => {
    const box = card.getBoundingClientRect()
    const scroll = card.querySelector('[data-input-scroll]')!.getBoundingClientRect()
    const rowElement = card.querySelector('[data-input-scroll]')!.nextElementSibling!
    const row = rowElement.getBoundingClientRect()
    const tools = rowElement.firstElementChild!.getBoundingClientRect()
    const trailing = rowElement.lastElementChild!.getBoundingClientRect()
    if (trailing.left <= tools.right) throw new Error('Composer toolbar has no unused gap')
    return [
      { name: 'top padding', x: box.x + box.width / 2, y: (box.top + scroll.top) / 2 },
      { name: 'row gap', x: box.x + box.width / 2, y: (scroll.bottom + row.top) / 2 },
      { name: 'toolbar gap', x: (tools.right + trailing.left) / 2, y: row.top + row.height / 2 },
      { name: 'bottom padding', x: box.x + box.width / 2, y: box.bottom - 2 },
    ]
  })
  const observations: string[] = []
  for (const point of points) {
    await page.mouse.click(point.x, point.y)
    await expect.poll(() => selectionState(page)).toEqual(selected)
    observations.push(`- ${point.name}: ${describeSelection(await selectionState(page))}`)
  }

  await expect.poll(() => input.getAttribute('data-selection-ready')).toBe('selected')
  await input.evaluate((el) => { delete el.dataset.selectionReady })
  const top = points[0]!
  const cardBox = await page.locator('[data-composer-card]').boundingBox()
  await page.mouse.click(cardBox!.x - 12, top.y)
  await expect.poll(async () => (await selectionState(page)).focused).toBe(false)
  await page.mouse.click(top.x, top.y)
  await expect.poll(() => selectionState(page)).toEqual(selected)
  observations.push(`- return from outside: ${describeSelection(await selectionState(page))}`)

  await page.keyboard.insertText('BETA')
  await expect.poll(() => input.textContent()).toBe('alpha BETA gamma')
  await page.keyboard.press('ArrowLeft')
  const caret = { focused: true, draft: 'alpha BETA gamma', text: '', anchor: 9, focus: 9 }
  await expect.poll(() => selectionState(page)).toEqual(caret)
  await page.mouse.click(top.x, top.y)
  await expect.poll(() => selectionState(page)).toEqual(caret)
  await page.keyboard.insertText('!')
  await expect.poll(() => input.textContent()).toBe('alpha BET!A gamma')
  observations.push(`- typing replaces the restored selection and resumes at the restored caret: ${await input.textContent()}`)
  const retained = await input.elementHandle()
  const beforeResize = await selectionState(page)
  for (const width of [390, 768, 1680]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(await retained!.evaluate(element => element.isConnected)).toBe(true)
    expect(await selectionState(page)).toEqual(beforeResize)
  }
  observations.push('- resizing through 390px, 768px and 1680px preserves the editor, focus, draft and caret')
  observations.push(await exerciseKeyboardViewport(page))
  return observations
}

it('restores the previous caret or selection in fresh and existing sessions', async () => {
  const scaffold = await launchWebScaffold({})
  const browserPromise = chromium.launch()
  onTestFinished(async () => {
    try { await (await browserPromise).close() }
    finally { await scaffold.close() }
  })
  const browser = await browserPromise
  const fixture = createChatScrollFixture({ markerPrefix: 'COMPOSER_FOCUS', title: 'Composer focus', turns: 1 })
  await seedSession(scaffold, fixture.log, 'composer-focus-web-e2e')
  const page = await newEnglishPage(browser)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-focus'))
  const tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await connectFreshWorkspace(page, scaffold.workspaceCwd, 'composer-focus')
  const hero = await exerciseComposer(page)

  await page.getByRole('button', { name: 'Search sessions' }).click()
  await page.getByRole('textbox', { name: 'Search session names', exact: true }).fill(fixture.markers.user(1))
  const result = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  await expect.poll(() => result.count(), { timeout: 60_000 }).toBe(1)
  await result.click()
  await page.getByText(fixture.markers.assistant(1), { exact: false }).last().waitFor()
  const docked = await exerciseComposer(page)

  await compareOrRefreshGolden(EXPECTED, [
    '# Composer whitespace focus', '', '## Fresh session', '', ...hero,
    '', '## Existing session', '', ...docked,
  ].join('\n'), webSnapshotMode())
  await assertFixtureInventory(SNAPSHOT_DIR, ['focus.expected.md', 'submission.expected.md'])
  if (webSnapshotMode() !== 'record') expect(tripwire.warnings).toEqual([])
  expect(tripwire.pageErrors).toEqual([])
}, 180_000)

it('keeps mobile submission keyboard navigation in the composer while retaining desktop focus', async () => {
  const observations: string[] = []
  for (const { engine, mobile, submission } of [
    { engine: chromium, mobile: false, submission: 'Send' },
    { engine: chromium, mobile: true, submission: 'Send' },
    { engine: chromium, mobile: true, submission: 'Enter' },
    { engine: webkit, mobile: true, submission: 'Send' },
    { engine: webkit, mobile: true, submission: 'Enter' },
  ]) {
    const scaffold = await launchWebScaffold({
      replayFixture: fileURLToPath(new URL('../../../snapshots/web/live-interactions/session.v3.jsonl', import.meta.url)),
      compareReplaySession: false,
    })
    try {
      const browser = await engine.launch()
      try {
        const page = await browser.newPage({
          viewport: { width: mobile ? 390 : 1280, height: 844 },
          locale: 'en-US', timezoneId: 'Asia/Shanghai',
          ...mobile ? {
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1',
            isMobile: true, hasTouch: true,
          } : {},
        })
        const tripwire = watchConsole(page)
        const platform = `${engine.name()} ${mobile ? 'mobile' : 'desktop'} ${submission}`
        let finished = false
        const off = scaffold.ctx.on('session/event', (_session, event) => {
          if (event.type === 'turn/end') finished = true
        })
        try {
          await page.goto(scaffold.authenticatedUrl)
          await connectFreshWorkspace(page, scaffold.workspaceCwd, `submission-${platform}`)
          const input = page.locator('[data-composer-input][contenteditable="true"]')
          await input.fill('Reply with a one-sentence description of event sourcing, then stop.')
          expect(await input.evaluate(element => document.activeElement === element)).toBe(true)
          if (submission === 'Enter') await page.keyboard.press('Enter')
          else {
            const send = page.getByRole('button', { name: 'Send message', exact: true })
            if (mobile) await send.tap()
            else await send.click()
          }
          await expect.poll(() => input.textContent()).toBe('')
          await expect.poll(() => input.evaluate(element => document.activeElement === element)).toBe(!mobile)
          await expect.poll(() => finished, { timeout: 60_000 }).toBe(true)
          expect(await input.evaluate(element => document.activeElement === element)).toBe(!mobile)
          if (mobile) {
            const card = page.locator('[data-composer-card]')
            expect(await card.evaluate(element => document.activeElement === element)).toBe(true)
            // Option+Tab includes buttons in WebKit's keyboard navigation mode.
            const next = engine === webkit ? 'Alt+Tab' : 'Tab'
            await page.keyboard.press(next)
            expect(await input.evaluate(element => document.activeElement === element)).toBe(true)
            await page.keyboard.press(next)
            const attachment = page.getByRole('button', { name: 'Add files or run commands', exact: true })
            expect(await attachment.evaluate(element => document.activeElement === element)).toBe(true)
            observations.push(`- ${platform}: clears the draft; focus remains on the composer card through response completion, then advances to the editor and attachment button`)
          } else {
            observations.push(`- ${platform}: clears the draft; editor stays focused through response completion`)
          }
          expect(tripwire.pageErrors).toEqual([])
          if (webSnapshotMode() !== 'record') expect(tripwire.warnings).toEqual([])
        } catch (error) {
          await saveFailureShot(page, `web-e2e-composer-submission-${platform}`)
          throw error
        } finally {
          off()
          await page.close()
        }
      } finally {
        await browser.close()
      }
    } finally {
      await scaffold.close()
    }
  }
  await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'submission.expected.md'), observations.join('\n'), webSnapshotMode())
  await assertFixtureInventory(SNAPSHOT_DIR, ['focus.expected.md', 'submission.expected.md'])
}, 180_000)
