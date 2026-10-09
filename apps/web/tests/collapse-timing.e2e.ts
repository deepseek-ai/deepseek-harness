/** Recorded work details rendered with independent completion and next-input folding. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page, Route } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { deriveReplayScript } from '@deepseek-ai/dsh-llm-replay'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, parseSeedFixture, readPersistedEvents, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, openSettings, saveFailureShot, writeComposerDraft } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/collapse-timing', import.meta.url))
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const SCREENSHOTS = 'screenshots/collapse-timing'
const SCREENSHOT_DIR = fileURLToPath(new URL(`../../../.artifacts/${SCREENSHOTS}`, import.meta.url))
const SEED_ID = 'collapse-timing-web-e2e'
const MODE = webSnapshotMode()
const UI_WAIT = { timeout: 10_000 }
const GOLDENS = [
  'completion.expected.md',
  'next-input.expected.md',
  'completion-restored.expected.md',
  'input-pending.expected.md',
  'next-message.expected.md',
  'verbose.expected.md',
]

describe.skipIf(MODE === 'record')('web e2e: recorded collapse timing', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let fixture: string
  let prompt: string
  let replayDir: string

  beforeAll(async () => {
    fixture = await readFile(SEED, 'utf8')
    const prompts = fixtureUserPrompts(fixture)
    expect(prompts).toHaveLength(1)
    prompt = prompts[0]!
    const continuation = deriveReplayScript(parseSeedFixture(fixture).events).at(-1)
    expect(continuation?.kind).toBe('chunks')
    replayDir = await mkdtemp(join(tmpdir(), 'dsh-collapse-timing-replay-'))
    const replayOverride = join(replayDir, 'replay.override.json')
    // Reuse the recorded final reasoning and answer without repeating historical tool-call ids.
    await writeFile(replayOverride, JSON.stringify([continuation]))
    scaffold = await launchWebScaffold({
      replayFixture: SEED,
      replayOverride,
      // This rendering borrows a completed turn and replays only its final response as a continuation.
      compareReplaySession: false,
    })
    await seedSession(scaffold, fixture, SEED_ID)
    browser = await chromium.launch({ headless: true })
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor()
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (replayDir !== undefined) {
      await rm(replayDir, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    }
    if (failures.length > 0) throw new AggregateError(failures, 'collapse-timing e2e cleanup failed')
  })

  async function selectPreference(title: string, choice: string): Promise<void> {
    await openSettings(page, 'en')
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    const row = dialog.getByText(title, { exact: true }).locator('../..')
    await row.getByRole('button').click()
    await page.getByRole('menuitem', { name: choice, exact: true }).click()
    await row.getByRole('button', { name: choice, exact: true }).waitFor()
    if (title === 'Work details') {
      await expect.poll(() => scaffold.ctx.settings.describe().find(row => row.ns === 'ui-chat')?.value, UI_WAIT)
        .toMatchObject({ transcriptView: choice.toLowerCase() })
    }
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  }

  async function capture(name: string): Promise<void> {
    await page.mouse.move(0, 0)
    const aria = await captureStableAria(page, '[data-chat-flow]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, name), aria, MODE)
  }

  async function expectDetails(turn: number, visible: boolean): Promise<void> {
    const reasoning = page.locator(`[data-chat-turn="${turn}"] [data-variant="think"]`).last()
    expect(await reasoning.count()).toBe(1)
    await expect.poll(() => reasoning.isVisible(), UI_WAIT).toBe(visible)
  }

  async function expectProcess(turn: number, expanded: boolean): Promise<void> {
    const process = page.locator(`[data-turn-process="${turn}"]`)
    await expect.poll(() => process.getAttribute('aria-expanded'), UI_WAIT).toBe(String(expanded))
    await expectDetails(turn, expanded)
  }

  it('folds at completion, defers the latest process until ordinary input, and keeps Verbose open', async () => {
    onTestFailed(async () => {
      await mkdir(SCREENSHOT_DIR, { recursive: true })
      const directory = await mkdtemp(join(SCREENSHOT_DIR, 'recorded-'))
      await saveFailureShot(page, `${SCREENSHOTS}/${basename(directory)}/failure`)
    })
    // Selecting the current client default does not create a saved Host preference.
    await selectPreference('Work details', 'Compact')
    await selectPreference('Work details', 'Detailed')
    const group = page.getByRole('treeitem').first()
    await group.waitFor()
    if (await group.getAttribute('aria-expanded') === 'false') await group.click()
    await page.getByRole('treeitem').nth(1).click()
    await page.getByText('DONE', { exact: true }).waitFor()
    await expectProcess(1, false)
    await capture('completion.expected.md')

    await selectPreference('When to Collapse Work Details', 'On next message')
    await expectProcess(1, true)
    await page.getByRole('button', { name: 'Read a.txt', exact: true }).waitFor()
    await capture('next-input.expected.md')

    await selectPreference('When to Collapse Work Details', 'On completion')
    await expectProcess(1, false)
    await capture('completion-restored.expected.md')

    await selectPreference('When to Collapse Work Details', 'On next message')
    await expectProcess(1, true)
    const input = page.locator('[data-composer-input]').last()
    await writeComposerDraft(page, input, prompt)
    await expectProcess(1, true)
    const release = Promise.withResolvers<undefined>()
    const promptBlocked = Promise.withResolvers<undefined>()
    const holdPrompt = async (route: Route): Promise<void> => {
      promptBlocked.resolve(undefined)
      await release.promise
      await route.continue()
    }
    await page.route('**/api/session/prompt', holdPrompt)
    try {
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      const blockedTimeout = setTimeout(() => {
        promptBlocked.reject(new Error('session prompt did not reach the route barrier'))
      }, UI_WAIT.timeout)
      try {
        await promptBlocked.promise
      } finally {
        clearTimeout(blockedTimeout)
      }
      await expect.poll(() => page.locator('[data-submission-echo]').count(), UI_WAIT).toBe(1)
      await expectProcess(1, false)
      expect(await page.locator('[data-turn-process="2"]').count()).toBe(0)
      await capture('input-pending.expected.md')
      const settled = scaffold.whenTurnSettled()
      release.resolve(undefined)
      expect(await settled).toBe(SEED_ID)
    } finally {
      release.resolve(undefined)
      await page.unrouteAll({ behavior: 'wait' })
    }
    await expect.poll(() => page.getByText('DONE', { exact: true }).count(), UI_WAIT).toBe(2)
    await expect.poll(() => page.locator('[data-streaming="true"]').count(), UI_WAIT).toBe(0)
    await expectProcess(1, false)
    await expectProcess(2, true)
    const persisted = await readPersistedEvents(scaffold, SessionId(SEED_ID))
    expect(persisted.filter(event => event.type === 'turn/end').map(event => event.data)).toEqual([
      { turn: 1, reason: { kind: 'completed' } },
      { turn: 2, reason: { kind: 'completed' } },
    ])
    await capture('next-message.expected.md')

    await selectPreference('Work details', 'Verbose')
    await selectPreference('When to Collapse Work Details', 'On completion')
    await expectDetails(1, true)
    await expectDetails(2, true)
    expect(await page.locator('[data-turn-process]:enabled').count()).toBe(0)
    await capture('verbose.expected.md')
    expect(await readFile(SEED, 'utf8')).toBe(fixture)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, GOLDENS)
  })
})
