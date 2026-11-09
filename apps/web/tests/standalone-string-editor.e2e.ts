/** A standalone global tool from a custom Host patch reaches the PTC SDK and a persisted Session. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type {} from '@deepseek-ai/dsh-tools'
import {
  assertFinalWorkspaceSnapshot, assertFixtureInventory, captureExpandedTurnProcessAria, compareOrRefreshGolden,
  fixtureUserPrompts, launchWebScaffold, recordFixture, selectedSessionFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const DIR = fileURLToPath(new URL('../../../snapshots/web/optional-string-editor', import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')
const MODE = webSnapshotMode()

describe('web snapshot: standalone string editor through PTC', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      developerTools: true,
      extraOverlayPath: [
        fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
        fileURLToPath(new URL('./standalone-string-editor.overlay.yml', import.meta.url)),
      ],
      profile: { packages: [] },
      compareReplaySession: true,
      ...(MODE === 'record' ? {} : { replayFixture: FIXTURE }),
    })
    expect(scaffold.ctx.tools.schemas().some(tool => tool.name === 'str_replace_editor')).toBe(true)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await page.getByRole('button', { name: 'Standard mode', exact: true }).click()
    await page.getByRole('menuitem', { name: /^PTC mode/ }).click()
    await page.getByRole('button', { name: 'PTC mode', exact: true }).waitFor({ state: 'visible' })
  })

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('executes the explicitly composed SDK tool, persists its subcall, and verifies the created file', async () => {
    onTestFailed(() => saveFailureShot(page, 'optional-string-editor'))
    const prompts = fixtureUserPrompts(await readFile(await selectedSessionFixture(FIXTURE), 'utf8'))
    expect(prompts).toHaveLength(1)
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(prompts[0]!)
    await input.press('Enter')
    const sessionId = await settled
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('Standalone editor Session has no live Agent')
    expect(scaffold.ctx.agentPresets.composedPreset(agent.ctx)).toBe('ptc')
    expect(agent.session.requestHeader()?.tools?.map(tool => tool.name)).toEqual(['run_code'])
    const system = agent.session.deriveMessages().filter(message => message.role === 'system')
      .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
    expect(system).toContain('str_replace_editor')
    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(['run_code'])
    expect(events.filter(event => event.type === 'tool/ptc-dispatch').map(event => event.data))
      .toMatchObject([{ name: 'str_replace_editor', arguments: { command: 'create' }, isError: false }])
    const cwd = agent.session.header.cwd
    if (cwd === undefined) throw new Error('Standalone editor Session has no working directory')
    expect(await readFile(join(cwd, 'edited.txt'), 'utf8')).toBe('PTC_EDITOR_OK\n')
    await assertFinalWorkspaceSnapshot(DIR, cwd)
    await expect.poll(() => page.getByText('DONE', { exact: true }).count()).toBeGreaterThanOrEqual(1)
    if (MODE === 'record') await recordFixture(scaffold, sessionId, FIXTURE)
    else await compareOrRefreshGolden(join(DIR, 'ui.expected.md'),
      await captureExpandedTurnProcessAria(page, '[data-chat-flow]', scaffold.workspaceCwd), MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it.skipIf(MODE !== 'replay')('keeps the owned fixture artifacts closed', async () => {
    await assertFixtureInventory(DIR, [
      'session.v4.jsonl', 'system-prompt.expected.md', 'tool-schemas.expected.json', 'ui.expected.md', 'workspace.expected',
    ])
  })
})
