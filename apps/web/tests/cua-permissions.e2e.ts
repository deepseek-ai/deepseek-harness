/** Built permission UI talks to the real provider; the isolated helper substitutes only macOS privilege observations. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { chromium, type Browser } from 'playwright'
import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, PLUGIN_TOGGLE_SETTLE_MS, saveFailureShot } from './support.ts'
import { installNativeFixture, startFixtureHost } from '../../../packages/experimental/cua-macos/tests/native-fixture.ts'

const bundle = fileURLToPath(new URL('../../../packages/experimental/cua-bundle', import.meta.url))
const expected = fileURLToPath(new URL('./expected/cua-permissions/missing.expected.md', import.meta.url))

// System-permission onboarding belongs to the macOS-only bundle; rendering and policy units remain portable.
it.skipIf(process.platform !== 'darwin')('keeps system requests pending until fresh observation and persists application revocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cua-permissions-web-'))
  const resources: { scaffold?: WebScaffold; browser?: Browser; closeFixture?: () => Promise<void> } = {}
  onTestFinished(async () => {
    try { await resources.browser?.close() } finally {
      try { await resources.scaffold?.close() } finally {
        try { await resources.closeFixture?.() } finally { await rm(root, { recursive: true, force: true }) }
      }
    }
  })
  const helper = await installNativeFixture(root)
  resources.closeFixture = await startFixtureHost(helper)
  const state = join(root, 'permissions.json'), audit = join(root, 'helper-events.jsonl')
  const launchApplication = { name: 'DSH Computer Use.app', path: '/Applications/DSH Computer Use.app',
    icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC' }
  await writeFile(state, JSON.stringify({ accessibility: false, screenRecording: false, launchApplication }))
  await writeFile(join(root, 'observe-helper'), '')
  const fixturePatch = join(root, 'native-fixture.yml')
  // Keep the external helper override above bundle order changes when CUA is re-enabled.
  await writeFile(fixturePatch, JSON.stringify([{ id: 'cua', config: { helperPath: helper } }]))
  const scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: bundle, enabled: true }] },
    extraOverlayPath: fixturePatch,
  })
  resources.scaffold = scaffold
  expect((await scaffold.ctx.pluginManager.listBundles()).find(bundle => bundle.name === '@deepseek-ai/dsh-cua-bundle'))
    .toMatchObject({ listedByDefault: false, enabled: true, installed: true })
  const browser = await chromium.launch()
  resources.browser = browser
  const page = await newEnglishPage(browser), tripwire = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-cua-permissions'))
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const agent = scaffold.ctx.agents.list()[0]!
  await scaffold.ctx.agentPresets.select(agent, 'ptc')
  scaffold.ctx.approval.setPolicy(agent, 'never')
  // Application consent remains independent of the session's tool-approval policy.
  const grant = scaffold.ctx.tools.execute({ agent, signal: new AbortController().signal,
    calls: [{ type: 'tool-call', id: ToolCallId('cua-app-approval'), name: 'run_code',
      arguments: JSON.stringify({ code: 'return await tools.cua({ method: "getApp", params: { selector: "Fixture" } })',
        description: 'Request application access' }) }] })
  const approval = page.locator('[data-approval-key]')
  await Promise.race([approval.waitFor(), grant.then((result) => {
    throw new Error(`Application selection completed before consent: ${JSON.stringify(result)}`)
  })])
  expect(await approval.getByText('Fixture', { exact: true }).count()).toBe(1)
  expect(await approval.getByRole('textbox').count()).toBe(0)
  expect(await approval.locator('[data-approval-scroll]').evaluate(element => getComputedStyle(element).textAlign)).toBe('left')
  expect(await approval.getByRole('button', { name: 'Always allow', exact: true })
    .evaluate(button => getComputedStyle(button.parentElement!).flexWrap)).toBe('wrap')
  await expect.poll(() => approval.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1)
  expect(await approval.getByText('/Applications/Fixture.app', { exact: true }).count()).toBe(0)
  await compareOrRefreshGolden(fileURLToPath(new URL('./expected/cua-permissions/application-approval.expected.md', import.meta.url)),
    await captureStableAria(page, '[data-approval-key]', scaffold.workspaceCwd), webSnapshotMode())
  await approval.getByRole('button', { name: 'Always allow', exact: true }).click()
  expect((await grant).results).toMatchObject([{ result: { isError: false } }])
  await approval.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  const card = page.locator('[data-plugin-package="@deepseek-ai/dsh-cua-bundle"]')
  expect(await card.getByRole('button', { name: /Accessibility permission|Screen Recording permission/ }).count()).toBe(0)
  await page.setViewportSize({ width: 1680, height: 600 })
  const plugins = page.locator('[data-plugin-panel]')
  const openDetails = page.getByRole('button', { name: 'View Computer use', exact: true })
  await openDetails.scrollIntoViewIfNeeded()
  expect(await plugins.locator('[data-plugin-body]').evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await openDetails.click()
  const panel = page.locator('[data-cua-settings]')
  const accessibility = panel.getByRole('group', { name: 'Accessibility', exact: true })
  await accessibility.getByRole('button', { name: 'Request permission', exact: true }).waitFor()
  expect(await panel.getByRole('region', { name: 'Authorize computer use', exact: true }).getByRole('group').count()).toBe(4)
  expect(await panel.getByRole('region', { name: 'Manage applications computer use can access', exact: true }).count()).toBe(1)
  await expect.poll(() => panel.locator('li img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1)
  expect(await panel.getByText('/fixture/app', { exact: true }).count()).toBe(0)
  expect(await accessibility.getByText('DSH Computer Use.app', { exact: true }).count()).toBe(1)
  expect(await accessibility.textContent()).toContain('In System Settings, allow')
  expect(await accessibility.textContent()).toContain('to read interface controls, click, and type.')
  expect(await panel.getByRole('group', { name: 'Screen Recording', exact: true }).getByText('DSH Computer Use.app', { exact: true }).count()).toBe(1)
  await expect.poll(() => accessibility.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1)
  await expect.poll(() => panel.getAttribute('aria-busy')).toBe('false')
  await compareOrRefreshGolden(expected, await captureStableAria(page, '[data-cua-settings]', scaffold.workspaceCwd), webSnapshotMode())
  try {
    for (const width of [1680, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(colorScheme === 'dark')
        const measure = () => panel.evaluate(element => ({
          clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
          overflowing: [...element.querySelectorAll('*')].filter(child =>
            child.getBoundingClientRect().right > element.getBoundingClientRect().right + 1,
          ).map(child => ({ tag: child.tagName, className: child.className, text: child.textContent?.slice(0, 80) })),
        }))
        await expect.poll(async () => {
          const layout = await measure()
          return layout.scrollWidth <= layout.clientWidth ? true : { width, colorScheme, ...layout }
        }).toBe(true)
        if (webSnapshotMode() === 'refresh') {
          const directory = fileURLToPath(new URL('../../../.artifacts', import.meta.url))
          await mkdir(directory, { recursive: true })
          const path = join(directory, `cua-permission-design-${process.pid}-${width}-${colorScheme}.png`)
          await panel.screenshot({ path, animations: 'disabled' })
          console.log(`CUA permission design: ${path}`)
        }
      }
    }
  } finally {
    await page.emulateMedia({ colorScheme: null })
    await page.setViewportSize({ width: 1680, height: 1000 })
  }
  await accessibility.getByRole('button', { name: 'Request permission', exact: true }).click()
  await expect.poll(() => panel.getAttribute('aria-busy')).toBe('false')
  expect(await accessibility.getByRole('button', { name: 'Request permission', exact: true }).count()).toBe(1)
  await writeFile(state, JSON.stringify({ accessibility: true, screenRecording: false, launchApplication }))
  // Headless pages retain document focus; model returning from System Settings at the window-event boundary.
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')) })
  await accessibility.getByText('Allowed', { exact: true }).waitFor()
  const screen = panel.getByRole('group', { name: 'Screen Recording', exact: true })
  expect(await accessibility.getByRole('button').count()).toBe(1)
  await accessibility.getByRole('button', { name: 'Allowed', exact: true }).click()
  expect(await screen.getByRole('button').count()).toBe(1)
  await expect.poll(() => panel.getAttribute('aria-busy')).toBe('false')
  await panel.getByRole('button', { name: 'Revoke', exact: true }).click()
  await panel.getByRole('heading', { name: 'Always-allowed applications', exact: true }).waitFor({ state: 'hidden' })
  await panel.getByRole('heading', { name: 'Applications not allowed', exact: true }).waitFor()
  await panel.getByRole('button', { name: 'Allow asking again', exact: true }).click()
  await panel.getByText('Fixture', { exact: true }).waitFor({ state: 'hidden' })
  const saved = await readFile(join(scaffold.harnessHome, 'profiles/scaffold/cordis.patch.yml'), 'utf8')
  expect(saved).not.toContain('allowedApps:')
  const files = await readdir(join(scaffold.workspaceCwd, '.dsh-storages'))
  expect(files.some(file => file.startsWith('cua_permissions_') && file.endsWith('.json'))).toBe(true)
  expect((await scaffold.ctx.cuaAccess.applications()).allowedApps).toEqual([])
  const events = (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { event: string; method: string; params: object })
    .filter(record => record.event === 'call').map(({ method, params }) => ({ method, params }))
  expect(events).toContainEqual({ method: 'requestPermission', params: { permission: 'accessibility' } })
  expect(events.filter(event => event.method === 'openPermissionSettings')).toEqual([
    { method: 'openPermissionSettings', params: { permission: 'accessibility' } },
  ])
  expect(events.every(event => ['permissionStatus', 'requestPermission', 'openPermissionSettings', 'applicationIcons', 'getApp'].includes(event.method))).toBe(true)
  const preview = plugins.locator('[data-detail-document] img')
  await preview.waitFor()
  await preview.evaluate(async (image: HTMLImageElement) => { await image.decode() })
  const trace = await page.evaluateHandle(() => {
    const errors: string[] = []
    const stable = [...document.querySelectorAll('[data-cua-settings] [role="alert"]')].map(node => node.textContent?.trim())
    const layouts: { height: number; sections: number[]; groups: number[] }[] = []
    const documents: number[] = []
    let frame = 0
    const measure = () => {
      const documentHeight = document.querySelector('[data-plugin-detail] [data-detail-document]')?.getBoundingClientRect().height ?? 0
      if (documents.at(-1) !== documentHeight) documents.push(documentHeight)
      const settings = document.querySelector('[data-cua-settings]')
      if (settings) {
        const height = settings.getBoundingClientRect().height
        if (layouts.at(-1)?.height !== height) layouts.push({ height,
          sections: [...settings.querySelectorAll('section')].map(node => node.getBoundingClientRect().height),
          groups: [...settings.querySelectorAll('[role="group"]')].map(node => node.getBoundingClientRect().height),
        })
      }
      frame = requestAnimationFrame(measure)
    }
    measure()
    const observer = new MutationObserver(() => {
      for (const node of document.querySelectorAll('[data-cua-settings] [role="alert"]')) {
        const text = node.textContent?.trim()
        if (text && !stable.includes(text) && errors.at(-1) !== text) errors.push(text)
      }
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    return { errors, layouts, documents, stop: () => { observer.disconnect(); cancelAnimationFrame(frame) } }
  })
  try {
    const toggle = page.locator('[data-plugin-panel]').getByRole('switch', { name: 'Enable Computer use', exact: true })
    for (const width of [1680, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      if (width === 390) await page.locator('[data-sidebar-collapsed]').waitFor({ state: 'attached' })
      await page.locator('[data-animating]').waitFor({ state: 'hidden' })
      await trace.evaluate((value) => { value.layouts.length = 0; value.documents.length = 0 })
      for (let cycle = 0; cycle < 3; cycle++) {
        await toggle.click()
        await expect.poll(async () => (await scaffold.ctx.pluginManager.listBundles())
          .find(bundle => bundle.name === '@deepseek-ai/dsh-cua-bundle'))
          .toMatchObject({ enabled: false, installed: true })
        await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toBe('false')
        await expect.poll(() => toggle.isEnabled(), { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toBe(true)
        await toggle.click()
        await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toBe('true')
        const setup = page.getByRole('dialog', { name: 'Set up computer use before use', exact: true })
        await setup.getByRole('button', { name: 'Later', exact: true }).click()
        await expect.poll(() => panel.getAttribute('aria-busy'), { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toBe('false')
        expect(await trace.evaluate(value => value.errors)).toEqual([])
      }
      const layouts = await trace.evaluate(value => value.layouts)
      expect(layouts.length).toBeGreaterThan(0)
      const documentHeights = await trace.evaluate(value => value.documents)
      expect(documentHeights.length).toBeGreaterThan(0)
      expect(Math.max(...documentHeights) - Math.min(...documentHeights)).toBeLessThanOrEqual(1)
      const heights = layouts.map(layout => layout.height)
      expect(Math.max(...heights) - Math.min(...heights), JSON.stringify(layouts)).toBeLessThanOrEqual(1)
    }
  } finally {
    await trace.evaluate((value) => { value.stop() })
    await trace.dispose()
  }
  await writeFile(state, JSON.stringify({ accessibility: 'unavailable', screenRecording: false }))
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')) })
  const diagnostic = panel.getByRole('alert')
  await diagnostic.waitFor()
  const diagnosticText = await diagnostic.innerText()
  const height = await panel.evaluate(element => element.getBoundingClientRect().height)
  const rowToggle = plugins.getByRole('switch', { name: 'Enable component macOS Computer Use provider', exact: true })
  const release = Promise.withResolvers<undefined>()
  const changeRow = scaffold.ctx.pluginManager.setPluginEnabled.bind(scaffold.ctx.pluginManager)
  let changing: ReturnType<typeof changeRow> | undefined
  const hold = vi.spyOn(scaffold.ctx.pluginManager, 'setPluginEnabled').mockImplementationOnce((entryId, enabled) => {
    changing = release.promise.then(() => changeRow(entryId, enabled))
    return changing
  })
  try {
    await rowToggle.click()
    await expect.poll(() => hold.mock.calls.length, { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toBe(1)
    await expect.poll(() => panel.getAttribute('aria-busy')).toBe('true')
    expect(await diagnostic.innerText()).toBe(diagnosticText)
    expect(await diagnostic.getByRole('button', { name: 'Retry', exact: true }).isEnabled()).toBe(false)
    expect(await panel.evaluate(element => element.getBoundingClientRect().height)).toBe(height)
  } finally {
    release.resolve(undefined)
    hold.mockRestore()
    await changing
  }
  await expect.poll(() => rowToggle.getAttribute('aria-checked'), { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toBe('false')
  await expect.poll(() => rowToggle.isEnabled(), { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toBe(true)
  await writeFile(state, JSON.stringify({ accessibility: false, screenRecording: false, launchApplication }))
  await rowToggle.click()
  await expect.poll(() => rowToggle.getAttribute('aria-checked'), { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toBe('true')
  await expect.poll(() => panel.getAttribute('aria-busy'), { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toBe('false')
  await diagnostic.waitFor({ state: 'hidden' })
  expect(tripwire.pageErrors).toEqual([])
})
