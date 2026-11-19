/** Cold-replayed Markdown references open Session files through the shipped Web composition. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { type ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, type SessionId } from '@deepseek-ai/dsh-session'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type {} from '@deepseek-ai/dsh-session-title'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, readPersistedEvents, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { expandOwningTurnProcess, newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/markdown-file-links', import.meta.url))
const MODE = webSnapshotMode()
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

/** A restored preview resolves its Host path after the document's load event. */
async function reloadPreview(page: Page, column: Locator, absolutePath: string): Promise<void> {
  await page.reload({ waitUntil: 'load' })
  await column.getByText(absolutePath, { exact: true }).waitFor()
  expect(await column.locator('[data-textpreview-path]').textContent()).toBe(absolutePath)
}

/** Build live test input with a parent-path link and a read result naming the same Host file. */
function parentPathFixture(path: string): string {
  const session = Session.create(brandString<SessionId>('parent-file-links-source'))
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Read the parent-path file and link lines 24 and 30.' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', { title: 'Parent file links', messageSeqs: [user.seq], source: { kind: 'fallback' } })
  session.append('step/start', { turn: 1, step: 1 })
  const callId = brandString<ToolCallId>('parent-file-read')
  const args = JSON.stringify({ file_path: path, offset: 24, limit: 7 })
  session.append('assistant/message', {
    turn: 1, step: 1, stream: [],
    message: createAssistantMessage({
      content: [{ type: 'tool-call', id: callId, name: 'read', arguments: args }],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
  const call = session.append('tool/call', { turn: 1, step: 1, callId, name: 'read', arguments: args })
  session.append('tool/result', {
    turn: 1, step: 1, meta: { path: '{{cwd}}/parent.txt' },
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'parent line 24\n' }], isError: false }),
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('step/start', { turn: 1, step: 2 })
  session.append('assistant/message', {
    turn: 1, step: 2, stream: [],
    message: createAssistantMessage({
      content: [{ type: 'text', text: `[Parent file:24–30](<${path}#L24-L30>) · [Parent file:30](<${path}#L30>)` }],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 2 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [
    JSON.stringify({
      type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0,
      cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0,
    }),
    ...session.snapshotEvents().map(event => JSON.stringify(event)),
    '',
  ].join('\n')
}

/**
 * Build settled turns for a Session that moves between directories: each turn moves the Session
 * to its `cwd`, when it names one, before the assistant writes `reply`.
 */
function movedDirectoryFixture(title: string, turns: readonly { readonly cwd?: string; readonly reply: string }[]): string {
  const session = Session.create(brandString<SessionId>('moved-directory-links-source'))
  for (const [index, { cwd, reply }] of turns.entries()) {
    const turn = index + 1
    session.append('turn/start', { turn })
    const user = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `Link the files of step ${turn}.` }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    if (turn === 1) session.append('session/title', { title, messageSeqs: [user.seq], source: { kind: 'fallback' } })
    if (cwd !== undefined) session.append('workspace-root/change', { cwd })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      turn, step: 1, stream: [],
      message: createAssistantMessage({
        content: [{ type: 'text', text: reply }],
        source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return [
    JSON.stringify({
      type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0,
      cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0,
    }),
    ...session.snapshotEvents().map(event => JSON.stringify(event)),
    '',
  ].join('\n')
}

describe('web e2e: Markdown file links', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await mkdir(join(scaffold.workspaceCwd, 'src'))
    await mkdir(join(scaffold.workspaceCwd, 'other'))
    await writeFile(join(scaffold.workspaceCwd, 'src/example.txt'),
      Array.from({ length: 60 }, (_, i) => `source line ${i + 1}\n`).join(''))
    await writeFile(join(scaffold.workspaceCwd, 'other/example.txt'), 'other file\n')
    await seedSession(scaffold, await readFile(join(SNAPSHOT_DIR, 'session.v3.jsonl'), 'utf8'), 'markdown-file-links')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[role="treeitem"]').first().click()
    await page.locator('[role="treeitem"]').nth(1).click()
    await page.getByRole('button', { name: 'src/example.txt:24–30', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('previews relative and absolute links at the requested line without duplicate tabs', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-markdown-file-links'))
    const source = page.getByRole('button', { name: 'src/example.txt:24–30', exact: true })
    const prose = await source.locator('..').ariaSnapshot()
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'links.expected.md'), prose, MODE)
    const beforeUrl = page.url()
    await source.click()
    const column = page.locator('[data-rightbar-col]')
    await expect.poll(() => column.locator('[data-textpreview-target="24"]').textContent()).toBe('source line 24\n')
    await expect.poll(() => column.locator('[data-textpreview-path]').textContent())
      .toBe(join(scaffold.workspaceCwd, 'src/example.txt'))
    const absolute = page.getByRole('button', { name: 'src/example.txt:30', exact: true })
    await absolute.focus()
    await absolute.press('Enter')
    await expect.poll(() => column.locator('[data-textpreview-target="30"]').textContent()).toBe('source line 30\n')
    expect(await column.locator('[data-dockkit-tab-title]').allTextContents()).toEqual(['example.txt'])
    expect(page.url()).toBe(beforeUrl)
    expect(page.context().pages()).toHaveLength(1)
    expect(await page.getByRole('link', { name: 'Website', exact: true }).getAttribute('target')).toBe('_blank')
    const artifacts = fileURLToPath(new URL('../../../.artifacts', import.meta.url))
    await mkdir(artifacts, { recursive: true })
    await page.screenshot({ path: join(artifacts, 'markdown-file-links.png'), animations: 'disabled' })
    await page.getByRole('button', { name: 'other/example.txt', exact: true }).click()
    await expect.poll(() => column.locator('[data-textpreview-path]').textContent())
      .toBe(join(scaffold.workspaceCwd, 'other/example.txt'))
    await expect.poll(() => column.locator('[data-textpreview-line="1"]').textContent()).toBe('other file\n')
    expect(await column.locator('[data-dockkit-tab-title]').allTextContents()).toEqual(['example.txt', 'example.txt'])
    const preview = await captureStableAria(page, '[data-textpreview-state="text"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'preview.expected.md'), preview, MODE)
    await page.getByRole('button', { name: 'Missing file', exact: true }).click()
    await column.locator('[data-textpreview-failed="workspace-file/not-found"]').waitFor()
    expect(page.url()).toBe(beforeUrl)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('adds a recorded line-labeled file to the draft without its line suffix or a new turn', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-markdown-file-add-to-chat'))
    const sessionId = brandString<SessionId>('markdown-file-links')
    const beforeEvents = await readPersistedEvents(scaffold, sessionId)
    const beforeMessages = await page.locator('[data-chat-flow-kind="user"]').count()
    const input = page.locator('[data-composer-input]').first()
    const draft = 'Review this file next: '
    await writeComposerDraft(page, input, draft)
    await page.getByRole('button', { name: 'src/example.txt:24–30', exact: true }).click({ button: 'right' })
    const menu = page.getByRole('menu')
    const action = menu.getByRole('menuitem', { name: 'Add to chat', exact: true })
    await action.waitFor()
    expect(await menu.getByRole('menuitem').last().textContent()).toBe('Add to chat')
    const menuAria = await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd)
    await action.click()
    await menu.waitFor({ state: 'hidden' })
    await expect.poll(() => input.evaluate(node => node === document.activeElement)).toBe(true)
    await expect.poll(() => input.textContent()).toBe(`${draft}example.txt `)
    const chip = input.locator('[data-composer-chip]')
    expect(await chip.count()).toBe(1)
    expect(await chip.textContent()).toBe('example.txt')
    expect(await chip.locator('svg').count()).toBe(1)
    const composerAria = await captureStableAria(page, '[data-composer-input]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'add-to-chat.expected.md'),
      `## File menu\n\n${menuAria}\n\n## Composer\n\n${composerAria}`, MODE)

    await page.keyboard.press('ControlOrMeta+A')
    const copied = await input.evaluate((node) => {
      const clipboardData = new DataTransfer()
      node.dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true }))
      return clipboardData.getData('text/plain')
    })
    const path = join(scaffold.workspaceCwd, 'src/example.txt')
    expect(copied).toBe(`${draft}@${path} `)
    expect(copied).not.toContain(':24')
    expect(copied).not.toContain('#L24')
    expect(await page.locator('[data-chat-flow-kind="user"]').count()).toBe(beforeMessages)
    expect(await readPersistedEvents(scaffold, sessionId)).toEqual(beforeEvents)
    await writeComposerDraft(page, input, '')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'session.v3.jsonl', 'links.expected.md', 'preview.expected.md', 'add-to-chat.expected.md',
    ])
  })

  it('replays colon line suffixes as locations and shares tabs with fragment links', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-colon-file-links'))
    const fixture = new URL('./fixtures/markdown-colon-file-links/session.v3.jsonl', import.meta.url)
    const id = await seedSession(scaffold, await readFile(fixture, 'utf8'), 'colon-file-links')
    await page.reload({ waitUntil: 'load' })
    const workspace = page.getByRole('treeitem').first()
    await workspace.waitFor()
    if (await workspace.getAttribute('aria-expanded') !== 'true') await workspace.click()
    await page.locator(`[data-row-key="session:${id}"]`).click()

    const relative = page.getByRole('button', { name: 'Relative colon:24–30', exact: true })
    await relative.waitFor()
    expect(await page.getByRole('button', { name: 'Development server', exact: true }).count()).toBe(0)
    expect(await page.getByRole('link', { name: 'Development server', exact: true }).getAttribute('href')).toBe('localhost:3000')
    expect(await page.getByRole('link', { name: 'Bare URL', exact: true }).getAttribute('href')).toBe('index.ts:24')
    expect(await page.getByRole('link', { name: 'Blocked script', exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Blocked script', exact: true }).count()).toBe(0)
    expect(await page.getByRole('link', { name: 'Mail', exact: true }).getAttribute('href')).toBe('mailto:10086')
    await compareOrRefreshGolden(
      fileURLToPath(new URL('./expected/markdown-colon-file-links.md', import.meta.url)),
      await relative.locator('..').ariaSnapshot(), MODE,
    )
    const column = page.locator('[data-rightbar-col]')
    for (const label of ['Zero line', 'Reversed range']) {
      await page.getByRole('button', { name: label, exact: true }).click()
      await expect.poll(() => column.locator('[data-textpreview-path]').textContent())
        .toBe(join(scaffold.workspaceCwd, 'src/example.txt'))
      await expect.poll(() => column.locator('[data-textpreview-line="1"]').textContent()).toBe('source line 1\n')
      expect(await column.locator('[data-dockkit-tab-title]').allTextContents()).toEqual(['example.txt'])
    }
    for (const [label, line] of [['Relative colon:24–30', 24], ['Absolute colon:30', 30], ['Column:24:5', 24], ['Fragment:12', 12]] as const) {
      const link = page.getByRole('button', { name: label, exact: true })
      await link.focus()
      await link.press('Enter')
      await expect.poll(() => column.locator(`[data-textpreview-target="${line}"]`).textContent())
        .toBe(`source line ${line}\n`)
      await expect.poll(() => column.locator('[data-textpreview-path]').textContent())
        .toBe(join(scaffold.workspaceCwd, 'src/example.txt'))
      expect(await column.locator('[data-dockkit-tab-title]').allTextContents()).toEqual(['example.txt'])
    }
    await reloadPreview(page, column, join(scaffold.workspaceCwd, 'src/example.txt'))
    await relative.click()
    await expect.poll(() => column.locator('[data-textpreview-target="24"]').textContent()).toBe('source line 24\n')
    expect(await column.locator('[data-dockkit-tab-title]').allTextContents()).toEqual(['example.txt'])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('opens parent-path prose and read-card links while retaining each address across reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-parent-file-links'))
    // Return through the parent into this owned temp root; no shared parent file is created.
    const path = `../${basename(scaffold.workspaceCwd)}/parent.txt`
    await writeFile(join(scaffold.workspaceCwd, 'parent.txt'),
      Array.from({ length: 60 }, (_, i) => `parent line ${i + 1}\n`).join(''))
    const id = await seedSession(scaffold, parentPathFixture(path), 'parent-file-links')
    await page.reload({ waitUntil: 'load' })
    const workspace = page.getByRole('treeitem').first()
    await workspace.waitFor()
    if (await workspace.getAttribute('aria-expanded') !== 'true') await workspace.click()
    await page.locator(`[data-row-key="session:${id}"]`).click()

    const source = page.getByRole('button', { name: 'Parent file:24–30', exact: true })
    await source.click()
    const column = page.locator('[data-rightbar-col]')
    const stored = () => page.evaluate(key => localStorage.getItem(key), `dsh.sidebar-right.v1.${id}`)
    const address = sessionFileAddress(id, `${scaffold.workspaceCwd}/${path}`)
    await expect.poll(() => column.locator('[data-textpreview-target="24"]').textContent()).toBe('parent line 24\n')
    await expect.poll(() => column.locator('[data-textpreview-path]').textContent()).toBe(join(scaffold.workspaceCwd, 'parent.txt'))
    await expect.poll(stored).toContain(address)
    const tabs = column.locator('[data-dockkit-tab-title]')
    expect(await tabs.allTextContents()).toEqual(['parent.txt'])

    const later = page.getByRole('button', { name: 'Parent file:30', exact: true })
    await later.focus()
    await later.press('Enter')
    await expect.poll(() => column.locator('[data-textpreview-target="30"]').textContent()).toBe('parent line 30\n')
    expect(await tabs.allTextContents()).toEqual(['parent.txt'])

    await reloadPreview(page, column, join(scaffold.workspaceCwd, 'parent.txt'))
    await expect.poll(stored).toContain(address)
    await source.click()
    await expect.poll(() => column.locator('[data-textpreview-target="24"]').textContent()).toBe('parent line 24\n')
    expect(await tabs.allTextContents()).toEqual(['parent.txt'])

    const readCardLink = page.locator('[data-tool="read"] button').filter({ hasText: 'parent.txt' })
    await expandOwningTurnProcess(page, readCardLink)
    await readCardLink.click()
    await expect.poll(() => column.locator('[data-textpreview-path]').textContent()).toBe(join(scaffold.workspaceCwd, 'parent.txt'))
    await expect.poll(() => column.locator('[data-textpreview-target="24"]').textContent()).toBe('parent line 24\n')
    // The Host-reported path and the unresolved prose path are distinct resource identities.
    expect(await tabs.allTextContents()).toEqual(['parent.txt', 'parent.txt'])
    await expect.poll(stored).toContain(sessionFileAddress(id, join(scaffold.workspaceCwd, 'parent.txt')))
    await source.click()
    expect(await tabs.allTextContents()).toEqual(['parent.txt', 'parent.txt'])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
  it('resolves relative links and images from the Session\'s current working directory', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-changed-directory-file-links'))
    const worktree = join(scaffold.workspaceCwd, '.agents/worktrees/w')
    await mkdir(worktree, { recursive: true })
    await writeFile(join(scaffold.workspaceCwd, 'notes.txt'), 'original checkout\n')
    await writeFile(join(worktree, 'notes.txt'), 'worktree checkout\n')
    // Only the worktree holds the image, so it loads only when resolved from the Session's current directory.
    await writeFile(join(worktree, 'chart.png'), PNG)
    const id = await seedSession(scaffold, movedDirectoryFixture('Changed directory links', [
      { cwd: '{{cwd}}/.agents/worktrees/w', reply: '[Worktree notes](notes.txt)\n\n![Worktree chart](chart.png)' },
    ]), 'changed-directory-file-links')
    await page.reload({ waitUntil: 'load' })
    const workspace = page.getByRole('treeitem').first()
    await workspace.waitFor()
    if (await workspace.getAttribute('aria-expanded') !== 'true') await workspace.click()
    await page.locator(`[data-row-key="session:${id}"]`).click()

    await page.getByRole('button', { name: 'Worktree notes', exact: true }).click()
    const column = page.locator('[data-rightbar-col]')
    await expect.poll(() => column.locator('[data-textpreview-path]').textContent()).toBe(join(worktree, 'notes.txt'))
    await expect.poll(() => column.locator('[data-textpreview-line="1"]').textContent()).toBe('worktree checkout\n')
    const image = page.getByRole('img', { name: 'Worktree chart', exact: true })
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1)
    expect(new URL(await image.getAttribute('src') ?? '', page.url()).searchParams.get('path')).toBe(join(worktree, 'chart.png'))
    const artifacts = fileURLToPath(new URL('../../../.artifacts', import.meta.url))
    await mkdir(artifacts, { recursive: true })
    await page.screenshot({ path: join(artifacts, 'changed-directory-file-links.png'), animations: 'disabled' })
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('keeps absolute links and opened tabs on their files after the Session leaves their directory', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-moved-directory-file-links'))
    const worktree = join(scaffold.workspaceCwd, '.agents/worktrees/pinned')
    await mkdir(worktree, { recursive: true })
    await writeFile(join(scaffold.workspaceCwd, 'pinned.txt'), 'original checkout\n')
    await writeFile(join(worktree, 'pinned.txt'), 'worktree checkout\n')
    const id = await seedSession(scaffold, movedDirectoryFixture('Moved directory links', [
      {
        cwd: '{{cwd}}/.agents/worktrees/pinned',
        reply: '[Worktree file](<{{cwd}}/.agents/worktrees/pinned/pinned.txt>) · [Relative file](pinned.txt)',
      },
      { cwd: '{{cwd}}', reply: 'Back in the original checkout.' },
    ]), 'moved-directory-file-links')
    await page.reload({ waitUntil: 'load' })
    const workspace = page.getByRole('treeitem').first()
    await workspace.waitFor()
    if (await workspace.getAttribute('aria-expanded') !== 'true') await workspace.click()
    await page.locator(`[data-row-key="session:${id}"]`).click()

    const column = page.locator('[data-rightbar-col]')
    const openedPath = () => column.locator('[data-textpreview-path]').textContent()
    const firstLine = () => column.locator('[data-textpreview-line="1"]').textContent()
    // The Session is back in the original checkout; the absolute target still names the worktree file.
    await page.getByRole('button', { name: 'Worktree file', exact: true }).click()
    await expect.poll(openedPath).toBe(join(worktree, 'pinned.txt'))
    await expect.poll(firstLine).toBe('worktree checkout\n')
    // A relative target resolves from the directory the Session works in at the click.
    await page.getByRole('button', { name: 'Relative file', exact: true }).click()
    await expect.poll(openedPath).toBe(join(scaffold.workspaceCwd, 'pinned.txt'))
    await expect.poll(firstLine).toBe('original checkout\n')
    const stored = () => page.evaluate(key => localStorage.getItem(key), `dsh.sidebar-right.v1.${id}`)
    await expect.poll(stored).toContain(sessionFileAddress(id, join(scaffold.workspaceCwd, 'pinned.txt')))

    const agent = scaffold.ctx.agents.list().find(candidate => candidate.session.id === id)
    if (agent === undefined) throw new Error('the opened Session has no live Agent')
    await scaffold.ctx.workingDirectory.set(agent, worktree)
    // The opened tab stores the absolute path, so a reload in the new directory restores the same file.
    await reloadPreview(page, column, join(scaffold.workspaceCwd, 'pinned.txt'))
    await expect.poll(firstLine).toBe('original checkout\n')
    expect(await column.locator('[data-dockkit-tab-title]').allTextContents()).toEqual(['pinned.txt', 'pinned.txt'])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
