/** Real assembled UI plus source-compiled browser regressions for focus-ring paint. */
import { join } from 'node:path'
import { build } from 'vite'
import { chromium, type Locator, type Page } from 'playwright'
import { beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT } from './support.ts'

/** Read rendered paint and browser focus, not just the modality publisher's attribute. */
async function paint(target: Locator) {
  return target.evaluate((element) => {
    const style = getComputedStyle(element)
    const resolveColor = (value: string): string => {
      const probe = document.createElement('span')
      probe.style.color = value
      document.body.append(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      return color
    }
    return {
      active: document.activeElement === element,
      focusVisible: element.matches(':focus-visible'),
      modality: document.documentElement.getAttribute('data-input-modality'),
      focusColor: resolveColor(style.getPropertyValue('--dsw-alias-state-business-primary').trim()),
      hover: resolveColor(style.getPropertyValue('--dsw-alias-interactive-bg-hover').trim()),
      outline: style.outlineColor,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      shadow: style.boxShadow,
      background: style.backgroundColor,
    }
  })
}

async function expectSilent(target: Locator): Promise<void> {
  const state = await paint(target)
  expect(state.active).toBe(true)
  expect(state.modality).toBe('pointer')
  expect(state.focusColor).toMatch(/^rgb/)
  expect(state.outlineStyle === 'none' || state.outline === 'rgba(0, 0, 0, 0)').toBe(true)
  expect(state.shadow).not.toContain(state.focusColor)
}

async function expectFocusRing(target: Locator, kind: 'outline' | 'shadow'): Promise<void> {
  await expect.poll(async () => {
    const state = await paint(target)
    return {
      active: state.active,
      visible: state.focusVisible,
      modality: state.modality,
      painted: kind === 'shadow'
        ? state.shadow.includes(state.focusColor)
        : state.outline === state.focusColor && state.outlineStyle === 'solid' && Number.parseFloat(state.outlineWidth) > 0,
    }
  }).toEqual({ active: true, visible: true, modality: 'keyboard', painted: true })
}

/**
 * Name every ancestor that cuts the ring's painted box. A control flush with an
 * `overflow: hidden` ancestor keeps its outline geometrically but loses the pixels that leave
 * that ancestor, so compare the layout box grown by the ring against each clipping ancestor.
 */
async function ringCutBy(target: Locator): Promise<string[]> {
  return target.evaluate((element) => {
    const style = getComputedStyle(element)
    const width = Number.parseFloat(style.outlineWidth) || 0
    const offset = Number.parseFloat(style.outlineOffset) || 0
    const box = element.getBoundingClientRect()
    const ring = {
      left: box.left - width - offset,
      top: box.top - width - offset,
      right: box.right + width + offset,
      bottom: box.bottom + width + offset,
    }
    const cuts: string[] = []
    for (let node = element.parentElement; node !== null; node = node.parentElement) {
      const overflow = getComputedStyle(node)
      if (overflow.overflow === 'visible' && overflow.overflowX === 'visible' && overflow.overflowY === 'visible') continue
      const rect = node.getBoundingClientRect()
      const cut = {
        left: Math.max(0, rect.left - ring.left),
        top: Math.max(0, rect.top - ring.top),
        right: Math.max(0, ring.right - rect.right),
        bottom: Math.max(0, ring.bottom - rect.bottom),
      }
      if (cut.left + cut.top + cut.right + cut.bottom > 0.5) {
        cuts.push(`${node.tagName.toLowerCase()}${node.className === '' ? '' : `.${node.className}`} cuts ${JSON.stringify(cut)}`)
      }
    }
    return cuts
  })
}

it.each(['light', 'dark'] as const)('assembled app (%s): pointer keys stay silent; navigation and menu activation retain feedback', async (theme) => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch({ headless: true })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const consoleWatch = watchConsole(page)
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe(theme === 'dark' ? '' : null)
  const trigger = page.getByRole('button', { name: /^Access mode, current:/ })
  expect((await paint(trigger)).focusColor).toBe(theme === 'dark' ? 'rgb(122, 170, 255)' : 'rgb(65, 118, 230)')

  await trigger.click()
  await page.getByRole('menu').waitFor()
  await expectSilent(trigger)
  await page.keyboard.press('Shift')
  await expectSilent(trigger)
  await page.keyboard.press('Escape')
  await page.getByRole('menu').waitFor({ state: 'hidden' })
  await expectSilent(trigger)

  for (const key of ['Home', 'End']) {
    await trigger.click()
    await page.keyboard.press('Escape')
    await expectSilent(trigger)
    await page.keyboard.press(key)
    await expectFocusRing(trigger, 'shadow')
  }

  await trigger.click()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Shift+Tab')
  expect(await trigger.evaluate(element => element === document.activeElement)).toBe(false)
  await page.keyboard.press('Tab')
  await expectFocusRing(trigger, 'shadow')
  for (const key of ['Enter', 'Space']) {
    await page.keyboard.press(key)
    await page.getByRole('menu').waitFor()
    await expectFocusRing(trigger, 'shadow')
    const menu = page.getByRole('menu')
    for (const [navigation, index] of [['End', -1], ['Home', 0]] as const) {
      await page.keyboard.press(navigation)
      const row = menu.getByRole('menuitem').nth(index)
      const state = await paint(row)
      expect(state.active).toBe(true)
      expect(state.focusVisible).toBe(true)
      expect(state.modality).toBe('keyboard')
      // Menu rows intentionally use the hover fill instead of a second outline.
      expect(state.background).toBe(state.hover)
      expect(state.background).not.toBe('rgba(0, 0, 0, 0)')
    }
    await page.keyboard.press('Escape')
    await expectFocusRing(trigger, 'shadow')
  }
  expect(consoleWatch.warnings).toEqual([])
  expect(consoleWatch.pageErrors).toEqual([])
})

it.each(['light', 'dark'] as const)('assembled app (%s): the sidebar toggle keeps its whole ring in the expanded and rail layouts', async (theme) => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch({ headless: true })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspace(page, scaffold.workspaceCwd)

  const toggle = page.getByRole('button', { name: 'Collapse sidebar' })
  const rail = page.getByRole('button', { name: 'Open sidebar' })
  /** Sample the ring box once the collapse animation stops moving the control. */
  const settle = async (target: Locator, width: number): Promise<void> => {
    await expect.poll(() => target.evaluate(element => element.getBoundingClientRect().width)).toBe(width)
    await target.evaluate(async (element) => {
      for (let node: Element | null = element; node !== null; node = node.parentElement) {
        await Promise.all(node.getAnimations().map(animation => animation.finished))
      }
    })
  }

  await toggle.click()
  await rail.waitFor()
  // The rail only replaces the frozen wide layout once the collapse settles.
  await settle(rail, 36)
  await expectSilent(rail)
  await page.keyboard.press('Home')
  await expectFocusRing(rail, 'outline')
  expect(await ringCutBy(rail)).toEqual([])

  await rail.click()
  await toggle.waitFor()
  await settle(toggle, 28)
  await expectSilent(toggle)
  await page.keyboard.press('Home')
  await expectFocusRing(toggle, 'outline')
  expect(await ringCutBy(toggle)).toEqual([])
})

/**
 * Supplementary fixture, not an assembled app: Vite compiles the actual Menu,
 * Switch, input-modality module and CSS Modules in memory. Only arrangement and
 * state ownership belong to the fixture; no test writes the modality attribute.
 */
async function compileFixture(): Promise<{ script: string; css: string }> {
  const source = (relative: string): string => JSON.stringify(join(REPO_ROOT, 'packages/client', relative).replaceAll('\\', '/'))
  const entry = join(REPO_ROOT, 'apps/web/focus-rings-fixture.tsx').replaceAll('\\', '/')
  const code = `
    import React, { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import { Menu } from ${source('ui-primitives/src/Menu.tsx')}
    import { Switch } from ${source('ui-primitives/src/Switch.tsx')}
    import ${source('ui-primitives/src/input-modality.ts')}
    import ${source('ui-theme/src/styles/base.css')}
    import ${source('ui-theme/src/styles/design-platform.css')}
    import ${source('ui-theme/src/styles/focus.css')}
    import ${source('ui-theme/src/styles/gradient-shadow-text.css')}
    import triggerCss from ${source('ui-permission-presets/src/client/PermissionSelect.module.css')}
    import feedbackCss from ${source('ui-message-feedback/src/client/FeedbackDialog.module.css')}
    import workflowCss from ${source('ui-workflow-run/src/client/WorkflowRunPanel.module.css')}
    import cardCss from ${source('ui-primitives/src/HoverCard.module.css')}
    import pillCss from ${source('ui-primitives/src/Pill.module.css')}
    import trajectoryCss from ${source('ui-trajectory/src/client/TrajectoryTable.module.css')}
    import onboardingCss from ${source('ui-settings-account/src/client/DesktopOnboarding.module.css')}
    function Fixture() {
      const [checked, setChecked] = useState(false)
      const [open, setOpen] = useState(false)
      return <main style={{ padding: 40, display: 'grid', gap: 24, width: 420 }}>
        <div data-onboarding-card className={onboardingCss.card}>
          <label><input type="checkbox" aria-label="Onboarding purpose" />Purpose</label>
        </div>
        <Switch label="Toggle" checked={checked} onChange={setChecked} />
        <button id="default-outline">Default browser outline</button>
        <button id="outline-none" aria-label="Outline disabled" style={{ outline: 'none' }}>No outline</button>
        <Menu open={open} autoFocus onClose={() => setOpen(false)}
          anchor={<button className={triggerCss.trigger} onClick={() => setOpen(!open)}>Open menu</button>}
          items={[{ id: 'first', label: 'First item' }, { id: 'last', label: 'Last item' }]} />
        <textarea aria-label="Feedback" className={feedbackCss.detail} />
        <button aria-label="Workflow member" className={workflowCss.memberButton}>
          <span data-member-ring className={workflowCss.memberLabelWrap}>
            <span className={workflowCss.memberLabel}>Member</span>
          </span>
        </button>
        <button aria-label="Elevated card" className={cardCss.card + ' ' + cardCss.copyable}
          style={{ position: 'relative' }}>Card</button>
        <button aria-label="Selected pill" aria-pressed="true" className={pillCss.pill + ' ' + pillCss.active}>Selected</button>
        <table className={trajectoryCss.table} data-scroll-ready="true"><tbody>
          <tr aria-label="Trajectory row" tabIndex={0}><td>Row</td></tr>
        </tbody></table>
        <button aria-label="Selected request" aria-pressed="true"
          className={trajectoryCss.requestBoundaryControl + ' ' + trajectoryCss.requestBoundaryControlActive}
          style={{ position: 'relative', width: 40, height: 30 }} />
      </main>
    }
    createRoot(document.getElementById('root')).render(<Fixture />)
  `
  const result = await build({
    configFile: false,
    root: join(REPO_ROOT, 'apps/web'),
    logLevel: 'error',
    plugins: [{
      name: 'focus-rings-fixture',
      resolveId(id) { if (id === entry) return entry },
      load(id) { if (id === entry) return code },
    }],
    esbuild: { jsx: 'automatic', jsxDev: false },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      write: false,
      minify: false,
      lib: { entry, name: 'FocusRingsFixture', formats: ['iife'] },
    },
  })
  if ('on' in result) throw new Error('expected an in-memory build, not a watcher')
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(bundle => bundle.output)
  return {
    script: outputs.flatMap(output => output.type === 'chunk' ? [output.code] : []).join('\n'),
    css: outputs.flatMap((output) => {
      if (output.type !== 'asset' || !output.fileName.endsWith('.css')) return []
      return [typeof output.source === 'string' ? output.source : new TextDecoder().decode(output.source)]
    }).join('\n'),
  }
}


/**
 * The painted ring's colour, style and width, plus its WCAG contrast against the surface the
 * ring sits on. A control that disables its outline reports `style: 'none'` and null contrast.
 */
async function ringReport(target: Locator) {
  return target.evaluate((element) => {
    const style = getComputedStyle(element)
    if (style.outlineStyle === 'none') return { color: null, style: style.outlineStyle, width: style.outlineWidth, offset: style.outlineOffset, contrast: null }
    const resolve = (value: string): { text: string; rgb: [number, number, number] } => {
      const probe = document.createElement('span')
      probe.style.color = value
      document.body.append(probe)
      const text = getComputedStyle(probe).color
      probe.remove()
      const parts = /([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(text)
      return { text, rgb: [Number(parts?.[1] ?? 0), Number(parts?.[2] ?? 0), Number(parts?.[3] ?? 0)] }
    }
    const ring = resolve(style.outlineColor)
    // The ring is painted outside the border box unless the offset is negative.
    const start = Number.parseFloat(style.outlineOffset) >= 0 ? element.parentElement : element
    let behind = null
    for (let node = start; node instanceof HTMLElement; node = node.parentElement) {
      const candidate = getComputedStyle(node).backgroundColor
      if (candidate && !/rgba\(0, 0, 0, 0\)/.test(candidate)) { behind = resolve(candidate); break }
    }
    if (behind === null) {
      return { color: ring.text, style: style.outlineStyle, width: style.outlineWidth, offset: style.outlineOffset, contrast: null }
    }
    const luminance = (rgb: [number, number, number]): number => {
      const channel = (value: number): number => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
    }
    const a = luminance(ring.rgb); const b = luminance(behind.rgb)
    return {
      color: ring.text, style: style.outlineStyle, width: style.outlineWidth, offset: style.outlineOffset,
      behind: behind.text,
      contrast: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100,
    }
  })
}

describe('source-compiled supplementary focus paint', () => {
  let fixture: Awaited<ReturnType<typeof compileFixture>>
  beforeAll(async () => { fixture = await compileFixture() })

  async function openFixture(): Promise<Page> {
    const browser = await chromium.launch({ headless: true })
    onTestFinished(() => browser.close())
    const page = await newEnglishPage(browser)
    const consoleWatch = watchConsole(page)
    onTestFinished(() => { expect(consoleWatch.pageErrors).toEqual([]) })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>')
    await page.addStyleTag({ content: fixture.css })
    await page.addScriptTag({ content: fixture.script })
    expect(consoleWatch.pageErrors).toEqual([])
    await page.getByRole('switch', { name: 'Toggle' }).waitFor()
    return page
  }

  it.each(['light', 'dark'])('keeps ancestor card rings silent after pointer input in %s mode', async (theme) => {
    const page = await openFixture()
    await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), theme === 'dark')
    const checkbox = page.getByRole('checkbox', { name: 'Onboarding purpose' })
    const card = page.locator('[data-onboarding-card]')
    await checkbox.click()
    await page.keyboard.press('Shift')
    expect((await paint(checkbox)).active).toBe(true)
    expect((await paint(card)).outlineStyle).toBe('none')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    const ring = await paint(card)
    expect((await paint(checkbox)).active).toBe(true)
    expect(ring.outlineStyle).toBe('solid')
    expect(ring.outline).toBe(ring.focusColor)
  })

  it('keeps Shift/Escape silent while Tab, Home, End and paging reveal a blue outline', async () => {
    const page = await openFixture()
    const toggle = page.getByRole('switch', { name: 'Toggle' })
    await toggle.click()
    for (const key of ['Shift', 'Escape']) {
      await page.keyboard.press(key)
      await expectSilent(toggle)
    }
    expect((await paint(toggle)).focusVisible).toBe(true)
    for (const key of ['Home', 'End', 'PageUp', 'PageDown']) {
      await toggle.click()
      await page.keyboard.press(key)
      await expectFocusRing(toggle, 'outline')
    }
    await toggle.click()
    await page.keyboard.press('Tab')
    const fallback = page.locator('#default-outline')
    const state = await paint(fallback)
    expect(state.active).toBe(true)
    expect(state.focusVisible).toBe(true)
    expect(state.outline).toBe(state.focusColor)
    expect(Number.parseFloat(state.outlineWidth)).toBeGreaterThan(0)
    await page.keyboard.press('Shift+Tab')
    await expectFocusRing(toggle, 'outline')
  })

  it.each(['Enter', 'Space'])('%s opens the real autoFocus Menu after a pointer-owned trigger', async (key) => {
    const page = await openFixture()
    const trigger = page.getByRole('button', { name: 'Open menu' })
    await trigger.click()
    await page.getByRole('menuitem', { name: 'First item' }).waitFor()
    await trigger.click()
    await page.getByRole('menu').waitFor({ state: 'hidden' })
    await expectSilent(trigger)
    await page.keyboard.press(key)
    const first = page.getByRole('menuitem', { name: 'First item' })
    await expect.poll(async () => (await paint(first)).active).toBe(true)
    const state = await paint(first)
    expect(state.modality).toBe('keyboard')
    expect(state.focusVisible).toBe(true)
    expect(state.background).toBe(state.hover)
    expect(state.background).not.toBe('rgba(0, 0, 0, 0)')
    await page.keyboard.press('Escape')
    await expectFocusRing(trigger, 'shadow')
  })

  it('negative control: blanket shadow suppression destroys input and card paint and misses descendants', async () => {
    const page = await openFixture()
    const input = page.getByRole('textbox', { name: 'Feedback' })
    const card = page.getByRole('button', { name: 'Elevated card' })
    const elevation = (await paint(card)).shadow
    await input.click()
    const focusedInput = await paint(input)
    expect(focusedInput.active).toBe(true)
    expect(focusedInput.shadow).toContain(focusedInput.focusColor)
    // Restore direct-colour fallback and the rejected global eraser only in this page.
    await page.addStyleTag({ content: `
      html[data-input-modality='pointer'] body :focus-visible {
        --dsw-focus-ring-color: initial !important;
        outline-color: transparent !important;
        box-shadow: none !important;
      }
    ` })
    expect((await paint(input)).shadow).toBe('none')
    await card.click()
    await page.keyboard.press('Shift')
    expect((await paint(card)).active).toBe(true)
    expect((await paint(card)).shadow).toBe('none')
    expect((await paint(card)).shadow).not.toBe(elevation)
    const member = page.getByRole('button', { name: 'Workflow member' })
    await member.click()
    await page.keyboard.press('Shift')
    expect((await paint(member)).active).toBe(true)
    const descendant = await paint(member.locator('[data-member-ring]'))
    expect(descendant.outlineStyle).toBe('solid')
    expect(descendant.outline).toBe(descendant.focusColor)
  })

  it('silences high-specificity table rings without hiding selected-state shadows', async () => {
    const page = await openFixture()
    const row = page.getByRole('row', { name: 'Trajectory row' })
    await row.click()
    await page.keyboard.press('Shift')
    await expectSilent(row)
    expect((await paint(row)).focusVisible).toBe(true)
    await page.keyboard.press('Home')
    await expectFocusRing(row, 'shadow')

    for (const [name, pseudo] of [['Selected pill', null], ['Selected request', '::before']] as const) {
      const selected = page.getByRole('button', { name })
      const shadow = (): Promise<string> => selected.evaluate((element, pseudo) => getComputedStyle(element, pseudo).boxShadow, pseudo)
      await selected.click()
      // The request marker animates its border; sample after its transition settles.
      await selected.evaluate(async (element) => {
        await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished))
      })
      const before = await shadow()
      expect(before).not.toBe('none')
      expect(before).not.toContain('rgba(0, 0, 0, 0)')
      await page.keyboard.press('Shift')
      expect(await selected.getAttribute('aria-pressed')).toBe('true')
      expect((await paint(selected)).active).toBe(true)
      await expect.poll(shadow).toBe(before)
    }
  })

  it('preserves clicked text-input paint and card elevation while suppressing descendant rings', async () => {
    const page = await openFixture()
    const input = page.getByRole('textbox', { name: 'Feedback' })
    await input.click()
    await page.keyboard.type('Still focused')
    await expect.poll(async () => {
      const state = await paint(input)
      return { active: state.active, visible: state.focusVisible, modality: state.modality, ring: state.shadow.includes(state.focusColor) }
    }).toEqual({ active: true, visible: true, modality: 'pointer', ring: true })

    const member = page.getByRole('button', { name: 'Workflow member' })
    const ring = member.locator('[data-member-ring]')
    await member.click()
    await page.keyboard.press('Shift')
    expect((await paint(member)).active).toBe(true)
    expect((await paint(member)).focusVisible).toBe(true)
    expect((await paint(ring)).outline).toBe('rgba(0, 0, 0, 0)')
    await page.keyboard.press('Home')
    const descendant = await paint(ring)
    expect((await paint(member)).active).toBe(true)
    expect(descendant.outline).toBe(descendant.focusColor)
    expect(descendant.outlineStyle).toBe('solid')
    expect(Number.parseFloat(descendant.outlineWidth)).toBeGreaterThan(0)

    const card = page.getByRole('button', { name: 'Elevated card' })
    const elevation = (await paint(card)).shadow
    expect(elevation).not.toBe('none')
    await card.click()
    await page.keyboard.press('Shift')
    await expectSilent(card)
    expect((await paint(card)).focusVisible).toBe(true)
    expect((await paint(card)).shadow).toBe(elevation)
    await page.keyboard.press('Home')
    await expectFocusRing(card, 'outline')
    expect((await paint(card)).shadow).toBe(elevation)
  })
  it('gives an undeclared ring the standard width and legible contrast in both themes', async () => {
    const page = await openFixture()
    const button = page.locator('#default-outline')
    await page.keyboard.press('Shift')
    await button.focus()
    const light = await ringReport(button)
    expect(light.style).not.toBe('none')
    expect(light.width).toBe('2px')
    expect(light.color).toBe('rgb(65, 118, 230)')
    expect(light.contrast).not.toBeNull()
    expect(light.contrast!).toBeGreaterThanOrEqual(3)

    await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', '') })
    await page.keyboard.press('Shift')
    await button.focus()
    const dark = await ringReport(button)
    expect(dark.width).toBe('2px')
    expect(dark.color).toBe('rgb(122, 170, 255)')
    expect(dark.contrast).not.toBeNull()
    expect(dark.contrast!).toBeGreaterThanOrEqual(3)

    // Naming the width must not create a ring where a control disables its outline.
    const disabled = page.locator('#outline-none')
    await page.keyboard.press('Shift')
    await disabled.focus()
    const none = await ringReport(disabled)
    expect(none.style).toBe('none')
    expect(none.contrast).toBeNull()
  })
})
