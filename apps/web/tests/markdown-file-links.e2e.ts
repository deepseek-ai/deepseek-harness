/** Cold-replayed Markdown references open Session files through the shipped Web composition. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type {} from '@deepseek-ai/dsh-session-title'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { expandOwningTurnProcess, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/markdown-file-links', import.meta.url))
const MODE = webSnapshotMode()

/** Build live test input with a parent-path link and a read result naming the same Host file. */
function parentPathFixture(path: string): string {
  const session = Session.create(SessionId('parent-file-links-source'))
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Read the parent-path file and link lines 24 and 30.' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', { title: 'Parent file links', messageSeqs: [user.seq], source: { kind: 'fallback' } })
  session.append('step/start', { turn: 1, step: 1 })
  const callId = ToolCallId('parent-file-read')
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

/** Build a settled turn whose relative link follows a directory change into a nested checkout. */
function changedDirectoryFixture(path: string): string {
  const session = Session.create(SessionId('changed-directory-links-source'))
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Enter the worktree and link its notes.' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', { title: 'Changed directory links', messageSeqs: [user.seq], source: { kind: 'fallback' } })
  session.append('working-directory/change', { cwd: '{{cwd}}/.agents/worktrees/w' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    turn: 1, step: 1, stream: [],
    message: createAssistantMessage({
      content: [{ type: 'text', text: `[Worktree notes](${path})` }],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
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
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v3.jsonl', 'links.expected.md', 'preview.expected.md'])
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
    const address = sessionFileAddress(id, path)
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

    await page.reload({ waitUntil: 'load' })
    await expect.poll(() => column.locator('[data-textpreview-path]').textContent()).toBe(join(scaffold.workspaceCwd, 'parent.txt'))
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
    await expect.poll(stored).toContain(sessionFileAddress(id, 'parent.txt'))
    await source.click()
    expect(await tabs.allTextContents()).toEqual(['parent.txt', 'parent.txt'])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
  it('resolves relative links from the Session\'s current working directory', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-changed-directory-file-links'))
    const worktree = join(scaffold.workspaceCwd, '.agents/worktrees/w')
    await mkdir(worktree, { recursive: true })
    await writeFile(join(scaffold.workspaceCwd, 'notes.txt'), 'original checkout\n')
    await writeFile(join(worktree, 'notes.txt'), 'worktree checkout\n')
    const id = await seedSession(scaffold, changedDirectoryFixture('notes.txt'), 'changed-directory-file-links')
    await page.reload({ waitUntil: 'load' })
    const workspace = page.getByRole('treeitem').first()
    await workspace.waitFor()
    if (await workspace.getAttribute('aria-expanded') !== 'true') await workspace.click()
    await page.locator(`[data-row-key="session:${id}"]`).click()

    await page.getByRole('button', { name: 'Worktree notes', exact: true }).click()
    const column = page.locator('[data-rightbar-col]')
    await expect.poll(() => column.locator('[data-textpreview-path]').textContent()).toBe(join(worktree, 'notes.txt'))
    await expect.poll(() => column.locator('[data-textpreview-line="1"]').textContent()).toBe('worktree checkout\n')
    const artifacts = fileURLToPath(new URL('../../../.artifacts', import.meta.url))
    await mkdir(artifacts, { recursive: true })
    await page.screenshot({ path: join(artifacts, 'changed-directory-file-links.png'), animations: 'disabled' })
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
