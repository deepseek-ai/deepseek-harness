/** Standard-mode CUA programs retain code cards, nested calls, images, and source inspection. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, selectedSessionFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const fixture = fileURLToPath(new URL('../../../snapshots/session/cua-run-code/session.v4.jsonl', import.meta.url))
const snapshotDirectory = fileURLToPath(new URL('../../../snapshots/web/cua-run-code', import.meta.url))
const mode = webSnapshotMode()

it.skipIf(mode === 'record')('shows standard CUA programs and their recorded source through the Web composition', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cua-run-code-web-'))
  const resources: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    try { await resources.browser?.close() } finally {
      try { await resources.scaffold?.close() } finally { await rm(directory, { recursive: true, force: true }) }
    }
  })
  const patch = join(directory, 'cua-fixture.yml')
  await writeFile(patch, JSON.stringify([{ id: 'agent-default-model', config: {
    provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp',
  } }, { insert: [
    { id: 'computer-use', name: '@deepseek-ai/dsh-computer-use' },
    { id: 'cua-run-code-fixture', name: fileURLToPath(new URL('../../../snapshots/session/cua-run-code/provider.mjs', import.meta.url)),
      config: { allowedApps: [{ id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app' }] } },
  ] }]))
  const scaffold = resources.scaffold = await launchWebScaffold({
    replayFixture: fixture, compareReplaySession: false, extraOverlayPath: patch,
  })
  const events: SessionEvent[] = []
  scaffold.ctx.on('session/event', (_session, event) => { events.push(event) })
  const browser = resources.browser = await chromium.launch()
  const page = await newEnglishPage(browser), tripwire = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-cua-run-code'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const agent = scaffold.ctx.agents.list()[0]!
  expect(scaffold.ctx.agentPresets.composedPreset(agent.ctx)).toBe('standard')
  expect(scaffold.ctx.tools.schemas(agent).map(tool => tool.name)).toContain('cua_run_code')
  expect(scaffold.ctx.tools.schemas(agent).map(tool => tool.name)).not.toContain('cua')
  const prompts = fixtureUserPrompts(await readFile(await selectedSessionFixture(fixture), 'utf8'))
  expect(prompts).toHaveLength(1)
  const prompt = prompts.at(0)
  if (prompt === undefined) throw new Error('The CUA recording must contain a user prompt')
  const settled = scaffold.whenTurnSettled()
  const input = page.locator('[data-composer-input]').first()
  await input.fill(prompt)
  await input.press('Enter')
  await settled
  const results = events.filter(event => event.type === 'tool/result')
  expect(results).toHaveLength(2)
  expect(results.every(event => !event.data.message.isError)).toBe(true)
  expect(events.filter(event => event.type === 'tool/ptc-dispatch')).toHaveLength(8)
  const calls = page.locator('[data-tool="cua_run_code"]')
  const description = 'Select and capture the fixture window'
  const turnControl = page.locator('[data-turn-process="1"]')
  await turnControl.waitFor({ state: 'visible' })
  await expect.poll(() => turnControl.getAttribute('aria-expanded')).toBe('false')
  await turnControl.click()
  await expect.poll(() => turnControl.getAttribute('aria-expanded')).toBe('true')
  const group = calls.first().locator('xpath=ancestor::*[@data-chat-group-key][1]')
  const groupControl = group.locator('[data-process-activity]').first()
  await groupControl.waitFor({ state: 'visible' })
  if (await groupControl.getAttribute('aria-expanded') === 'false') await groupControl.click()
  await expect.poll(() => groupControl.getAttribute('aria-expanded')).toBe('true')
  await expect.poll(() => calls.count()).toBe(2)
  await calls.first().getByRole('button', { name: `Code ${description}`, exact: true }).click()
  const source = calls.first().locator('pre.shiki')
  await source.waitFor()
  expect(await source.textContent()).toContain('var app = await cua.getApp("test.fixture")')
  expect(await page.locator('[data-subcalls] [data-tool="cua"]').count()).toBe(8)
  expect(events.filter(event => event.type === 'tool/ptc-dispatch' && event.data.content.some(block => block.type === 'image'))).toHaveLength(1)
  expect(events.filter(event => event.type === 'tool/result'
    && event.data.message.content.some(block => block.type === 'image'))).toHaveLength(1)
  expect(await calls.first().textContent()).toContain('(1x1px, 90 bytes)')
  expect(await calls.first().textContent()).not.toContain('"type": "image"')
  await compareOrRefreshGolden(join(snapshotDirectory, 'ui.expected.md'),
    await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd), mode)
  if (mode === 'refresh') {
    const evidence = fileURLToPath(new URL('../../../.playwright-mcp/cua-run-code-ui', import.meta.url))
    await mkdir(evidence, { recursive: true })
    await page.screenshot({ path: join(evidence, 'standard-code-cards.png'), animations: 'disabled' })
    const viewport = page.viewportSize()
    await page.setViewportSize({ width: 800, height: 900 })
    await page.screenshot({ path: join(evidence, 'standard-code-cards-narrow.png'), animations: 'disabled' })
    if (viewport !== null) await page.setViewportSize(viewport)
  }
  await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
  const row = page.getByRole('row', { name: new RegExp(`cua_run_code ${description}`) })
  await row.click()
  await page.getByRole('tab', { name: 'Code', exact: true }).click()
  expect(await page.getByRole('tabpanel').textContent()).toContain('var app = await cua.getApp("test.fixture")')
  await page.getByRole('button', { name: 'Wrap lines', exact: true }).click()
  await compareOrRefreshGolden(join(snapshotDirectory, 'code.expected.md'),
    await captureStableAria(page, '[role="tabpanel"]', scaffold.workspaceCwd), mode)
  if (mode === 'refresh') {
    await page.screenshot({ path: fileURLToPath(new URL('../../../.playwright-mcp/cua-run-code-ui/source-inspector.png', import.meta.url)), animations: 'disabled' })
  }
  const screenshot = page.locator('tr[data-kind="subtool"]').filter({ hasText: '"method":"screenshot"' })
  await screenshot.click()
  await page.getByRole('tab', { name: 'Result', exact: true }).click()
  const image = page.getByRole('tabpanel').locator('img').first()
  await image.waitFor({ state: 'visible' })
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
  await assertFixtureInventory(snapshotDirectory, ['ui.expected.md', 'code.expected.md'])
})
