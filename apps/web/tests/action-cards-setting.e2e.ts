/** The General settings switch and the Agent's origin control the card skills on real HTTP requests. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import yaml from 'js-yaml'
import { expect, it, onTestFinished } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, openSettings } from './support.ts'

const CARD_SKILLS = ['official-plugins', 'personalized-pages']

interface ContentBlock {
  readonly type: string
  readonly text?: string
  readonly content?: string | readonly ContentBlock[]
}

interface RequestBody {
  readonly tools: readonly { readonly name: string }[]
  readonly messages: readonly { readonly content: string | readonly ContentBlock[] }[]
}

/** Names of the tools one request declares. */
function declaredTools(body: unknown): readonly string[] {
  return (body as RequestBody).tools.map(tool => tool.name)
}

/** Text of one content block, including the text a tool result carries. */
function blockTexts(block: ContentBlock): readonly string[] {
  const nested = block.content === undefined ? [] : typeof block.content === 'string' ? [block.content] : block.content.flatMap(blockTexts)
  return [block.text ?? '', ...nested]
}

/** Text blocks of one request's messages. */
function requestTexts(body: unknown): readonly string[] {
  return (body as RequestBody).messages
    .flatMap(message => typeof message.content === 'string' ? [message.content] : message.content.flatMap(blockTexts))
}

/** Card skills in the newest skill catalog of one request. */
function catalogCardSkills(body: unknown): readonly string[] {
  const catalogs = requestTexts(body).filter(text => text.includes('<available_skills>'))
  return CARD_SKILLS.filter(name => catalogs.at(-1)!.includes(name))
}

/**
 * Open the shipped Web client on a mock model server; every resource ends with the test.
 * @param server - the mock model endpoint.
 * @returns the scaffold, the page and a sender that resolves when the turn settles.
 */
async function openClient(server: MockLlmServer) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-card-switch-browser-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const key = credentialRef('DSH_CARD_SWITCH_BROWSER_KEY')
  const overlay = join(root, 'cards.yml')
  await writeFile(overlay, JSON.stringify([
    { id: 'llm-deepseek', config: { baseURL: server.baseURL, apiKeyEnv: key } },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
  ]))
  const scaffold = await launchWebScaffold({ deepSeekMissingCredential: true, extraOverlayPath: overlay, actionCards: true })
  onTestFinished(() => scaffold.close())
  await scaffold.ctx.credentials.set(key, 'card-switch-browser-test-key')
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const input = page.locator('[data-composer-input]').first()
  const send = async (text: string) => {
    const settled = scaffold.whenTurnSettled()
    await input.fill(text)
    await input.press('Enter')
    return settled
  }
  return { scaffold, page, send }
}

it.skipIf(webSnapshotMode() === 'record')('persists the card switch, and later requests drop or restore the card skills', async () => {
  const server = await startMockLlmServer({
    sequence: ['success', 'tool_call_success', 'success', 'success'], successText: 'CARD_SWITCH_DONE',
    toolName: 'skill', toolArguments: JSON.stringify({ name: 'personalized-pages' }),
  })
  onTestFinished(() => server.close())
  const { scaffold, page, send } = await openClient(server)
  const toggle = page.getByRole('switch', { name: 'Personalized recommendations' })
  const setCards = async (enabled: boolean) => {
    await openSettings(page, 'en')
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe(String(!enabled))
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe(String(enabled))
    await expect.poll(async () => {
      const patches = yaml.load(await readFile(join(scaffold.harnessHome, 'profiles/scaffold/cordis.patch.yml'), 'utf8')) as { id: string; config?: { enabled?: boolean } }[]
      return patches.find(patch => patch.id === 'action-cards')?.config?.enabled ?? true
    }).toBe(enabled)
    await page.keyboard.press('Escape')
  }

  const sessionId = await send('cards-on-marker')
  expect(server.requests).toHaveLength(1)
  expect(catalogCardSkills(server.requests[0]!.body)).toEqual(CARD_SKILLS)
  expect(declaredTools(server.requests[0]!.body)).toContain('skill')

  await setCards(false)
  await page.reload()
  await openSettings(page, 'en')
  await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false')
  await page.keyboard.press('Escape')
  // The model still asks for a card skill by name; the registry no longer resolves it.
  expect(await send('cards-off-marker')).toBe(sessionId)
  expect(server.requests).toHaveLength(3)
  expect(catalogCardSkills(server.requests[1]!.body)).toEqual([])
  expect(requestTexts(server.requests[2]!.body).some(text => text.includes('skill "personalized-pages" is unknown or no longer available'))).toBe(true)

  await setCards(true)
  expect(await send('cards-resumed-marker')).toBe(sessionId)
  expect(server.requests).toHaveLength(4)
  expect(catalogCardSkills(server.requests[3]!.body)).toEqual(CARD_SKILLS)
  expect(server.requests.map(request => request.outcome)).toEqual(['completed', 'completed', 'completed', 'completed'])
})
