// Web e2e scenario: a hand-declared model's `reasoningEfforts` reaches the
// composer's inline effort slider — the levels a settings profile declares are exactly
// what the picker offers, and picking one records it with the Agent default.
// Zero model calls: declaring, describing, and switching are settings/llm
// traffic only, so there is no fixture and a stray stream would fail loud.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Locator, Page, Request, Route } from 'playwright'
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

async function readEffortMotion(slider: Locator) {
  return slider.evaluate((element) => {
    const input = element as HTMLInputElement
    const group = input.closest('[role="group"]')!
    const thumb = group.querySelector<HTMLElement>('[data-effort-thumb]')!
    const scale = group.querySelector<HTMLElement>('[data-effort-thumb-scale]')!
    const fill = group.querySelector<HTMLElement>('[data-effort-fill]')!
    const tag = group.querySelector<HTMLElement>('[data-effort-tag]')!
    const rangeRect = input.getBoundingClientRect()
    const thumbRect = thumb.getBoundingClientRect()
    const fillRect = fill.getBoundingClientRect()
    const labelRect = tag.getBoundingClientRect()
    const thumbSize = Number.parseFloat(getComputedStyle(thumb).width)
    const ratio = (input.valueAsNumber - Number(input.min)) / (Number(input.max) - Number(input.min))
    return {
      value: input.valueAsNumber, dragging: input.parentElement!.hasAttribute('data-dragging'),
      nativeWidth: rangeRect.width, nativeHeight: rangeRect.height,
      left: rangeRect.left, right: rangeRect.right, y: rangeRect.top + rangeRect.height / 2,
      center: thumbRect.left + thumbRect.width / 2, centerY: thumbRect.top + thumbRect.height / 2,
      expectedCenter: rangeRect.left + thumbSize / 2 + (rangeRect.width - thumbSize) * ratio,
      thumbSize, visualWidth: scale.getBoundingClientRect().width, fillRight: fillRect.right,
      dotWidth: Number.parseFloat(getComputedStyle(scale, '::after').width),
      dotDuration: getComputedStyle(scale, '::after').transitionDuration,
      dotEasing: getComputedStyle(scale, '::after').transitionTimingFunction,
      labelCenter: labelRect.left + labelRect.width / 2, labelWidth: labelRect.width,
      thumbDuration: getComputedStyle(input.parentElement!).transitionDuration,
      thumbEasing: getComputedStyle(input.parentElement!).transitionTimingFunction,
      fillDuration: getComputedStyle(input.parentElement!).transitionDuration,
      tickDuration: getComputedStyle(group.querySelector('[data-effort-tick]')!).transitionDuration,
      ticks: [...group.querySelectorAll<HTMLElement>('[data-effort-tick]')].map((tick) => {
        const rect = tick.getBoundingClientRect()
        return { center: rect.left + rect.width / 2, width: rect.width,
          hovered: tick.hasAttribute('data-hovered'), visibility: getComputedStyle(tick).visibility }
      }),
    }
  })
}

/** The tag tracks the handle but stops at the menu edges. */
function expectedTagCenter(view: { left: number; right: number; labelWidth: number }, target: number): number {
  const half = view.labelWidth / 2
  return Math.min(Math.max(target, view.left + half), view.right - half)
}

async function assertSettledEffort(slider: Locator) {
  await expect.poll(async () => {
    const view = await readEffortMotion(slider)
    return Math.max(Math.abs(view.center - view.expectedCenter), Math.abs(view.fillRight - view.center))
  }).toBeLessThan(1)
  const view = await readEffortMotion(slider)
  expect(view.nativeHeight).toBe(40)
  expect(view.thumbSize).toBe(20)
  expect(Math.abs(view.centerY - view.y)).toBeLessThan(1)
  expect(Math.abs(view.labelCenter - expectedTagCenter(view, view.center))).toBeLessThan(1)
  return view
}

async function restoreSelectionAfterTest(page: Page, scaffold: WebScaffold): Promise<void> {
  const trigger = page.getByRole('button', { name: /^选择模型/ })
  const agent = scaffold.ctx.agents.list()[0]!
  const savedModel = agent.model.current()!
  const savedDefault = scaffold.ctx.agentDefaultModel.currentSelection()
  const savedLabel = await trigger.getAttribute('aria-label')
  const viewport = page.viewportSize()!
  onTestFinished(async () => {
    try {
      await page.mouse.up()
      await page.keyboard.up('ArrowRight')
      await page.keyboard.up('ArrowLeft')
      await expect.poll(() => trigger.getAttribute('aria-busy')).toBe('false')
      if (JSON.stringify(agent.model.current()) !== JSON.stringify(savedModel)) agent.model.select(savedModel)
      // Queue restoration behind background default saves even if the visible default has not changed yet.
      await scaffold.ctx.agentDefaultModel.saveSelection(savedDefault)
      await expect.poll(() => trigger.getAttribute('aria-label')).toBe(savedLabel)
    } finally {
      try {
        if (await trigger.getAttribute('aria-expanded') === 'true') await trigger.click()
      } finally { await page.setViewportSize(viewport) }
    }
  })
}

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
    await restoreSelectionAfterTest(page, scaffold)
    const rootModel = page.locator('[data-model-menu-root] > button[role="menuitem"]')
    const slider = page.getByRole('slider', { name: '推理等级', exact: true })
    const team = page.locator('[data-model-menu-page="agent-team"]')
    const info = page.getByRole('button', { name: '默认推理等级说明', exact: true })
    const focused = async (locator: Locator): Promise<void> => {
      await expect.poll(() => locator.evaluate(element => element === document.activeElement)).toBe(true)
    }
    await trigger.click()
    const caption = page.locator('[data-effort-caption]')
    await page.keyboard.press('Tab'); await focused(rootModel)
    expect(await page.getByRole('menuitemradio').count()).toBe(0)
    await page.keyboard.press('Tab'); await focused(caption)
    await page.keyboard.press('Tab'); await focused(info)
    await page.keyboard.press('Tab'); await focused(slider)
    await page.keyboard.press('Tab'); await focused(team)
    expect(await page.getByRole('switch').count()).toBe(0)
    await page.keyboard.press('Shift+Tab'); await focused(slider)
    await page.keyboard.press('Shift+Tab'); await focused(info)
    await page.keyboard.press('Shift+Tab'); await focused(caption)
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
    await page.keyboard.press('Tab'); await focused(caption)
    await page.keyboard.press('Tab'); await focused(info)
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

  it('reads default information by mouse and keyboard without selecting or closing the menu', async () => {
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await restoreSelectionAfterTest(page, scaffold)
    let requests = 0
    const count = (request: Request): void => {
      if (new URL(request.url()).pathname.endsWith('/session/selectModel')) requests++
    }
    page.on('request', count)
    try {
      await trigger.click()
      const menu = page.getByRole('menu', { name: '模型与推理等级', exact: true })
      const slider = menu.getByRole('slider', { name: '推理等级', exact: true })
      const info = menu.getByRole('button', { name: '默认推理等级说明', exact: true })
      const explanation = '未显式指定推理等级，将使用模型与配置的默认设置；这不代表关闭推理'
      const defaultHeight = await menu.evaluate(element => element.getBoundingClientRect().height)
      await menu.locator('[data-effort-label]').click()
      expect(await slider.inputValue()).toBe('0')
      const tagHit = await menu.locator('[data-effort-tag]').evaluate((tag) => {
        const caption = tag.querySelector<HTMLElement>('[data-effort-caption]')!
        const bounds = tag.getBoundingClientRect()
        const x = bounds.left + bounds.width / 2
        const y = bounds.bottom - 1
        return {
          x, y, hitsCaption: document.elementFromPoint(x, y) === caption,
          tagScrollWidth: tag.scrollWidth, tagClientWidth: tag.clientWidth,
          captionScrollWidth: caption.scrollWidth, captionClientWidth: caption.clientWidth,
        }
      })
      expect(tagHit.hitsCaption).toBe(true)
      await trigger.focus()
      await page.mouse.click(tagHit.x, tagHit.y)
      expect(await slider.inputValue()).toBe('0')
      expect(await slider.evaluate(element => element === document.activeElement)).toBe(true)
      expect(requests).toBe(0)
      expect(tagHit.tagScrollWidth).toBe(tagHit.tagClientWidth)
      expect(tagHit.captionScrollWidth).toBe(tagHit.captionClientWidth)
      await info.click()
      const tooltip = page.getByRole('tooltip')
      await tooltip.waitFor()
      expect(await tooltip.textContent()).toBe(explanation)
      expect(await menu.isVisible()).toBe(true)
      await info.click()
      await tooltip.waitFor({ state: 'hidden' })
      await trigger.focus()
      await page.keyboard.press('Tab')
      await page.keyboard.press('Tab')
      await page.keyboard.press('Tab')
      expect(await info.evaluate(element => element === document.activeElement)).toBe(true)
      await page.keyboard.press('Enter')
      await tooltip.waitFor()
      await page.keyboard.press('Escape')
      await tooltip.waitFor({ state: 'hidden' })
      expect(await menu.isVisible()).toBe(true)
      expect(await info.evaluate(element => element === document.activeElement)).toBe(true)
      await page.keyboard.press('Space')
      await tooltip.waitFor()
      await page.keyboard.press('Tab')
      await tooltip.waitFor({ state: 'hidden' })
      expect(await slider.evaluate(element => element === document.activeElement)).toBe(true)
      expect(requests).toBe(0)
      await slider.press('ArrowRight')
      await expect.poll(() => scaffold.ctx.agentDefaultModel.currentSelection().reasoningEffort).toBe('off')
      expect(await slider.getAttribute('aria-valuetext')).toBe('关闭')
      expect(await menu.locator('[data-effort-label]').textContent()).toBe('推理等级：关闭')
      expect(await info.count()).toBe(0)
      expect(await menu.evaluate(element => element.getBoundingClientRect().height)).toBe(defaultHeight)
      expect(await slider.evaluate(element => element === document.activeElement)).toBe(true)
      await slider.press('Home')
      await expect.poll(() => slider.getAttribute('aria-busy')).toBe('false')
      await expect.poll(() => scaffold.ctx.agentDefaultModel.currentSelection()).toEqual({
        provider: 'acme-gateway', model: 'acme-think',
      })
      expect(await info.count()).toBe(1)
      expect(await slider.evaluate(element => element === document.activeElement)).toBe(true)
      await page.keyboard.press('Shift+Tab')
      await page.keyboard.press('Enter')
      await tooltip.waitFor()
      await page.keyboard.press('Escape')
      await tooltip.waitFor({ state: 'hidden' })
      expect(await menu.isVisible()).toBe(true)
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'hidden' })
      expect(await trigger.evaluate(element => element === document.activeElement)).toBe(true)
      expect(requests).toBe(2)
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      page.off('request', count)
      if (await trigger.getAttribute('aria-expanded') === 'true') await trigger.click()
    }
  })

  it('offers exactly the declared levels in the root slider and records one keyboard selection', async () => {
    onTestFailed(() => saveFailureShot(page, `web-e2e-declared-reasoning-${engine.name()}`))
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await restoreSelectionAfterTest(page, scaffold)
    await trigger.waitFor({ timeout: 15_000 })
    onTestFinished(async () => {
      if (await trigger.getAttribute('aria-expanded') === 'true') await trigger.click()
    })
    await trigger.click()
    const model = page.getByRole('menuitem', { name: /^模型/ })
    const layout = await model.evaluate((row) => {
      const label = row.children[0]!
      const value = row.children[1]!
      const name = value.querySelector('[data-model-id]')!
      const chevron = row.querySelector(':scope > svg')!
      const labelStyle = getComputedStyle(label)
      const valueStyle = getComputedStyle(value)
      const labelRect = label.getBoundingClientRect()
      const valueRect = value.getBoundingClientRect()
      const chevronRect = chevron.getBoundingClientRect()
      const probe = document.createElement('span')
      probe.style.position = 'absolute'
      probe.style.color = 'var(--dsw-alias-label-tertiary)'
      row.append(probe)
      try {
        return {
          label: label.textContent, labelSize: labelStyle.fontSize, labelPosition: labelStyle.position,
          labelClip: labelStyle.clipPath, labelWidth: labelRect.width, labelHeight: labelRect.height,
          valueAlign: valueStyle.textAlign, valueColor: valueStyle.color, tertiaryColor: getComputedStyle(probe).color,
          valueRightError: Math.abs(name.getBoundingClientRect().right - valueRect.right),
          gapToChevron: chevronRect.left - valueRect.right,
          chevronWidth: chevronRect.width, chevronHeight: chevronRect.height,
        }
      } finally { probe.remove() }
    })
    expect(layout).toMatchObject({ label: '模型', labelSize: '13px', labelPosition: 'absolute', labelClip: 'inset(50%)',
      valueAlign: 'center', chevronWidth: 10, chevronHeight: 10 })
    expect(layout.labelWidth).toBeLessThan(2)
    expect(layout.labelHeight).toBeLessThan(2)
    expect(layout.gapToChevron).toBe(2)
    const slider = page.getByRole('slider', { name: '推理等级', exact: true })
    const levels = page.getByRole('group', { name: '推理等级', exact: true }).getByRole('button')
    expect(await levels.count()).toBe(2)
    expect(await levels.nth(1).getAttribute('aria-label')).toBe('默认推理等级说明')
    expect(await slider.getAttribute('min')).toBe('0')
    expect(await slider.getAttribute('max')).toBe('3')
    expect(await slider.getAttribute('aria-valuetext')).toBe('默认')
    const tag = page.locator('[data-effort-tag]')
    expect(await tag.evaluate(element => ({
      cursor: getComputedStyle(element).cursor,
      userSelect: getComputedStyle(element).getPropertyValue(CSS.supports('user-select', 'none') ? 'user-select' : '-webkit-user-select'),
    }))).toEqual({ cursor: 'default', userSelect: 'none' })
    const caption = page.locator('[data-effort-caption]')
    expect(await caption.evaluate(element => ({
      cursor: getComputedStyle(element).cursor,
      tabIndex: element.tabIndex,
      label: element.getAttribute('aria-label'),
    }))).toEqual({ cursor: 'grab', tabIndex: 0, label: '推理等级：默认' })
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
    await expect.poll(() => trigger.getAttribute('aria-label')).toBe('选择模型，当前 Acme Think，推理等级 高')
    expect(await slider.getAttribute('aria-valuetext')).toBe('高')
    await slider.focus()
    await page.keyboard.press('Shift+Tab')
    await expect.poll(() => page.locator('[data-effort-caption]')
      .evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Shift+Tab')
    await expect.poll(() => page.locator('[data-model-menu-root] > button[role="menuitem"]')
      .evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Shift+Tab')
    await expect.poll(() => page.getByRole('menu').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('opens from the pointer with keyboard focus and closes from the trigger in every pane', async () => {
    onTestFailed(() => saveFailureShot(page, `web-e2e-model-trigger-${engine.name()}`))
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await restoreSelectionAfterTest(page, scaffold)
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
    await restoreSelectionAfterTest(page, scaffold)
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
    const caption = page.locator('[data-effort-caption]')
    expect(await caption.evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Tab')
    const info = page.getByRole('button', { name: '默认推理等级说明', exact: true })
    expect(await info.evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Tab')
    const slider = page.getByRole('slider', { name: '推理等级', exact: true })
    expect(await slider.evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Shift+Tab')
    expect(await info.evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Shift+Tab')
    expect(await caption.evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Shift+Tab')
    expect(await rootModel.evaluate(element => element === document.activeElement)).toBe(true)
    expect(await rootModel.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
    expect(selections).toBe(1)
    const rangeBounds = await slider.boundingBox()
    if (rangeBounds === null) throw new Error('Reasoning slider is not visible')
    await page.mouse.click(rangeBounds.x + rangeBounds.width - 8, rangeBounds.y + rangeBounds.height / 2)
    await expect.poll(() => slider.getAttribute('aria-valuetext')).toBe('最高')
    expect(selections).toBe(2)
    await expect.poll(() => scaffold.ctx.agentDefaultModel.currentSelection().reasoningEffort, { timeout: 10_000 })
      .toBe('max')

    const rejectSelection = async (route: Route): Promise<void> => {
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
    }
    await page.route('**/api/session/selectModel', rejectSelection, { times: 1 })
    try {
      await page.getByRole('menuitem', { name: /^模型/ }).click()
      await expect.poll(() => search.evaluate(element => element === element.ownerDocument.activeElement)).toBe(true)
      expect(await search.getAttribute('aria-activedescendant')).toBe(await target.getAttribute('id'))
      await current.click()
      await page.getByRole('alert').waitFor()
    } finally {
      await page.unroute('**/api/session/selectModel', rejectSelection)
    }
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
    await restoreSelectionAfterTest(page, scaffold)
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
      expect(await group.getByRole('button').count()).toBe(2)
      expect(await group.getByRole('button').nth(1).getAttribute('aria-label')).toBe('默认推理等级说明')
      expect(await slider.getAttribute('aria-valuetext')).toBe('默认')
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
        }))).toEqual({ value: '5', label: '最高', busy: 'false', disabled: false })
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

  it('keeps visual motion aligned with native dragging, hover targets and pending saves at 390px', async () => {
    onTestFailed(() => saveFailureShot(page, `web-e2e-effort-motion-${engine.name()}`))
    const viewport = page.viewportSize()!
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await restoreSelectionAfterTest(page, scaffold)
    try {
      await trigger.click()
      await page.getByRole('menuitem', { name: /^模型/ }).click()
      await page.getByRole('menuitemradio', { name: 'Acme Lite', exact: true }).click()
      await page.setViewportSize({ width: 390, height: 700 })
      const slider = page.getByRole('slider', { name: '推理等级', exact: true })
      await slider.press('Home')
      await expect.poll(() => slider.getAttribute('aria-busy')).toBe('false')
      await slider.hover()
      await page.mouse.move(0, 0)
      await expect.poll(async () => (await readEffortMotion(slider)).dotWidth).toBeCloseTo(8, 1)
      const rest = await assertSettledEffort(slider)
      await expect.poll(async () => (await readEffortMotion(slider)).visualWidth).toBeCloseTo(20, 1)
      expect(rest.dotWidth).toBeCloseTo(8, 1)
      expect(rest.thumbDuration).toBe('0.3s')
      expect(rest.fillDuration).toBe('0.3s')
      expect(rest.thumbEasing).toBe('cubic-bezier(0.23, 1, 0.32, 1)')
      expect(rest.dotDuration.split(',').map(value => value.trim())).toEqual(['0.14s', '0.14s'])
      expect(rest.dotEasing).toBe('cubic-bezier(0.23, 1, 0.32, 1), cubic-bezier(0.23, 1, 0.32, 1)')
      expect(rest.tickDuration).toBe('0.12s')
      await page.mouse.move(rest.center, rest.y)
      await expect.poll(async () => (await readEffortMotion(slider)).dotWidth).toBeCloseTo(9.6, 1)
      const expanded = await readEffortMotion(slider)
      expect(expanded.visualWidth).toBeCloseTo(20, 1)
      expect(Math.abs(expanded.center - rest.center)).toBeLessThan(1)
      const tick = rest.ticks[2]!
      await page.mouse.move(tick.center + 7, rest.y)
      await expect.poll(async () => (await readEffortMotion(slider)).ticks[2]!.width).toBeCloseTo(8, 1)
      const hovered = await readEffortMotion(slider)
      expect(hovered.ticks.filter(point => point.hovered)).toHaveLength(1)
      expect(Math.abs(hovered.ticks[2]!.center - tick.center)).toBeLessThan(1)
      await page.mouse.move(tick.center + 9, rest.y)
      await expect.poll(async () => (await readEffortMotion(slider)).ticks[2]!.width).toBeCloseTo(4, 1)
      const release = Promise.withResolvers<undefined>()
      let requests = 0
      const forwarding: Promise<void>[] = []
      const holdSelection = (route: Route): Promise<void> => {
        requests++
        const forwarded = (async () => { await release.promise; await route.continue() })()
        forwarding.push(forwarded)
        return forwarded
      }
      await page.route('**/api/session/selectModel', holdSelection)
      try {
        const grabOffset = 6
        await page.mouse.move(rest.center + grabOffset, rest.y)
        await page.mouse.down()
        await expect.poll(async () => (await readEffortMotion(slider)).dotWidth).toBeCloseTo(9.6, 1)
        expect((await readEffortMotion(slider)).visualWidth).toBeCloseTo(20, 1)
        const step = (rest.nativeWidth - rest.thumbSize) / 5
        const between = rest.center + step * 0.3
        await page.mouse.move(between + grabOffset, rest.y, { steps: 3 })
        const tracking = await readEffortMotion(slider)
        expect(tracking.value).toBe(0)
        expect(Math.abs(tracking.center - between)).toBeLessThan(1)
        expect(Math.abs(tracking.fillRight - tracking.center)).toBeLessThan(1)
        expect(tracking.ticks.every(point => point.visibility === 'visible')).toBe(true)
        expect(tracking.thumbDuration).toBe('0s')
        expect(tracking.fillDuration).toBe('0s')
        expect(Math.abs(tracking.labelCenter - expectedTagCenter(tracking, tracking.center))).toBeLessThan(1)
        for (const offset of [-11, -9, 9, 11]) {
          await page.mouse.move(tick.center + offset + grabOffset, rest.y)
          const snapped = await readEffortMotion(slider)
          const expected = Math.abs(offset) < 10 ? tick.center : tick.center + offset
          expect(Math.abs(snapped.center - expected)).toBeLessThan(1)
          expect(Math.abs(snapped.fillRight - expected)).toBeLessThan(1)
          expect(Math.abs(snapped.labelCenter - expectedTagCenter(snapped, expected))).toBeLessThan(1)
          expect(snapped.value).toBe(2)
          expect(requests).toBe(0)
        }
        await page.mouse.move(tick.center + grabOffset, rest.y, { steps: 4 })
        const dragging = await readEffortMotion(slider)
        expect(dragging.ticks.every(point => !point.hovered)).toBe(true)
        expect(dragging.ticks.every(point => Math.abs(point.width - 4) < 0.1)).toBe(true)
        await page.mouse.move(rest.right + 24, rest.y, { steps: 8 })
        expect(requests).toBe(0)
        await page.mouse.up()
        await expect.poll(() => requests).toBe(1)
        await expect.poll(() => slider.getAttribute('aria-busy')).toBe('true')
        const pending = await assertSettledEffort(slider)
        expect(pending.value).toBe(5)
        expect(await slider.evaluate(element => element === document.activeElement)).toBe(true)
        expect(await slider.evaluate(element => (element as HTMLInputElement).disabled)).toBe(false)
        await slider.press('ArrowLeft')
        expect((await readEffortMotion(slider)).value).toBe(5)
        expect(requests).toBe(1)
        release.resolve(undefined)
        await expect.poll(() => slider.getAttribute('aria-busy')).toBe('false')
        const saved = await assertSettledEffort(slider)
        expect(Math.abs(saved.center - pending.center)).toBeLessThan(1)
        expect(await slider.evaluate(element => element === document.activeElement)).toBe(true)
        expect(requests).toBe(1)
      } finally {
        release.resolve(undefined)
        try { await page.mouse.up() } finally {
          try { await page.unroute('**/api/session/selectModel', holdSelection) } finally { await Promise.all(forwarding) }
        }
      }
      await page.mouse.move(rest.ticks[2]!.center, rest.y)
      await page.mouse.down()
      try {
        await expect.poll(() => slider.inputValue()).toBe('2')
        const clicked = await readEffortMotion(slider)
        expect(clicked.dragging).toBe(false)
        expect(clicked.thumbDuration).toBe('0.3s')
        expect(clicked.fillDuration).toBe('0.3s')
      } finally {
        await page.mouse.up()
      }
      await expect.poll(() => slider.getAttribute('aria-busy')).toBe('false')
      expect((await assertSettledEffort(slider)).value).toBe(2)
      await slider.press('Home')
      await expect.poll(() => slider.getAttribute('aria-busy')).toBe('false')
      expect((await assertSettledEffort(slider)).value).toBe(0)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await slider.press('End')
      await expect.poll(() => slider.getAttribute('aria-busy')).toBe('false')
      const reduced = await assertSettledEffort(slider)
      expect(reduced.value).toBe(5)
      expect(reduced.thumbDuration).toBe('0s')
      expect(reduced.fillDuration).toBe('0s')
      expect(reduced.dotDuration).toBe('0s')
      expect(reduced.tickDuration).toBe('0s')
      await page.mouse.move(reduced.center, reduced.y)
      expect((await readEffortMotion(slider)).visualWidth).toBeCloseTo(20, 1)
      expect((await readEffortMotion(slider)).dotWidth).toBeCloseTo(8, 1)
      await page.mouse.move(reduced.ticks[2]!.center, reduced.y)
      expect((await readEffortMotion(slider)).ticks[2]!.width).toBeCloseTo(4, 1)
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      try { await page.mouse.up() } finally {
        try { await page.emulateMedia({ reducedMotion: null }) } finally {
          try {
            if (await trigger.getAttribute('aria-expanded') === 'true') await trigger.click()
          } finally { await page.setViewportSize(viewport) }
        }
      }
    }
  })

  it('does not leave thumb or tick hover enlarged after a native touch tap', async () => {
    await restoreSelectionAfterTest(page, scaffold)
    const touch = await browser.newPage({
      viewport: { width: 390, height: 700 }, locale: ZH_BROWSER_LOCALE, hasTouch: true, isMobile: true,
    })
    const consoleWatch = watchConsole(touch)
    try {
      await touch.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await connectFreshWorkspaceZh(touch, scaffold.workspaceCwd)
      await touch.getByRole('button', { name: /^选择模型/ }).click()
      await touch.getByRole('menuitem', { name: /^模型/ }).click()
      await touch.getByRole('menuitemradio', { name: 'Acme Lite', exact: true }).click()
      const slider = touch.getByRole('slider', { name: '推理等级', exact: true })
      await slider.press('Home')
      await expect.poll(() => slider.getAttribute('aria-busy')).toBe('false')
      const before = await assertSettledEffort(slider)
      expect(before.value).toBe(0)
      expect(await touch.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches)).toBe(false)
      let requests = 0
      const count = (request: Request): void => {
        if (new URL(request.url()).pathname.endsWith('/session/selectModel')) requests++
      }
      touch.on('request', count)
      try {
        const info = touch.getByRole('button', { name: '默认推理等级说明', exact: true })
        const bounds = await info.boundingBox()
        if (bounds === null) throw new Error('Default information is not visible')
        await touch.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
        const tooltip = touch.getByRole('tooltip')
        await tooltip.waitFor()
        expect(await tooltip.textContent()).toBe('未显式指定推理等级，将使用模型与配置的默认设置；这不代表关闭推理')
        expect(await slider.inputValue()).toBe('0')
        expect(requests).toBe(0)
        await touch.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
        await tooltip.waitFor({ state: 'hidden' })
        expect(await info.isVisible()).toBe(true)
        await touch.touchscreen.tap(before.right - 10, before.y)
        await expect.poll(() => slider.inputValue()).toBe('5')
        await expect.poll(() => slider.getAttribute('aria-busy')).toBe('false')
        await assertSettledEffort(slider)
        await expect.poll(async () => (await readEffortMotion(slider)).visualWidth).toBeCloseTo(20, 1)
        await expect.poll(async () => (await readEffortMotion(slider)).dotWidth).toBeCloseTo(8, 1)
        expect(await touch.locator('[data-effort-thumb-scale][data-expanded]').count()).toBe(0)
        expect((await readEffortMotion(slider)).ticks.every(tick => !tick.hovered && Math.abs(tick.width - 4) < 0.1)).toBe(true)
        expect(requests).toBe(1)
        expect(consoleWatch.pageErrors).toEqual([])
      } finally {
        touch.off('request', count)
      }
    } finally {
      try {
        const trigger = touch.getByRole('button', { name: /^选择模型/ })
        if (await trigger.count() === 1) await expect.poll(() => trigger.getAttribute('aria-busy')).toBe('false')
      } finally { await touch.close() }
    }
  })

  it('keeps the compact Spanish caption and default information readable at 390px', async () => {
    await restoreSelectionAfterTest(page, scaffold)
    const probe = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'es-ES' })
    const consoleWatch = watchConsole(probe)
    try {
      await probe.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await probe.getByRole('button', { name: 'Agregar espacio de trabajo', exact: true }).click()
      const directory = probe.getByRole('dialog', { name: 'Seleccionar carpeta de trabajo', exact: true })
      await directory.getByRole('button', { name: 'Editar ruta', exact: true }).click()
      const path = directory.getByRole('textbox', { name: 'Editar ruta', exact: true })
      await path.fill(join(scaffold.workspaceCwd, 'workspace'))
      await path.press('Enter')
      await directory.getByRole('button', { name: 'Abrir', exact: true }).click()
      await probe.locator('[data-composer-input][contenteditable="true"]').waitFor()
      await probe.getByRole('button', { name: /^Seleccionar modelo/ }).click()
      await probe.getByRole('menuitem', { name: /^modelo/ }).click()
      await probe.getByRole('menuitemradio', { name: 'Acme Lite', exact: true }).click()
      const menu = probe.getByRole('menu', { name: 'Esfuerzo de modelo y razonamiento.', exact: true })
      const slider = menu.getByRole('slider', { name: 'Esfuerzo', exact: true })
      await slider.press('Home')
      await expect.poll(() => slider.getAttribute('aria-busy')).toBe('false')
      await probe.setViewportSize({ width: 390, height: 700 })
      const label = menu.locator('[data-effort-label]')
      const info = menu.getByRole('button', { name: 'Acerca del esfuerzo de razonamiento predeterminado', exact: true })
      await info.waitFor()
      const layout = await info.evaluate((button) => {
        const tag = button.parentElement!
        const text = tag.querySelector<HTMLElement>('[data-effort-label]')!
        const name = text.querySelector<HTMLElement>('[data-effort-name]')!
        const prefix = name.previousElementSibling!
        const bounds = button.getBoundingClientRect()
        const tagBounds = tag.getBoundingClientRect()
        const nameBounds = name.getBoundingClientRect()
        const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
        return { width: bounds.width, height: bounds.height, textWidth: text.clientWidth,
          textGap: bounds.left - text.getBoundingClientRect().right, endInset: tagBounds.right - bounds.right,
          clipped: prefix.scrollWidth > prefix.clientWidth, ellipsis: getComputedStyle(prefix).textOverflow,
          nameText: name.textContent, nameFits: name.scrollWidth <= name.clientWidth,
          nameVisible: nameBounds.width > 0 && nameBounds.left >= tagBounds.left && nameBounds.right <= bounds.left,
          contained: bounds.left >= tagBounds.left && bounds.right <= tagBounds.right,
          reachable: hit?.closest('button') === button }
      })
      expect(layout).toMatchObject({ width: 24, height: 24, clipped: false, ellipsis: 'ellipsis',
        nameText: 'Predeterminado', nameFits: true, nameVisible: true, contained: true, reachable: true })
      expect(layout.textWidth).toBeGreaterThan(0)
      expect(layout.textGap).toBeCloseTo(2, 1)
      expect(layout.endInset).toBeCloseTo(2, 1)
      expect(await label.textContent()).toBe('Esfuerzo: Predeterminado')
      await label.hover()
      const tooltip = probe.getByRole('tooltip')
      expect(await tooltip.count()).toBe(0)
      await info.click()
      await expect.poll(() => tooltip.allTextContents()).toEqual([
        'No se ha seleccionado explícitamente un esfuerzo de razonamiento. Se aplican los valores predeterminados del modelo y de la configuración; esto no significa que el razonamiento esté desactivado.',
      ])
      expect(await menu.isVisible()).toBe(true)
      expect(await slider.inputValue()).toBe('0')
      await probe.keyboard.press('Escape')
      await tooltip.waitFor({ state: 'hidden' })
      expect(await menu.isVisible()).toBe(true)
      await info.focus()
      await probe.keyboard.press('Enter')
      await tooltip.waitFor()
      await probe.keyboard.press('Tab')
      await tooltip.waitFor({ state: 'hidden' })
      expect(await slider.evaluate(element => element === document.activeElement)).toBe(true)
      expect(await slider.inputValue()).toBe('0')
      expect(consoleWatch.pageErrors).toEqual([])
    } finally {
      try {
        const trigger = probe.getByRole('button', { name: /^Seleccionar modelo/ })
        if (await trigger.count() === 1) await expect.poll(() => trigger.getAttribute('aria-busy')).toBe('false')
      } finally { await probe.close() }
    }
  })

  it.each(['success', 'failure'] as const)('keeps Team undimmed and guarded through a pending effort %s', async (outcome) => {
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await restoreSelectionAfterTest(page, scaffold)
    const release = Promise.withResolvers<undefined>()
    let selections = 0
    let teamWrites = 0
    const forwarding: Promise<void>[] = []
    const countTeamWrites = (request: Request): void => {
      if (new URL(request.url()).pathname.endsWith('/agentTeams/setEnabled')) teamWrites++
    }
    const holdSelection = (route: Route): Promise<void> => {
      selections++
      const forwarded = (async () => {
        await release.promise
        if (outcome === 'success') { await route.continue(); return }
        const envelope = route.request().postDataJSON() as { rpcId: string }
        await route.fulfill({ json: { type: 'server-response', rpcId: envelope.rpcId, result: {
          ok: false, error: { code: 'session/writer-held', message: 'held', details: { sessionId: 'team-pending-fixture' } },
        } } })
      })()
      forwarding.push(forwarded)
      return forwarded
    }
    await trigger.click()
    await page.getByRole('menuitem', { name: /^模型/ }).click()
    await page.getByRole('menuitemradio', { name: 'Acme Lite', exact: true }).click()
    const slider = page.getByRole('slider', { name: '推理等级', exact: true })
    await slider.press('Home')
    await expect.poll(() => slider.getAttribute('aria-busy')).toBe('false')
    await page.keyboard.down('ArrowRight')
    await page.keyboard.down('ArrowRight')
    await page.keyboard.down('ArrowRight')
    await page.keyboard.up('ArrowRight')
    await expect.poll(() => slider.getAttribute('aria-busy')).toBe('false')
    await expect.poll(() => scaffold.ctx.agentDefaultModel.currentSelection().reasoningEffort).toBe('high')
    await page.mouse.move(0, 0)
    const menuLocator = page.getByRole('menu', { name: '模型与推理等级', exact: true })
    const teamLocator = page.locator('[data-model-menu-page="agent-team"]')
    const menu = await menuLocator.elementHandle()
    onTestFinished(async () => { await menu?.dispose() })
    const root = await page.locator('[data-model-menu-root]').elementHandle()
    onTestFinished(async () => { await root?.dispose() })
    const team = await teamLocator.elementHandle()
    onTestFinished(async () => { await team?.dispose() })
    if (menu === null || root === null || team === null) throw new Error('Missing pending Team controls')
    const sample = () => page.evaluate(({ menu, root, team }) => {
      const rect = (element: Element) => {
        const value = element.getBoundingClientRect()
        return { x: value.x, y: value.y, width: value.width, height: value.height }
      }
      return {
        same: {
          menu: menu === document.querySelector('[role="menu"][aria-label="模型与推理等级"]'),
          root: root === document.querySelector('[data-model-menu-root]'),
          team: team === document.querySelector('[data-model-menu-page="agent-team"]'),
        },
        connected: menu.isConnected && root.isConnected && team.isConnected,
        rect: { menu: rect(menu), root: rect(root), team: rect(team) },
        disabled: (team as HTMLButtonElement).disabled, opacity: getComputedStyle(team).opacity,
        ariaDisabled: team.getAttribute('aria-disabled'), ariaBusy: team.getAttribute('aria-busy'),
        focus: document.activeElement === team ? 'team' : document.activeElement === root.querySelector('input[type="range"]') ? 'range' : 'other',
      }
    }, { menu, root, team })
    page.on('request', countTeamWrites)
    try {
      const before = await sample()
      expect(before).toMatchObject({ same: { menu: true, root: true, team: true }, connected: true,
        disabled: false, opacity: '1', ariaDisabled: null, ariaBusy: null, focus: 'range' })
      await page.route('**/api/session/selectModel', holdSelection)
      await page.keyboard.down('ArrowLeft')
      await page.keyboard.down('ArrowLeft')
      await page.keyboard.up('ArrowLeft')
      await expect.poll(() => selections).toBe(1)
      await expect.poll(() => teamLocator.getAttribute('aria-busy')).toBe('true')
      const during = await sample()
      expect(during).toEqual({ ...before, ariaDisabled: 'true', ariaBusy: 'true' })
      const bounds = during.rect.team
      await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      expect(await menuLocator.getByRole('switch').count()).toBe(0)
      expect(await slider.evaluate(element => element === document.activeElement)).toBe(true)
      await page.keyboard.press('Tab')
      expect(await teamLocator.evaluate(element => element === document.activeElement)).toBe(true)
      await page.keyboard.press('Enter')
      await page.keyboard.press('Space')
      expect(await teamLocator.evaluate(element => element === document.activeElement)).toBe(true)
      expect(await menuLocator.getByRole('switch').count()).toBe(0)
      expect(teamWrites).toBe(0)
      expect(selections).toBe(1)
      release.resolve(undefined)
      await expect.poll(() => teamLocator.getAttribute('aria-busy')).toBeNull()
      await expect.poll(() => slider.getAttribute('aria-busy')).toBe('false')
      const after = await sample()
      expect(after).toEqual({ ...before, focus: 'team' })
      expect(await teamLocator.evaluate(element => element === document.activeElement)).toBe(true)
      await page.keyboard.press('Shift+Tab')
      expect(await slider.evaluate(element => element === document.activeElement)).toBe(true)
      expect(scaffold.ctx.agentDefaultModel.currentSelection().reasoningEffort).toBe(outcome === 'success' ? 'low' : 'high')
      if (outcome === 'failure') await page.getByRole('alert').waitFor()
      expect(selections).toBe(1)
      expect(teamWrites).toBe(0)
      const lockedOpacity = await team.evaluate((element) => {
        const button = element as HTMLButtonElement
        try { button.disabled = true; return getComputedStyle(button).opacity } finally { button.disabled = false }
      })
      expect(lockedOpacity).toBe('0.5')
      await page.keyboard.press('Tab')
      expect(await teamLocator.evaluate(element => element === document.activeElement)).toBe(true)
      await teamLocator.click()
      await page.getByRole('switch', { name: '启用智能体团队协作', exact: true }).waitFor()
      expect(teamWrites).toBe(0)
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      release.resolve(undefined)
      page.off('request', countTeamWrites)
      try { await page.keyboard.up('ArrowLeft') } finally {
        try { await page.unroute('**/api/session/selectModel', holdSelection) } finally { await Promise.all(forwarding) }
      }
    }
  })

  it('clicks the caption without changing effort and drags outside it to submit Default once', async () => {
    const viewport = page.viewportSize()!
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await restoreSelectionAfterTest(page, scaffold)
    let writes = 0
    const count = (request: Request): void => {
      if (new URL(request.url()).pathname.endsWith('/session/selectModel')) writes++
    }
    try {
      await trigger.click()
      await page.getByRole('menuitem', { name: /^模型/ }).click()
      await page.getByRole('menuitemradio', { name: 'Acme Lite', exact: true }).click()
      await page.setViewportSize({ width: 390, height: 700 })
      const slider = page.getByRole('slider', { name: '推理等级', exact: true })
      const caption = page.locator('[data-effort-caption]')
      await slider.press('End')
      await expect.poll(() => slider.getAttribute('aria-busy')).toBe('false')
      await expect.poll(() => scaffold.ctx.agentDefaultModel.currentSelection().reasoningEffort).toBe('max')
      expect(await page.locator('[data-effort-tag] svg').count()).toBe(0)
      expect(await page.locator('[data-effort-tail-frame], [data-effort-tail]').count()).toBe(0)
      page.on('request', count)
      await caption.click()
      expect(await slider.evaluate(element => element === document.activeElement)).toBe(true)
      expect(await slider.inputValue()).toBe('5')
      expect(writes).toBe(0)
      const before = await assertSettledEffort(slider)
      const bounds = await caption.boundingBox()
      if (bounds === null) throw new Error('Effort caption is not visible')
      const start = bounds.x + bounds.width / 2
      const end = start - (before.nativeWidth - before.thumbSize)
      const y = bounds.y + bounds.height / 2
      await page.mouse.move(start, y)
      await page.mouse.down()
      try {
        const tick = before.ticks[2]!
        for (const offset of [-11, -9, 9, 11]) {
          await page.mouse.move(start + tick.center - before.center + offset, y)
          const snapped = await readEffortMotion(slider)
          const expected = Math.abs(offset) < 10 ? tick.center : tick.center + offset
          expect(Math.abs(snapped.center - expected)).toBeLessThan(1)
          expect(Math.abs(snapped.fillRight - expected)).toBeLessThan(1)
          expect(Math.abs(snapped.labelCenter - expectedTagCenter(snapped, expected))).toBeLessThan(1)
          expect(snapped.value).toBe(2)
          expect(writes).toBe(0)
        }
        await page.mouse.move(end, y, { steps: 8 })
        await expect.poll(() => slider.inputValue()).toBe('0')
        await assertSettledEffort(slider)
        expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('[data-effort-caption]')),
          { x: end, y })).toBe(false)
        expect(writes).toBe(0)
      } finally {
        await page.mouse.up()
      }
      await expect.poll(() => writes).toBe(1)
      await expect.poll(() => slider.getAttribute('aria-busy')).toBe('false')
      await expect.poll(() => scaffold.ctx.agentDefaultModel.currentSelection().reasoningEffort).toBeUndefined()
      expect(await slider.evaluate(element => element === document.activeElement)).toBe(true)
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      page.off('request', count)
      try { await page.mouse.up() } finally {
        try {
          if (await trigger.getAttribute('aria-expanded') === 'true') await trigger.click()
        } finally { await page.setViewportSize(viewport) }
      }
    }
  })

  it.each(['Escape', 'capture loss'] as const)('cancels a native caption drag on %s and lets Escape close the root afterward', async (cancel) => {
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await restoreSelectionAfterTest(page, scaffold)
    await trigger.click()
    await page.getByRole('menuitem', { name: /^模型/ }).click()
    await page.getByRole('menuitemradio', { name: 'Acme Lite', exact: true }).click()
    const slider = page.getByRole('slider', { name: '推理等级', exact: true })
    await slider.press('End')
    await expect.poll(() => slider.getAttribute('aria-busy')).toBe('false')
    await expect.poll(() => scaffold.ctx.agentDefaultModel.currentSelection().reasoningEffort).toBe('max')
    const before = await assertSettledEffort(slider)
    const caption = page.locator('[data-effort-caption]')
    const capture = await caption.evaluateHandle((element) => {
      const button = element as HTMLButtonElement
      let pointerId: number | null = null
      let lost = 0
      const started = (event: PointerEvent) => { pointerId = event.pointerId }
      const released = () => { lost++ }
      button.addEventListener('pointerdown', started)
      button.addEventListener('lostpointercapture', released)
      return {
        read: () => ({ held: pointerId !== null && button.hasPointerCapture(pointerId), lost }),
        release: () => { if (pointerId !== null) button.releasePointerCapture(pointerId) },
        dispose: () => {
          button.removeEventListener('pointerdown', started)
          button.removeEventListener('lostpointercapture', released)
        },
      }
    })
    let writes = 0
    const count = (request: Request): void => {
      if (new URL(request.url()).pathname.endsWith('/session/selectModel')) writes++
    }
    page.on('request', count)
    try {
      const bounds = await caption.boundingBox()
      if (bounds === null) throw new Error('Effort caption is not visible')
      const x = bounds.x + bounds.width / 2
      const y = bounds.y + bounds.height / 2
      const end = x - (before.nativeWidth - before.thumbSize) * 0.6
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(end, y, { steps: 4 })
      await expect.poll(() => capture.evaluate(probe => probe.read().held)).toBe(true)
      await expect.poll(() => slider.inputValue()).toBe('2')
      expect(writes).toBe(0)
      if (cancel === 'Escape') await page.keyboard.press('Escape')
      else await capture.evaluate((probe) => { probe.release() })
      // Moving flushes the browser's pending lostpointercapture, not a synthetic event.
      await page.mouse.move(end - 1, y)
      await expect.poll(() => capture.evaluate(probe => probe.read())).toEqual({ held: false, lost: 1 })
      expect(await slider.inputValue()).toBe('5')
      expect(await trigger.getAttribute('aria-expanded')).toBe('true')
      expect(await slider.evaluate(element => element === document.activeElement)).toBe(true)
      await page.mouse.up()
      expect(writes).toBe(0)
      expect(scaffold.ctx.agentDefaultModel.currentSelection().reasoningEffort).toBe('max')
      await page.keyboard.press('Escape')
      await expect.poll(() => trigger.getAttribute('aria-expanded')).toBe('false')
      expect(await trigger.evaluate(element => element === document.activeElement)).toBe(true)
      expect(writes).toBe(0)
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      page.off('request', count)
      try { await page.mouse.up() } finally {
        try { await capture.evaluate((probe) => { probe.dispose() }) } finally { await capture.dispose() }
      }
    }
  })

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md', 'pointer-menu.expected.md'])
  })
})
