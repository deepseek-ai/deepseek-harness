// Web e2e scenario: a hand-declared model's `reasoningEfforts` reaches the
// composer's inline effort slider — the levels a settings profile declares are exactly
// what the picker offers, and picking one records it with the Agent default.
// Zero model calls: declaring, describing, and switching are settings/llm
// traffic only, so there is no fixture and a stray stream would fail loud.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Locator, Page, Request } from 'playwright'
import { chromium, webkit } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, saveFailureShot } from './support.ts'

/** Starts the shipped default on this scenario's declared reasoning model. */
const OVERLAY = fileURLToPath(new URL('./declared-reasoning.overlay.yml', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/declared-reasoning', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./expected/declared-reasoning/ui.expected.md', import.meta.url))
const POINTER_EXPECTED = fileURLToPath(new URL('./expected/declared-reasoning/pointer-menu.expected.md', import.meta.url))
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record').each([
  { name: 'Chromium', engine: chromium },
  { name: 'WebKit', engine: webkit },
])('web e2e: declared reasoning efforts reach the composer ($name)', ({ engine }) => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    // The whole reasoning offer is the profile: key = selectable level, value
    // = the wire spelling dispatch would send (`max: ultra` renames; the
    // valueless `off` means "supported, send nothing"). The route sets no
    // deployment default, so the pane leads with the provider-default entry.
    await scaffold.ctx.settings.update('llm-pi-ai', {
      providers: {
        'acme-gateway': {
          displayName: 'Acme Gateway',
          api: 'openai-completions',
          baseURL: 'https://gateway.acme.example/v1',
          models: [
            { id: 'acme-think', name: 'Acme Think' },
            { id: 'acme-swift', name: 'Acme Swift' },
            { id: 'acme-lite', name: 'Acme Lite' },
          ].map(model => ({
            ...model,
            reasoningEfforts: model.id === 'acme-lite'
              ? { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }
              : { off: null, high: 'high', max: 'ultra' },
          })),
        },
      },
    })
    browser = await engine.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      await scaffold?.close()
    }
  })

  it('uses Tab only for focus while Enter and Space open model and Team pages', async () => {
    onTestFailed(() => saveFailureShot(page, `web-e2e-model-tab-${engine.name()}`))
    let selections = 0
    const countSelection = (request: Request): void => {
      if (new URL(request.url()).pathname.endsWith('/session/selectModel')) selections++
    }
    page.on('request', countSelection)
    onTestFinished(() => { page.off('request', countSelection) })
    const previous = scaffold.ctx.agentDefaultModel.currentSelection()
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    const rootModel = page.locator('[data-model-menu-root] > button[role="menuitem"]')
    const slider = page.getByRole('slider', { name: '推理等级', exact: true })
    const team = page.locator('[data-model-menu-page="agent-team"]')
    const focused = async (locator: Locator): Promise<void> => {
      await expect.poll(() => locator.evaluate(element => element === document.activeElement)).toBe(true)
    }
    await trigger.click()
    await page.keyboard.press('Tab'); await focused(rootModel)
    expect(await page.getByRole('menuitemradio').count()).toBe(0)
    await page.keyboard.press('Tab'); await focused(slider)
    await page.keyboard.press('Tab'); await focused(team)
    expect(await page.getByRole('switch').count()).toBe(0)
    await page.keyboard.press('Shift+Tab'); await focused(slider)
    await page.keyboard.press('Shift+Tab'); await focused(rootModel)
    await page.keyboard.press('Enter')
    const search = page.getByRole('searchbox', { name: '搜索模型…', exact: true })
    await search.waitFor(); await focused(search)
    await page.mouse.move(0, 0)
    await page.keyboard.press('Escape'); await focused(rootModel)
    expect(await rootModel.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
    await page.keyboard.press('Space'); await focused(search)
    await page.keyboard.press('Tab')
    await focused(page.locator('[role="menuitemradio"][tabindex="0"]'))
    expect(selections).toBe(0)
    expect(scaffold.ctx.agentDefaultModel.currentSelection()).toEqual(previous)
    await page.keyboard.press('Shift+Tab'); await focused(search)
    await page.keyboard.press('Shift+Tab'); await focused(trigger)
    expect(await search.count()).toBe(0)
    await page.keyboard.press('Enter')
    await page.keyboard.press('Tab'); await focused(rootModel)
    await page.keyboard.press('Space'); await search.waitFor()
    await page.keyboard.press('Tab')
    await focused(page.locator('[role="menuitemradio"][aria-checked="true"]'))
    await page.keyboard.press('Space'); await focused(rootModel)
    await page.keyboard.press('Tab'); await focused(slider)
    await page.keyboard.press('Tab'); await focused(team)
    await page.keyboard.press('Space')
    const toggle = page.getByRole('switch', { name: '启用智能体团队协作', exact: true })
    await toggle.waitFor(); await focused(toggle)
    const checked = await toggle.getAttribute('aria-checked')
    await page.keyboard.press('Shift+Tab'); await focused(trigger)
    expect(await toggle.count()).toBe(0)
    await page.keyboard.press('Enter')
    await team.click(); await focused(toggle)
    expect(await toggle.getAttribute('aria-checked')).toBe(checked)
    expect(await page.getByRole('button', { name: '返回', exact: true }).count()).toBe(0)
    await page.keyboard.press('Escape'); await focused(team)
    await page.keyboard.press('Tab')
    await page.locator('[data-model-menu-root]').waitFor({ state: 'detached' })
    expect(await trigger.evaluate(element => element === document.activeElement)).toBe(false)
    expect(selections).toBe(0)
    expect(scaffold.ctx.agentDefaultModel.currentSelection()).toEqual(previous)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('offers exactly the declared levels in the root slider and records one keyboard selection', async () => {
    onTestFailed(() => saveFailureShot(page, `web-e2e-declared-reasoning-${engine.name()}`))
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await trigger.waitFor({ timeout: 15_000 })
    onTestFinished(async () => {
      if (await trigger.getAttribute('aria-expanded') === 'true') await trigger.click()
    })
    await trigger.click()
    const slider = page.getByRole('slider', { name: '推理等级', exact: true })
    const levels = page.getByRole('group', { name: '推理等级', exact: true }).getByRole('button')
    expect(await levels.count()).toBe(0)
    expect(await slider.getAttribute('min')).toBe('0')
    expect(await slider.getAttribute('max')).toBe('3')
    expect(await slider.getAttribute('aria-valuetext')).toBe('Default')
    const tag = page.getByRole('group', { name: '推理等级', exact: true }).getByText('Default', { exact: true })
    expect(await tag.evaluate(element => ({
      cursor: getComputedStyle(element).cursor,
      userSelect: getComputedStyle(element).getPropertyValue(CSS.supports('user-select', 'none') ? 'user-select' : '-webkit-user-select'),
      tabIndex: element.tabIndex,
    }))).toEqual({ cursor: 'default', userSelect: 'none', tabIndex: -1 })
    expect(await page.getByRole('menuitem', { name: /推理等级/ }).count()).toBe(0)
    const snapshot = await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    const previous = scaffold.ctx.agentDefaultModel.currentSelection()
    await slider.focus()
    try {
      await page.keyboard.down('ArrowRight')
      await expect.poll(() => slider.inputValue()).toBe('1')
      await page.keyboard.down('ArrowRight')
      await expect.poll(() => slider.inputValue()).toBe('2')
      expect(scaffold.ctx.agentDefaultModel.currentSelection()).toEqual(previous)
    } finally {
      await page.keyboard.up('ArrowRight')
    }
    await expect.poll(() => slider.getAttribute('aria-busy')).toBe('false')
    expect(await slider.evaluate(element => element === document.activeElement)).toBe(true)
    await expect.poll(
      async () => readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8'),
      { timeout: 10_000 },
    ).toContain('reasoningEffort: high')
    await expect.poll(() => trigger.getAttribute('aria-label')).toBe('选择模型，当前 Acme Think，推理等级 High')
    expect(await slider.getAttribute('aria-valuetext')).toBe('High')
    await slider.focus()
    await page.keyboard.press('Shift+Tab')
    await expect.poll(() => page.getByRole('menuitem', { name: /^模型/ })
      .evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Shift+Tab')
    await expect.poll(() => page.getByRole('menu').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('opens from the pointer with keyboard focus and closes from the trigger in every pane', async () => {
    onTestFailed(() => saveFailureShot(page, `web-e2e-model-trigger-${engine.name()}`))
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    const menu = page.getByRole('menu')
    for (const pane of ['root', 'model', 'slider']) {
      await page.locator('[data-composer-input][contenteditable="true"]').focus()
      await trigger.click()
      await expect.poll(() => trigger.evaluate(element => element === document.activeElement)).toBe(true)
      if (pane === 'root') {
        await page.keyboard.press('ArrowDown')
        await expect.poll(() => page.getByRole('menuitem', { name: /^模型/ })
          .evaluate(element => element === document.activeElement)).toBe(true)
      } else {
        if (pane === 'model') await page.getByRole('menuitem', { name: /^模型/ }).click()
        const focused = pane === 'model'
          ? page.getByRole('searchbox', { name: '搜索模型…' })
          : page.getByRole('slider', { name: '推理等级', exact: true })
        if (pane === 'slider') await focused.focus()
        await expect.poll(() => focused.evaluate(element => element === element.ownerDocument.activeElement)).toBe(true)
      }
      await trigger.click()
      await menu.waitFor({ state: 'detached' })
      await expect.poll(() => trigger.evaluate(element => element === document.activeElement)).toBe(true)
    }
    expect(tripwire.pageErrors).toEqual([])
  })

  it('selects model and effort by mouse and keeps keyboard control after cancelled or rejected clicks', async () => {
    onTestFailed(() => saveFailureShot(page, `web-e2e-model-pointer-${engine.name()}`))
    let selections = 0
    const countSelection = (request: Request): void => {
      if (new URL(request.url()).pathname.endsWith('/session/selectModel')) selections++
    }
    page.on('request', countSelection)
    onTestFinished(() => { page.off('request', countSelection) })
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    const menu = page.getByRole('menu')
    onTestFinished(async () => {
      if (await trigger.getAttribute('aria-expanded') === 'true') await trigger.click()
    })
    await trigger.click()
    await page.getByRole('menuitem', { name: /^模型/ }).click()
    const current = page.getByRole('menuitemradio', { name: 'Acme Think', exact: true })
    const target = page.getByRole('menuitemradio', { name: 'Acme Swift', exact: true })
    const search = page.getByRole('searchbox', { name: '搜索模型…' })
    await expect.poll(() => search.evaluate(element => element === element.ownerDocument.activeElement)).toBe(true)
    expect(await search.getAttribute('aria-activedescendant')).toBe(await current.getAttribute('id'))

    // Native mousedown must not blur search and unmount the menu before click in WebKit.
    await target.getByText('Acme Swift', { exact: true }).hover()
    await page.mouse.down()
    try {
      await expect.poll(() => menu.count()).toBe(1)
      await expect.poll(() => search.evaluate(element => element === element.ownerDocument.activeElement)).toBe(true)
      await page.getByText('Acme Gateway', { exact: true }).hover()
    } finally {
      await page.mouse.up()
    }
    // Later selection counts also include any request from this cancelled press.
    expect(selections).toBe(0)
    await search.press('ArrowUp')
    expect(await search.getAttribute('aria-activedescendant')).toBe(await current.getAttribute('id'))
    await search.press('ArrowDown')
    expect(await search.getAttribute('aria-activedescendant')).toBe(await target.getAttribute('id'))
    await expect.poll(() => search.evaluate(element => element === element.ownerDocument.activeElement)).toBe(true)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Shift+Tab')
    await menu.waitFor({ state: 'detached' })

    await trigger.click()
    await page.getByRole('menuitem', { name: /^模型/ }).click()
    await target.getByText('Acme Swift', { exact: true }).click()
    await page.locator('[data-model-menu-root]').waitFor()
    expect(selections).toBe(1)
    await expect.poll(() => scaffold.ctx.agentDefaultModel.currentSelection().model, { timeout: 10_000 })
      .toBe('acme-swift')

    const rootModel = page.getByRole('menuitem', { name: /^模型/ })
    await expect.poll(() => rootModel.evaluate(element => element === document.activeElement)).toBe(true)
    expect(await rootModel.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
    await rootModel.hover()
    await expect.poll(() => rootModel.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
    await page.mouse.move(0, 0)
    await page.keyboard.press('Tab')
    const slider = page.getByRole('slider', { name: '推理等级', exact: true })
    expect(await slider.evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Shift+Tab')
    expect(await rootModel.evaluate(element => element === document.activeElement)).toBe(true)
    expect(await rootModel.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
    expect(selections).toBe(1)
    const rangeBounds = await slider.boundingBox()
    if (rangeBounds === null) throw new Error('Reasoning slider is not visible')
    await page.mouse.click(rangeBounds.x + rangeBounds.width - 8, rangeBounds.y + rangeBounds.height / 2)
    await expect.poll(() => slider.getAttribute('aria-valuetext')).toBe('Max')
    expect(selections).toBe(2)
    await expect.poll(() => scaffold.ctx.agentDefaultModel.currentSelection().reasoningEffort, { timeout: 10_000 })
      .toBe('max')

    await page.route('**/api/session/selectModel', async (route) => {
      const envelope = route.request().postDataJSON() as { rpcId: string }
      await route.fulfill({
        json: {
          type: 'server-response', rpcId: envelope.rpcId,
          result: {
            ok: false,
            error: { code: 'session/writer-held', message: 'writer held', details: { sessionId: 'held-session' } },
          },
        },
      })
    }, { times: 1 })
    await page.getByRole('menuitem', { name: /^模型/ }).click()
    await expect.poll(() => search.evaluate(element => element === element.ownerDocument.activeElement)).toBe(true)
    expect(await search.getAttribute('aria-activedescendant')).toBe(await target.getAttribute('id'))
    await current.click()
    await page.getByRole('alert').waitFor()
    expect(selections).toBe(3)
    await compareOrRefreshGolden(POINTER_EXPECTED,
      await captureStableAria(page, '[role="group"][aria-label="模型"]', scaffold.workspaceCwd), MODE)
    const focusedRow = page.locator('[role="menuitemradio"][tabindex="0"]')
    await expect.poll(() => focusedRow.evaluate(element => element === document.activeElement)).toBe(true)
    expect(await target.getAttribute('aria-checked')).toBe('true')
    expect(scaffold.ctx.agentDefaultModel.currentSelection().model).toBe('acme-swift')
    await page.keyboard.press('Shift+Tab')
    await expect.poll(() => search.evaluate(element => element === element.ownerDocument.activeElement)).toBe(true)
    await search.fill('Acme Think')
    await search.press('ArrowDown')
    expect(await search.getAttribute('aria-activedescendant')).toBe(await current.getAttribute('id'))
    expect(await search.evaluate(element => element === element.ownerDocument.activeElement)).toBe(true)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'detached' })

    await trigger.click()
    await page.getByRole('menuitem', { name: /^模型/ }).click()
    await expect.poll(() => search.evaluate(element => element === document.activeElement)).toBe(true)
    const composer = page.locator('[data-composer-input][contenteditable="true"]')
    // Native focus supplies relatedTarget; Playwright's contentEditable focus first blurs to null.
    await composer.evaluate((element) => { element.focus() })
    await expect.poll(() => composer.evaluate(element => element === document.activeElement)).toBe(true)
    await menu.waitFor({ state: 'detached' })
    await trigger.click()
    await page.mouse.click(0, 0)
    await menu.waitFor({ state: 'detached' })
    expect(tripwire.pageErrors).toEqual([])
  })

  it('shows six stops including Default and commits only after releasing a drag outside the range', async () => {
    onTestFailed(() => saveFailureShot(page, `web-e2e-six-effort-drag-${engine.name()}`))
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    const viewport = page.viewportSize()!
    await trigger.click()
    await page.getByRole('menuitem', { name: /^模型/ }).click()
    await page.getByRole('menuitemradio', { name: 'Acme Lite', exact: true }).click()
    await expect.poll(() => scaffold.ctx.agentDefaultModel.currentSelection().model).toBe('acme-lite')
    let selections = 0
    const countSelection = (request: Request): void => {
      if (new URL(request.url()).pathname.endsWith('/session/selectModel')) selections++
    }
    page.on('request', countSelection)
    onTestFinished(() => { page.off('request', countSelection) })
    try {
      await page.setViewportSize({ width: 390, height: 700 })
      const menu = page.getByRole('menu', { name: '模型与推理等级', exact: true })
      const group = menu.getByRole('group', { name: '推理等级', exact: true })
      const slider = group.getByRole('slider', { name: '推理等级', exact: true })
      expect(await group.getByRole('button').count()).toBe(0)
      expect(await slider.getAttribute('aria-valuetext')).toBe('Default')
      expect(await slider.getAttribute('max')).toBe('5')
      await expect.poll(() => menu.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return rect.left >= 12 && rect.right <= innerWidth - 12 && rect.top >= 12 && rect.bottom <= innerHeight - 12
          && element.scrollWidth <= element.clientWidth
      })).toBe(true)
      await expect.poll(() => slider.getAttribute('aria-busy')).toBe('false')
      await slider.hover()
      const bounds = await slider.boundingBox()
      if (bounds === null) throw new Error('Reasoning slider is not visible')
      const y = bounds.y + bounds.height / 2
      await page.mouse.move(bounds.x + 8, y)
      await page.mouse.down()
      try {
        await page.mouse.move(bounds.x + bounds.width * .4, y, { steps: 4 })
        await page.mouse.move(bounds.x + bounds.width * .6, y, { steps: 4 })
        await page.mouse.move(bounds.x + bounds.width - 8, y, { steps: 4 })
        await page.mouse.move(bounds.x + bounds.width + 24, y, { steps: 4 })
        expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.matches('input[type="range"]'),
          { x: bounds.x + bounds.width + 24, y })).not.toBe(true)
        expect(selections).toBe(0)
        expect(await menu.isVisible()).toBe(true)
        await expect.poll(() => slider.evaluate(input => ({
          value: (input as HTMLInputElement).value,
          label: input.getAttribute('aria-valuetext'),
          busy: input.getAttribute('aria-busy'),
          disabled: (input as HTMLInputElement).disabled,
        }))).toEqual({ value: '5', label: 'Max', busy: 'false', disabled: false })
      } catch (error) {
        await page.screenshot({ path: fileURLToPath(new URL(
          `../../../.artifacts/model-picker-master-sync/drag-${engine.name()}-regression.png`, import.meta.url,
        )) })
        throw error
      } finally {
        await page.mouse.up()
      }
      await expect.poll(() => slider.getAttribute('aria-busy')).toBe('false')
      expect(await menu.isVisible()).toBe(true)
      expect(await slider.evaluate(element => element === document.activeElement)).toBe(true)
      expect(selections).toBe(1)
      await expect.poll(() => scaffold.ctx.agentDefaultModel.currentSelection().reasoningEffort).toBe('max')
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      await page.keyboard.press('Escape')
      await page.setViewportSize(viewport)
    }
  })

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md', 'pointer-menu.expected.md'])
  })
})
