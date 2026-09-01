// Web e2e scenario: the shipped composition discovers local files and cold
// sessions through the real Host, groups both domains in the shared @ menu,
// and projects each pick as a complete inline range without issuing a model call.
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-reference/types'
import type {} from '@deepseek-ai/dsh-session-title'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  seedSession,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/reference-composer', import.meta.url))
const MENU_EXPECTED = join(SNAPSHOT_DIR, 'menu.expected.md')
const ORDER_EXPECTED = join(SNAPSHOT_DIR, 'order.expected.md')
const MODE = webSnapshotMode()
const SOURCE_SESSION_ID = 'reference-source-session'
const TARGET_SESSION_ID = 'reference-order-target-session'

/** Build one closed source session with a stable title for reference discovery. */
function sourceSessionFixture(): string {
  const session = Session.create(SessionId(SOURCE_SESSION_ID))
  session.append('turn/start', {
    turn: 1,
  })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Research context for the reference menu.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', {
    title: 'Research notes',
    messageSeqs: [user.seq],
    source: { kind: 'fallback' },
  })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [
    JSON.stringify({
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: '{{sessionId}}',
      createdAt: 0,
      cwd: '{{cwd}}',
    }),
    ...session.snapshotEvents().map(event => JSON.stringify(event)),
    '',
  ].join('\n')
}

/** Build one target log with the direct message durably before its recalled context. */
function targetSessionFixture(): string {
  const session = Session.create(SessionId(TARGET_SESSION_ID))
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '@Research notes what changed?' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '## Referenced sessions\n\n<referenced-sessions>snapshot</referenced-sessions>' }],
    source: {
      kind: 'session-reference',
      form: 'recall',
      version: 1,
      references: [{
        sessionId: SOURCE_SESSION_ID,
        label: 'Research notes',
        capturedThroughSeq: 4,
        compacted: false,
        originalMessages: 2,
        retainedMessages: 2,
        omittedMessages: 0,
        omittedBytes: 0,
        truncated: false,
        inputIndex: 0,
      }],
    },
  }), { surfaceOp: 'append' })
  session.append('session/title', {
    title: 'Reference order target',
    messageSeqs: [user.seq],
    source: { kind: 'fallback' },
  })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [
    JSON.stringify({
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: '{{sessionId}}',
      createdAt: 0,
      cwd: '{{cwd}}',
    }),
    ...session.snapshotEvents().map(event => JSON.stringify(event)),
    '',
  ].join('\n')
}

describe.skipIf(MODE === 'record')('web e2e: file and session references through the real host', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, sourceSessionFixture(), SOURCE_SESSION_ID)
    await seedSession(scaffold, targetSessionFixture(), TARGET_SESSION_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    // Fixture files land before the workspace connects so the Host's file
    // index never races their creation (the connect helper mkdirs the same
    // directory and tolerates it existing).
    await mkdir(join(scaffold.workspaceCwd, 'workspace'), { recursive: true })
    await writeFile(join(scaffold.workspaceCwd, 'workspace', 'reference.txt'), 'reference fixture\n')
    await mkdir(join(scaffold.workspaceCwd, 'workspace', 'folderx'), { recursive: true })
    await writeFile(join(scaffold.workspaceCwd, 'workspace', 'folderx', 'child.txt'), 'child fixture\n')
    // Two levels down: the breadcrumb needs a step above the current one to
    // return to, and a bare '@' lists only the top level, so the deeper tree
    // stays out of the menu golden.
    await mkdir(join(scaffold.workspaceCwd, 'workspace', 'folderx', 'nested'), { recursive: true })
    await writeFile(join(scaffold.workspaceCwd, 'workspace', 'folderx', 'nested', 'leaf.txt'), 'leaf fixture\n')
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('groups both sources and projects files and sessions as structured inline icon labels', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-reference-composer'))
    const input = page.locator('[data-composer-input]').first()
    const menu = page.getByRole('listbox', { name: 'Trigger suggestions' })

    await input.fill('@')
    await expect.poll(() => menu.getByRole('option').count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
    // Session rows are dated from the live Host list, so their age bucket
    // advances while the suite runs.
    const snapshot = await captureStableAria(
      page, '[role="listbox"]', scaffold.workspaceCwd, { normalizeAge: true },
    )
    await compareOrRefreshGolden(MENU_EXPECTED, snapshot, MODE)
    expect(snapshot).toContain('Files & folders')
    expect(snapshot).toContain('Sessions')
    expect(snapshot).not.toContain('text: reference Files & folders')
    expect(snapshot).toContain('reference.txt')
    // A seed reaches disk as a log alone, and the Host labels a session from
    // its projections: no checkpoint, so the row is its id. The fixture's own
    // title (`Research notes`) is unreachable here by construction, and the
    // package suite owns the titled paths.
    expect(snapshot).toContain(SOURCE_SESSION_ID)
    expect(snapshot).not.toContain('Research notes')
    expect(snapshot).not.toContain('text: Subagents')

    await input.fill('@reference')
    // The open menu keeps the previous query's rows while the new one loads
    // (stale-while-revalidate), and rows are keyed by index, so a click
    // resolved against a stale row lands on whatever settles into that slot.
    // `folderx/` matches only the bare '@' query: its disappearance marks the
    // settled result set.
    await expect.poll(() => menu.getByRole('option', { name: /folderx/ }).count(), { timeout: 15_000 }).toBe(0)
    await menu.getByRole('option', { name: /reference\.txt/ }).click()
    // The pick lands an atomic chip: a real DOM capsule carrying the domain
    // icon and the label (the canonical reference text lives on the node and
    // expands on submit; the surface text is the label plus the separator).
    const fileReference = page.locator('[data-composer-chip]').last()
    await expect.poll(() => fileReference.textContent()).toBe('reference.txt')
    await expect.poll(() => fileReference.locator('svg').count()).toBe(1)
    await expect.poll(() => input.textContent()).toBe('reference.txt ')

    await input.fill('@reference-source')
    await menu.getByRole('option', { name: new RegExp(SOURCE_SESSION_ID) }).click()
    const sessionReference = page.locator('[data-composer-chip]').last()
    await expect.poll(() => sessionReference.textContent()).toBe(SOURCE_SESSION_ID)
    await expect.poll(() => sessionReference.locator('svg').count()).toBe(1)
    await expect.poll(() => input.textContent()).toBe(`${SOURCE_SESSION_ID} `)

    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('typing a trigger directly ahead of a chip inserts without disturbing it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-reference-type-ahead'))
    const input = page.locator('[data-composer-input]').first()
    const menu = page.getByRole('listbox', { name: 'Trigger suggestions' })

    await input.fill('@reference')
    await menu.getByRole('option', { name: /reference\.txt/ }).click()
    await expect.poll(() => input.locator('[data-composer-chip]').count()).toBe(1)

    // The #2813 gesture: collapse the caret to the document start, directly
    // ahead of the chip, and open the trigger menu there.
    await input.click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.type('@reference-source')
    await menu.getByRole('option', { name: new RegExp(SOURCE_SESSION_ID) }).click()

    // Both chips survive the boundary insert: the session chip lands ahead of
    // the intact file chip.
    const chips = input.locator('[data-composer-chip]')
    await expect.poll(() => chips.count()).toBe(2)
    await expect.poll(() => chips.first().textContent()).toBe(SOURCE_SESSION_ID)
    await expect.poll(() => chips.last().textContent()).toBe('reference.txt')
    await expect.poll(() => input.textContent()).toBe(`${SOURCE_SESSION_ID} reference.txt `)

    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('arrows step across a chip in one move and Backspace removes it whole', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-reference-keyboard'))
    const input = page.locator('[data-composer-input]').first()
    const menu = page.getByRole('listbox', { name: 'Trigger suggestions' })

    await input.fill('@reference')
    await menu.getByRole('option', { name: /reference\.txt/ }).click()
    await expect.poll(() => input.locator('[data-composer-chip]').count()).toBe(1)

    // First ArrowLeft crosses the trailing space; the second steps across the
    // chip in one move — no keyboard-selected intermediate state — and typing
    // continues normally on the far side.
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.type('pre')
    await expect.poll(() => input.textContent()).toBe('prereference.txt ')
    await expect.poll(() => input.locator('[data-composer-chip]').count()).toBe(1)

    // A collapsed Backspace directly ahead of the chip removes the typed
    // character only; the chip's identity is untouched (#2814's gesture).
    await page.keyboard.press('Backspace')
    await expect.poll(() => input.textContent()).toBe('prreference.txt ')
    await expect.poll(() => input.locator('[data-composer-chip]').count()).toBe(1)

    // ArrowRight steps back across the chip; Backspace directly behind it
    // removes the whole chip in one keystroke.
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Backspace')
    await expect.poll(() => input.locator('[data-composer-chip]').count()).toBe(0)
    await expect.poll(() => input.textContent()).toBe('pr ')

    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('settles a folder as an atomic chip; Tab and the chevron drill instead', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-reference-folder'))
    const input = page.locator('[data-composer-input]').first()
    const menu = page.getByRole('listbox', { name: 'Trigger suggestions' })

    // Settle: Enter on the highlighted folder row resolves the folder itself
    // as an atomic chip — folder glyph, no trigger character, one unit.
    await writeComposerDraft(page, input, '@folderx')
    // First folder query on this page: allow the Host index a cold start.
    await menu.getByRole('option', { name: /^folderx\// }).waitFor({ timeout: 60_000 })
    await page.keyboard.press('Enter')
    const chip = input.locator('[data-composer-chip]').last()
    await expect.poll(() => chip.textContent()).toBe('folderx/')
    await expect.poll(() => chip.locator('svg').count()).toBe(1)
    await expect.poll(() => input.textContent()).toBe('folderx/ ')

    // Tab drills: the literal descent text stays editable and the open menu
    // lists the folder's children.
    await writeComposerDraft(page, input, '@folderx')
    await menu.getByRole('option', { name: /^folderx\// }).waitFor()
    await page.keyboard.press('Tab')
    await expect.poll(() => input.textContent()).toBe('@folderx/')
    await menu.getByRole('option', { name: /child\.txt/ }).waitFor()

    // The row chevron drills the same way by pointer, header included: a
    // pointer descent reaches the same listing a Tab descent does.
    await writeComposerDraft(page, input, '@folderx')
    const row = menu.getByRole('option', { name: /^folderx\// })
    await row.waitFor()
    await row.getByRole('button', { name: 'Browse folder' }).click()
    await expect.poll(() => input.textContent()).toBe('@folderx/')
    await menu.getByRole('option', { name: /child\.txt/ }).waitFor()
    await expect.poll(() => page.getByRole('navigation', { name: 'Folder navigation' })
      .getByRole('button').allTextContents()).toEqual(['Workspace', 'folderx'])
    // The listing knows it was drilled into, so its rows drop the location the
    // header already carries.
    await expect.poll(() => menu.getByRole('option', { name: /child\.txt/ }).textContent())
      .toBe('child.txt')
    await page.keyboard.press('Escape')

    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('a drilled listing carries a breadcrumb back to the workspace root', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-reference-breadcrumb'))
    const input = page.locator('[data-composer-input]').first()
    const menu = page.getByRole('listbox', { name: 'Trigger suggestions' })
    const crumbs = page.getByRole('navigation', { name: 'Folder navigation' })

    // A path the user typed carries its own context: no header.
    await writeComposerDraft(page, input, '@folderx/')
    await menu.getByRole('option', { name: /child\.txt/ }).waitFor({ timeout: 60_000 })
    await expect.poll(() => crumbs.count()).toBe(0)

    // The same listing reached by drilling owes the user the way back.
    await writeComposerDraft(page, input, '@folderx')
    await menu.getByRole('option', { name: /^folderx\// }).waitFor()
    await page.keyboard.press('Tab')
    await menu.getByRole('option', { name: /child\.txt/ }).waitFor()
    await crumbs.waitFor()
    await expect.poll(() => crumbs.getByRole('button').allTextContents())
      .toEqual(['Workspace', 'folderx'])
    // The listed folder is where the menu already is: its crumb is inert, and
    // the rows drop the location the header now carries.
    await expect.poll(() => crumbs.getByRole('button', { name: 'folderx' }).isDisabled()).toBe(true)
    await expect.poll(() => menu.getByRole('option', { name: /child\.txt/ }).textContent())
      .toBe('child.txt')

    // A crumb above the current step re-lists that directory and keeps the
    // header, which now names the step it returned to.
    await writeComposerDraft(page, input, '@folderx/nested')
    const nested = menu.getByRole('option', { name: /^nested\// })
    await nested.waitFor()
    await nested.getByRole('button', { name: 'Browse folder' }).click()
    await expect.poll(() => input.textContent()).toBe('@folderx/nested/')
    await expect.poll(() => crumbs.getByRole('button').allTextContents())
      .toEqual(['Workspace', 'folderx', 'nested'])
    await crumbs.getByRole('button', { name: 'folderx' }).click()
    await expect.poll(() => input.textContent()).toBe('@folderx/')
    await expect.poll(() => crumbs.getByRole('button').allTextContents())
      .toEqual(['Workspace', 'folderx'])

    // Clicking the root crumb rewrites the token back to a bare trigger.
    await crumbs.getByRole('button', { name: 'Workspace' }).click()
    await expect.poll(() => input.textContent()).toBe('@')
    await expect.poll(() => crumbs.count()).toBe(0)
    await menu.getByRole('option', { name: /^folderx\// }).waitFor()
    await page.keyboard.press('Escape')

    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('renders the durable direct-message then recall order', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-reference-order'))
    const group = page.getByRole('treeitem', { name: /Ungrouped/ })
    await group.waitFor({ timeout: 15_000 })
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
    const target = page.getByRole('treeitem', { name: /Reference order target/ })
    await target.waitFor({ timeout: 15_000 })
    await target.click()
    await page.getByRole('button', { name: /^Session recall\s*Research notes$/ }).waitFor({ timeout: 15_000 })

    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(TARGET_SESSION_ID).join('{{targetId}}')
    await compareOrRefreshGolden(ORDER_EXPECTED, snapshot, MODE)
    expect(snapshot.indexOf('Research notes what changed?')).toBeLessThan(snapshot.indexOf('Session recall Research notes'))
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['menu.expected.md', 'order.expected.md'])
  })
})
