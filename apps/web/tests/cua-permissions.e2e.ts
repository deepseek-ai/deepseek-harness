/** Built permission UI talks to the real provider; the isolated helper substitutes only macOS privilege observations. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { chromium, type Browser } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'
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
  const launchApplication = { name: 'Visual Studio Code.app', path: '/Applications/Visual Studio Code.app',
    icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC' }
  await writeFile(state, JSON.stringify({ accessibility: false, screenRecording: false, launchApplication }))
  await writeFile(join(root, 'observe-helper'), '')
  const fixtureBundle = join(root, 'fixture-bundle')
  await mkdir(fixtureBundle)
  await writeFile(join(fixtureBundle, 'package.json'), JSON.stringify({ name: 'cua-permission-fixture', version: '1.0.0',
    dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  await writeFile(join(fixtureBundle, 'cordis.patch.yml'), `- id: cua\n  config: ${JSON.stringify({ helperPath: helper })}\n`)
  const scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: bundle, enabled: true }, { dir: fixtureBundle, enabled: true }] },
  })
  resources.scaffold = scaffold
  await scaffold.ctx.settings.mutate('cua', [{ op: 'set', path: ['allowedApps'],
    value: [{ id: 'a'.repeat(64), name: 'Fixture', executablePath: '/Applications/Fixture.app' }] }])
  const browser = await chromium.launch()
  resources.browser = browser
  const page = await newEnglishPage(browser), tripwire = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-cua-permissions'))
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const agent = scaffold.ctx.agents.list()[0]!
  await scaffold.ctx.agentPresets.select(agent, 'ptc')
  scaffold.ctx.approval.setPolicy(agent, 'never')
  await scaffold.ctx.settings.mutate('cua', [{ op: 'set', path: ['allowedApps'], value: [] }])
  // Application consent remains independent of the session's tool-approval policy.
  const grant = scaffold.ctx.tools.execute({ agent, signal: new AbortController().signal,
    callId: ToolCallId('cua-app-approval'), name: 'run_code',
    arguments: { code: 'return await tools.cua({ method: "getApp", params: { selector: "Fixture" } })',
      description: 'Request application access' } })
  const approval = page.locator('[data-question-key]')
  await Promise.race([approval.waitFor(), grant.then((result) => {
    throw new Error(`Application selection completed before consent: ${JSON.stringify(result)}`)
  })])
  expect(await approval.textContent()).toContain('Fixture')
  await approval.getByRole('radio', { name: 'Always allow', exact: true }).click()
  await approval.getByRole('button', { name: 'Submit', exact: true }).click()
  expect((await grant).isError).toBe(false)
  await approval.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  const card = page.locator('[data-plugin-package="@deepseek-ai/dsh-cua-bundle"]')
  expect(await card.getByRole('button', { name: /Accessibility permission|Screen Recording permission/ }).count()).toBe(0)
  await page.setViewportSize({ width: 1680, height: 600 })
  const plugins = page.locator('[data-plugin-panel]')
  const openDetails = page.getByRole('button', { name: 'View Computer Use', exact: true })
  await openDetails.scrollIntoViewIfNeeded()
  expect(await plugins.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await openDetails.click()
  const panel = page.locator('[data-cua-settings]')
  const accessibility = panel.getByRole('group', { name: 'Accessibility', exact: true })
  await accessibility.getByRole('button', { name: 'Request permission', exact: true }).waitFor()
  expect(await panel.getByRole('region', { name: 'Authorize Computer Use', exact: true }).getByRole('group').count()).toBe(4)
  expect(await panel.getByRole('region', { name: 'Manage applications Computer Use can access', exact: true }).count()).toBe(1)
  await expect.poll(() => panel.locator('li img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1)
  expect(await panel.getByText('/fixture/app', { exact: true }).count()).toBe(0)
  expect(await accessibility.getByText('Visual Studio Code.app', { exact: true }).count()).toBe(1)
  expect(await accessibility.textContent()).toContain('In System Settings, allow')
  expect(await accessibility.textContent()).toContain('to read interface controls, click, and type.')
  expect(await panel.getByRole('group', { name: 'Screen Recording', exact: true }).getByText('Visual Studio Code.app', { exact: true }).count()).toBe(1)
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
  expect(saved).toContain('allowedApps: []')
  const events = (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { event: string; method: string; params: object })
    .filter(record => record.event === 'call').map(({ method, params }) => ({ method, params }))
  expect(events).toContainEqual({ method: 'requestPermission', params: { permission: 'accessibility' } })
  expect(events.filter(event => event.method === 'openPermissionSettings')).toEqual([
    { method: 'openPermissionSettings', params: { permission: 'accessibility' } },
  ])
  expect(events.every(event => ['permissionStatus', 'requestPermission', 'openPermissionSettings', 'applicationIcons', 'getApp'].includes(event.method))).toBe(true)
  expect(tripwire.pageErrors).toEqual([])
}, 60_000)
