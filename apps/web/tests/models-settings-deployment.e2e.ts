/**
 * A deployment's pi-ai provider rows on the assembled Models settings page. The profile patch holds a person's
 * providers in the `llm-pi-ai` row's `providers` dict; the home patch adds provider rows, whose keys the
 * deployment supplies through the environment. The page lists the rows' routes without a delete control and
 * opens them as pi-ai routes with the config they run with; a typed key is stored for the row, a changed field
 * is refused by the Host, and the person's own providers stay editable beside them. No model is called: every
 * step is settings, credentials, and LLM-directory traffic.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { openSettings, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

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
  const teamGateway = () => {
    const dialog = page.getByRole('dialog', { name: '设置' })
    const edit = page.getByRole('button', { name: '编辑 Team Gateway (team-gateway)', exact: true })
    // Found by the row's name: a row whose editor is open shows no Edit button.
    return { dialog, edit, card: dialog.locator('li').filter({ has: page.getByText('Team Gateway', { exact: true }) }) }
  }

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-models-deployment-'))
    await mkdir(join(home, 'profiles', 'scaffold'), { recursive: true })
    await writeFile(profilePatchPath(), PROFILE_PATCH)
    await writeFile(homePatchPath(), HOME_PATCH)
    vi.stubEnv('HUB_MINIMAX_CN_API_KEY', 'models-deployment-test-key')
    vi.stubEnv('HUB_TEAM_GATEWAY_API_KEY', 'models-deployment-test-key')
    scaffold = await launchWebScaffold({ harnessHome: home })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await openSettings(page, 'zh')
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.getByRole('button', { name: '模型', exact: true }).click()
    await dialog.getByRole('button', { name: '编辑 Team Gateway (team-gateway)', exact: true }).waitFor()
  }, 120_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
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

  it('lists the deployment\'s providers without a delete control and opens them with the config they run with', async () => {
    onTestFailed(() => saveFailureShot(page, 'models-settings-deployment'))
    const { dialog, edit, card } = teamGateway()
    // A provider row is the deployment's: the page offers no deletion for it.
    for (const provider of ['Team Gateway (team-gateway)', 'minimax-cn']) {
      expect(await dialog.getByRole('button', { name: `编辑 ${provider}`, exact: true }).count()).toBe(1)
      expect(await dialog.getByRole('button', { name: `删除 ${provider}`, exact: true }).count()).toBe(0)
    }
    // The person's own provider keeps both actions.
    expect(await dialog.getByRole('button', { name: '编辑 My Proxy (my-proxy)', exact: true }).count()).toBe(1)
    expect(await dialog.getByRole('button', { name: '删除 My Proxy (my-proxy)', exact: true }).count()).toBe(1)

    // The row's form is a pi-ai profile, so its card is the pi-ai card, filled from the home patch.
    await edit.click()
    await card.getByText('已检测到环境变量（HUB_TEAM_GATEWAY_API_KEY）', { exact: true }).waitFor()
    await card.getByRole('button', { name: '高级设置', exact: true }).click()
    await card.getByRole('button', { name: '模型选项 1', exact: true }).click()
    expect(await card.getByLabel('显示名称', { exact: true }).first().getAttribute('placeholder')).toBe('Team Gateway')
    expect(await card.getByLabel('API 地址', { exact: true }).getAttribute('placeholder')).toBe('https://hub.example/v1')
    expect(await card.getByLabel('API 协议', { exact: true }).inputValue()).toBe('openai-completions')
    expect(await card.getByLabel('模型 ID 1', { exact: true }).inputValue()).toBe('team-model')
    await card.getByRole('button', { name: '取消', exact: true }).click()
  })

  it('stores a key typed for a deployment\'s provider and leaves both patch files as they are', async () => {
    const { dialog, edit, card } = teamGateway()
    const profilePatch = await readFile(profilePatchPath(), 'utf8')
    await edit.click()
    await card.getByLabel('API 密钥', { exact: true }).fill('sk-e2e-team-gateway')
    await card.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.getByText('已保存 Team Gateway (team-gateway)。', { exact: true }).waitFor()
    // The key goes to the credential store under the reference the row names; no settings write is made.
    expect(await readFile(join(home, '.credentials.yaml'), 'utf8')).toContain('HUB_TEAM_GATEWAY_API_KEY: sk-e2e-team-gateway')
    expect(await readFile(homePatchPath(), 'utf8')).toBe(HOME_PATCH)
    expect(await readFile(profilePatchPath(), 'utf8')).toBe(profilePatch)
  })

  it('shows the Host\'s refusal when a field of a row that the home patch adds is changed', async () => {
    const { edit, card } = teamGateway()
    const profilePatch = await readFile(profilePatchPath(), 'utf8')
    await edit.click()
    await card.getByRole('button', { name: '高级设置', exact: true }).click()
    await card.getByLabel('API 地址', { exact: true }).fill('https://hub.example/v2')
    await card.getByRole('button', { name: '保存', exact: true }).click()
    await card.getByText('Configuration for "llm-pi-ai-dsh-hub-team-gateway" is overridden by a home patch or command-line overlay', { exact: true }).waitFor()
    expect(await readFile(homePatchPath(), 'utf8')).toBe(HOME_PATCH)
    expect(await readFile(profilePatchPath(), 'utf8')).toBe(profilePatch)
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
    await dialog.getByRole('button', { name: '高级设置', exact: true }).click()
    await dialog.getByLabel('API 地址', { exact: true }).fill('https://my-proxy.example/v2')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.getByText('已保存 My Proxy (my-proxy)。', { exact: true }).waitFor()
    const stored = await readFile(profilePatchPath(), 'utf8')
    expect(stored).toContain('baseURL: https://my-proxy.example/v2')
    // The write stays inside the dict: the profile patch gains no provider row.
    expect(stored).toContain('providers:')
    expect(stored).not.toContain('dsh-llm-pi-ai/provider')
    expect(await readFile(homePatchPath(), 'utf8')).toBe(HOME_PATCH)
    expect(await dialog.getByRole('button', { name: '编辑 Team Gateway (team-gateway)', exact: true }).count()).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
  })
})
