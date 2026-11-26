/**
 * A task that needs Feishu ends with the card of its official connector, which the profile does not hold. The card
 * installs the connector at the running DSH version, lists the install scripts pnpm blocked on the first run, allows
 * exactly those on the retry, and then leads to the connector's page, where its account is connected.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold, watchConsole,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const directory = fileURLToPath(new URL('../../../snapshots/web/connector-recommendations', import.meta.url))
const fixture = join(directory, 'session.v4.jsonl')
const FEISHU = '@deepseek-ai/dsh-feishu'
const CONNECTORS_TAB = '@deepseek-ai/dsh-client-ui-connectors'
/** The dependency whose install script pnpm leaves unrun until the profile allows it. */
const BLOCKED = '@larksuite/cli@1.0.97'

describe('official connector recommendation for a task that needs the app', () => {
  let root: string | undefined
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let profile: string
  let version: string
  let restoreCatalog: (() => void) | undefined

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'connector-recommendations-web-'))
    const overlay = join(root, 'cordis.patch.yml')
    await writeFile(overlay, `- id: plugin-manager\n  config: ${JSON.stringify({ pnpmCommand: process.execPath })}\n`)
    scaffold = await launchWebScaffold({ replayFixture: fixture, compareReplaySession: true, actionCards: true, extraOverlayPath: overlay })
    // The model-visible catalog lists the Connectors tab bundle and the connectors; other shipped plugins vary by Host.
    // Keep the real inventory read so the profile changes the card makes appear in what it lists.
    const listBundles = scaffold.ctx.pluginManager.listBundles.bind(scaffold.ctx.pluginManager)
    const catalog = vi.spyOn(scaffold.ctx.pluginManager, 'listBundles')
      .mockImplementation(async () => (await listBundles()).filter(bundle => bundle.name === CONNECTORS_TAB || bundle.name === FEISHU))
    restoreCatalog = () => { catalog.mockRestore() }
    version = (JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }).version
    // Node stands in for pnpm and runs the profile directory's file named after the subcommand: `config` names the
    // registry, `view` answers with the connector at the asked version, and `add` records its arguments, then, as pnpm
    // does, fails while the profile's pnpm settings leave the blocked install script undecided and installs the
    // connector once they allow it.
    profile = join(scaffold.harnessHome, 'profiles', 'scaffold')
    const connector = {
      'package.json': JSON.stringify({ name: FEISHU, version, type: 'module', main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
      'cordis.patch.yml': `- insert:\n    - id: feishu\n      name: '${FEISHU}'\n`,
      'index.js': 'export function apply() {}\n',
    }
    await writeFile(join(profile, 'config'), 'console.log("https://registry.npmjs.org/")\n')
    await writeFile(join(profile, 'view'), `console.log(${JSON.stringify(connector['package.json'])})\n`)
    await writeFile(join(profile, 'add'), String.raw`
      const fs = require('node:fs')
      const runs = fs.existsSync('.added') ? JSON.parse(fs.readFileSync('.added', 'utf8')) : []
      fs.writeFileSync('.added', JSON.stringify([...runs, process.argv.slice(2)]))
      const settings = fs.existsSync('pnpm-workspace.yaml') ? fs.readFileSync('pnpm-workspace.yaml', 'utf8') : ''
      if (!settings.split(/\r?\n/).some(line => line.includes(${JSON.stringify(BLOCKED)}) && /:\s*true\s*$/.test(line))) {
        console.error('[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: ' + ${JSON.stringify(BLOCKED)})
        process.exit(1)
      }
      fs.mkdirSync('node_modules/${FEISHU}', { recursive: true })
      for (const [file, text] of Object.entries(${JSON.stringify(connector)})) fs.writeFileSync('node_modules/${FEISHU}/' + file, text)
      const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'))
      fs.writeFileSync('package.json', JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, '${FEISHU}': '${version}' } }))
    `)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
  })

  afterAll(async () => {
    try { await browser?.close() } finally {
      try { await scaffold?.close() } finally {
        try { restoreCatalog?.() } finally { if (root !== undefined) await rm(root, { recursive: true, force: true }) }
      }
    }
  })

  it('installs the connector from the card, allows only the blocked scripts it lists, and opens its account page', async () => {
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const input = page.locator('[data-composer-input]').first()
    const settled = scaffold.whenTurnSettled()
    const prompts = fixtureUserPrompts(await readFile(fixture, 'utf8'))
    await input.fill(prompts[0]!)
    await input.press('Enter')
    await settled
    const card = page.locator('[data-turn-tail] [data-action-card][data-action="enable_official_plugin"]')
    await card.waitFor({ state: 'visible' })
    expect(await page.locator('[data-action-card]').count()).toBe(1)
    // The profile does not hold the connector, so the card shows the text copied from its package without a details target.
    await card.getByText('Use Feishu documents, messages, and other authorized features in conversations.', { exact: true }).waitFor()
    expect(await card.getByText('Lets me read the Feishu document you shared so I can summarize it.').count()).toBe(0)
    expect(await card.getByRole('button', { name: /^View details/ }).count()).toBe(0)
    const install = card.getByRole('button', { name: 'Install and enable', exact: true })
    expect(await install.isEnabled()).toBe(true)
    const listed = async (name: string) => (await scaffold.ctx.pluginManager.listBundles()).find(bundle => bundle.name === name)
    expect(await listed(FEISHU)).toBeUndefined()
    expect((await listed(CONNECTORS_TAB))?.enabled).toBe(false)
    await compareOrRefreshGolden(join(directory, 'offered.expected.md'), await captureStableAria(page, '[data-action-card]', scaffold.workspaceCwd), scaffold.mode)

    await install.click()
    const allow = card.getByRole('button', { name: 'Allow these scripts and retry', exact: true })
    await allow.waitFor({ timeout: 20_000 })
    expect(await card.getByRole('listitem').allInnerTexts()).toEqual([BLOCKED])
    expect(await listed(FEISHU)).toBeUndefined()
    // The Connectors tab bundle is switched on before the connector itself.
    expect((await listed(CONNECTORS_TAB))?.enabled).toBe(true)
    await compareOrRefreshGolden(join(directory, 'builds-blocked.expected.md'), await captureStableAria(page, '[data-action-card]', scaffold.workspaceCwd), scaffold.mode)

    await allow.click()
    const connect = card.getByRole('button', { name: 'Connect account', exact: true })
    await connect.waitFor({ timeout: 20_000 })
    await card.getByRole('status').getByText('Enabled', { exact: true }).waitFor()
    await compareOrRefreshGolden(join(directory, 'enabled.expected.md'), await captureStableAria(page, '[data-action-card]', scaffold.workspaceCwd), scaffold.mode)
    expect(await listed(FEISHU)).toMatchObject({ installed: true, enabled: true })
    // Both runs ask for the connector at the running DSH version, saved exactly; the retry allowed only the listed script.
    const runs = JSON.parse(await readFile(join(profile, '.added'), 'utf8')) as string[][]
    expect(runs.map(run => run.slice(0, 2))).toEqual([[`${FEISHU}@${version}`, '--save-exact'], [`${FEISHU}@${version}`, '--save-exact']])
    expect(await readFile(join(profile, 'pnpm-workspace.yaml'), 'utf8')).toMatch(/allowBuilds:\s+["']?@larksuite\/cli@1\.0\.97["']?: true\s*$/)

    await connect.click()
    await page.locator(`[data-plugin-detail="${FEISHU}"]`).waitFor({ state: 'visible' })
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    if (scaffold.mode === 'replay') await assertFixtureInventory(directory, [
      'session.v4.jsonl', 'offered.expected.md', 'builds-blocked.expected.md', 'enabled.expected.md',
      'system-prompt.expected.md', 'tool-schemas.expected.json',
    ])
  })
})
