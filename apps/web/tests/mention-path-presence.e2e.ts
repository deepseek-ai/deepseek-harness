/** Typed `@` mentions render as file and folder chips only when the Session's filesystem has the path. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold, readPersistedEvents,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const DIR = fileURLToPath(new URL('../../../snapshots/web/mention-path-presence', import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')
const MODE = webSnapshotMode()
const PROMPT = '@ceshi @随便写点文字 @LICENSE @docs/ mail@host'

describe.skipIf(MODE === 'record')('web e2e: mention path presence', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      replayFixture: FIXTURE,
      compareReplaySession: true,
      paceMs: 10,
      extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
    })
    await mkdir(join(scaffold.workspaceCwd, 'workspace', 'docs'), { recursive: true })
    await writeFile(join(scaffold.workspaceCwd, 'workspace', 'LICENSE'), 'Reference fixture license.\n')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]')
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  })

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      await scaffold?.close()
    }
  })

  it('decorates typed mentions of existing paths and keeps other @ text verbatim across reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'mention-path-presence'))
    const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
    await writeComposerDraft(page, composer, PROMPT)
    // The trailing token is not a mention, so no completion is open to take the Enter.
    await page.getByRole('listbox', { name: 'Trigger suggestions' }).waitFor({ state: 'hidden' })
    expect(await composer.locator('[data-composer-chip]').count()).toBe(0)

    const settled = scaffold.whenTurnSettled()
    await composer.press('Enter')
    const sessionId = await settled
    const persisted = (await readPersistedEvents(scaffold, sessionId))
      .find(event => event.type === 'user/message' && event.data.source.kind === 'user')
    expect(persisted).toMatchObject({ data: { content: [{ type: 'text', text: PROMPT }] } })
    expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])

    for (const reload of [false, true]) {
      if (reload) await page.reload({ waitUntil: 'load' })
      const bubble = page.locator('[data-chat-flow-kind="user"]')
      await expect.poll(() => bubble.locator('[data-ref-chip]').allTextContents()).toEqual(['LICENSE', 'docs'])
      expect(await bubble.textContent()).toContain('@ceshi @随便写点文字 ')
      expect(await bubble.textContent()).toContain(' mail@host')
      await bubble.getByRole('button', { name: 'LICENSE', exact: true }).click()
      await page.getByText('Reference fixture license.', { exact: true }).waitFor()
    }
    await compareOrRefreshGolden(join(DIR, 'ui.expected.md'),
      await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd), MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
