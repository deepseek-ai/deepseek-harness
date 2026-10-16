// Web e2e scenario: switching a plugin on the Plugins page updates the `/`
// menu of a Session that is already open. One chromium page holds a blank
// Session while a second page switches the official badge skill bundle; a
// global skill seeded in the harness home stays listed throughout. No model
// call is issued, so a stray stream fails loud on the open LLM seam.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, PLUGIN_TOGGLE_SETTLE_MS, saveFailureShot, writeComposerDraft } from './support.ts'

const BUNDLE_DIR = fileURLToPath(new URL('../../../packages/experimental/badge-skill-bundle', import.meta.url))
const BUNDLE = '@deepseek-ai/dsh-experimental-badge-skill-bundle'
const GLOBAL_SKILL = 'dsh-global-skill'

describe('web e2e: the slash menu follows plugin switches', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let plugins: Page
  let toggle: Locator
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ profile: { packages: [{ dir: BUNDLE_DIR }] } })
    // The scaffold pins the skill-filesystem harness home inside its temporary world.
    const directory = join(scaffold.workspaceCwd, '.dsh-home', 'skills', GLOBAL_SKILL)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), [
      '---',
      `name: ${GLOBAL_SKILL}`,
      'description: Listed whichever plugins are switched on',
      '---',
      '',
      `# ${GLOBAL_SKILL}`,
      '',
    ].join('\n'))
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    plugins = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await plugins.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await plugins.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: 'Plugins', exact: true }).click()
    const panel = plugins.locator('[data-plugin-panel]')
    await panel.getByRole('button', { name: 'More', exact: true }).click()
    toggle = panel.locator(`[data-plugin-package="${BUNDLE}"]`).getByRole('switch')
    await toggle.waitFor({ timeout: 10_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  /**
   * Retype the query in the open Session and read whether the badge skill is listed.
   * @returns whether the menu lists `dsh-badge` beside the global skill.
   */
  async function badgeListed(): Promise<boolean> {
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), '/dsh-')
    const menu = page.getByRole('listbox', { name: 'Trigger suggestions' })
    // The skill source answers with one list, so the global entry marks a settled skill group.
    await menu.getByRole('option', { name: new RegExp(`^${GLOBAL_SKILL} `) }).waitFor({ timeout: 10_000 })
    return await menu.getByRole('option', { name: /^dsh-badge / }).count() === 1
  }

  /**
   * Switch the badge bundle on the second page and wait for the switch to settle.
   * @param enabled - the requested bundle state.
   */
  async function switchBundle(enabled: boolean): Promise<void> {
    expect(await toggle.getAttribute('aria-checked')).toBe(String(!enabled))
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toBe(String(enabled))
  }

  it('lists a switched bundle\'s skill only while the bundle is on, keeping the global skill', async () => {
    onTestFailed(async () => {
      await saveFailureShot(page, 'web-e2e-skill-menu-plugin-change')
      await saveFailureShot(plugins, 'web-e2e-skill-menu-plugin-change-plugins')
    })
    // The open Session cached its catalog while the bundle was off.
    expect(await badgeListed()).toBe(false)

    // Each switch re-reads the catalog of the Session that stayed open.
    for (const enabled of [true, false, true]) {
      await switchBundle(enabled)
      await expect.poll(badgeListed, { timeout: 10_000 }).toBe(enabled)
    }
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
