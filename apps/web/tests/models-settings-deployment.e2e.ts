/**
 * A deployment's pi-ai provider rows on the assembled Models settings page. The profile patch holds a person's
 * providers in the `llm-pi-ai` row's `providers` dict; the home patch adds provider rows. The page lists the
 * rows as managed without editing them, and the person's own providers stay editable beside them. No model is
 * called: every step is settings, credentials, and LLM-directory traffic.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { openSettings, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/models-settings-deployment/managed.expected.md', import.meta.url))

// minimax-cn stands for a catalog provider that both files name, so that a developer's own OPENAI or ANTHROPIC
// environment key cannot change what the page shows.
const PROFILE_PATCH = [
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  '      minimax-cn:',
  '        apiKeyEnv: MINIMAX_CN_API_KEY',
  '      my-proxy:',
  '        displayName: My Proxy',
  '        api: openai-completions',
  '        baseURL: https://my-proxy.example/v1',
  '        models:',
  '          - id: my-model',
  '',
].join('\n')

const HOME_PATCH = [
  '- insert:',
  '    - id: llm-pi-ai-dsh-hub-minimax-cn',
  "      name: '@deepseek-ai/dsh-llm-pi-ai/provider'",
  '      config:',
  '        provider: minimax-cn',
  '        apiKeyEnv: HUB_MINIMAX_CN_API_KEY',
  '    - id: llm-pi-ai-dsh-hub-team-gateway',
  "      name: '@deepseek-ai/dsh-llm-pi-ai/provider'",
  '      config:',
  '        provider: team-gateway',
  '        displayName: Team Gateway',
  '        apiKeyEnv: HUB_TEAM_GATEWAY_API_KEY',
  '        api: openai-completions',
  '        baseURL: https://hub.example/v1',
  '        models:',
  '          - id: team-model',
  '',
].join('\n')

describe('web e2e: Models settings page beside a deployment\'s provider rows', () => {
  let home: string
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const profilePatchPath = (): string => join(home, 'profiles', 'scaffold', 'cordis.patch.yml')
  const homePatchPath = (): string => join(home, 'cordis.patch.yml')

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-models-deployment-'))
    await mkdir(join(home, 'profiles', 'scaffold'), { recursive: true })
    await writeFile(profilePatchPath(), PROFILE_PATCH)
    await writeFile(homePatchPath(), HOME_PATCH)
    scaffold = await launchWebScaffold({ harnessHome: home })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await openSettings(page, 'zh')
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.getByRole('button', { name: '模型', exact: true }).click()
    await dialog.getByRole('button', { name: '查看 Team Gateway (team-gateway)', exact: true }).waitFor()
  }, 120_000)

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      try {
        await scaffold?.close()
      } finally {
        if (home !== undefined) await rm(home, { recursive: true, force: true })
      }
    }
  })

  it('lists the deployment\'s providers as managed and opens them without an editable control', async () => {
    onTestFailed(() => saveFailureShot(page, 'models-settings-deployment'))
    const dialog = page.getByRole('dialog', { name: '设置' })
    // A provider row is viewed, never edited or deleted.
    for (const provider of ['Team Gateway (team-gateway)', 'minimax-cn']) {
      expect(await dialog.getByRole('button', { name: `查看 ${provider}`, exact: true }).count()).toBe(1)
      expect(await dialog.getByRole('button', { name: `编辑 ${provider}`, exact: true }).count()).toBe(0)
      expect(await dialog.getByRole('button', { name: `删除 ${provider}`, exact: true }).count()).toBe(0)
    }
    expect(await dialog.getByText('托管', { exact: true }).count()).toBe(2)
    // The person's own provider keeps both actions.
    expect(await dialog.getByRole('button', { name: '编辑 My Proxy (my-proxy)', exact: true }).count()).toBe(1)
    expect(await dialog.getByRole('button', { name: '删除 My Proxy (my-proxy)', exact: true }).count()).toBe(1)

    await dialog.getByRole('button', { name: '查看 Team Gateway (team-gateway)', exact: true }).click()
    await dialog.getByText('自定义设置', { exact: true }).click()
    const card = dialog.locator('li', { has: page.getByRole('button', { name: '查看 Team Gateway (team-gateway)', exact: true }) })
    const controls = card.locator('input, select, textarea')
    expect(await controls.count()).toBeGreaterThan(0)
    expect(await controls.evaluateAll(nodes => nodes.filter(node => !(node as HTMLInputElement).disabled).length)).toBe(0)
    expect(await card.getByRole('button', { name: '保存', exact: true }).isDisabled()).toBe(true)
    expect(await card.getByLabel('API 地址', { exact: true }).getAttribute('placeholder')).toBe('https://hub.example/v1')
    await compareOrRefreshGolden(EXPECTED, await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
    await card.getByRole('button', { name: '取消', exact: true }).click()
  })

  it('refuses a new provider under an ID the deployment uses', async () => {
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.getByRole('button', { name: '添加模型提供商', exact: true }).click()
    // The catalog mode offers no provider that is already configured, by either file.
    const offered = await dialog.getByLabel('提供商', { exact: true }).locator('option').evaluateAll(nodes => nodes.map(node => (node as HTMLOptionElement).value))
    expect(offered).not.toContain('minimax-cn')
    await dialog.getByRole('tab', { name: '自定义模型 API' }).click()
    await dialog.getByRole('textbox', { name: 'Provider ID', exact: true }).fill('team-gateway')
    await dialog.getByText('已有提供商使用了这个 ID。', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
  })

  it('edits the person\'s own provider in the dict of the profile patch and leaves the home patch as it is', async () => {
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.getByRole('button', { name: '编辑 My Proxy (my-proxy)', exact: true }).click()
    await dialog.getByText('自定义设置', { exact: true }).click()
    await dialog.getByLabel('API 地址', { exact: true }).fill('https://my-proxy.example/v2')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.getByText('已保存 My Proxy (my-proxy)。', { exact: true }).waitFor()
    const stored = await readFile(profilePatchPath(), 'utf8')
    expect(stored).toContain('baseURL: https://my-proxy.example/v2')
    // The write stays inside the dict: the profile patch gains no provider row.
    expect(stored).toContain('providers:')
    expect(stored).not.toContain('dsh-llm-pi-ai/provider')
    expect(await readFile(homePatchPath(), 'utf8')).toBe(HOME_PATCH)
    expect(await dialog.getByText('托管', { exact: true }).count()).toBe(2)
    expect(tripwire.pageErrors).toEqual([])
  })
})
