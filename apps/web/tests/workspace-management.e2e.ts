// Web e2e scenarios: workspace management — adding a workspace through the
// composed directory dialog (its own New folder affordance is the product's
// one creation route), the dialog's path editor walking the panes with the
// typed draft, same-basename directory adoption, the rename round
// trip over the real wire (workspace.rename RPC + durable registry), the
// duplicate-name pre-check, the
// flat "In one list" view with its persisted group-by preference, the session
// hover card and row action menu, and the session archive round trip (row
// menu → workspace.archiveSession RPC → durable global set → row hidden
// across reload). Zero model calls: workspace.create/rename/archiveSession
// are host RPCs with no model involvement, and the one session row the
// flat/hover/menu/archive scenarios need comes from a seeded fixture (the
// seeded-history seed reused verbatim — no new recording).
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, sep } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { logPath } from '../../../packages/session/session-persistence-jsonl/src/format.ts'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, readPersistedEvents, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/workspace-management', import.meta.url))
// The seed is another scenario's committed fixture, reused read-only: this
// spec needs any one cold session row, not new recorded content.
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v2.jsonl', import.meta.url))
const MODE = webSnapshotMode()
const BROWSER_EXPECTED = join(SNAPSHOT_DIR, 'directory-browser.expected.md')
const SEED_ID = 'workspace-management-web-e2e'
// Both waits exceed ui-primitives' 200ms POINTER_GRACE_MS. Keep them above
// that value if the shared setting changes.
const POINTER_TRANSIT_MS = 300
const POINTER_HOLD_MS = 600

describe('web e2e: workspace management (create / rename / flat view / hover affordances)', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  /**
   * Raise the region header's directory dialog and drive it to a directory via
   * the path-edit affordance. Adding is the header button's only action, so
   * the click lands in the dialog with no menu in between.
   */
  async function browseTo(path: string): Promise<Locator> {
    await page.getByRole('button', { name: 'Add workspace' }).click()
    const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Edit path' }).click()
    const pathInput = dialog.locator('input[aria-label="Edit path"]')
    await pathInput.fill(path)
    await pathInput.press('Enter')
    return dialog
  }

  /**
   * Create a folder inside `parent` through the dialog and adopt it — the
   * product's only route to a brand-new workspace directory.
   */
  async function addNewFolderWorkspace(parent: string, name: string): Promise<void> {
    const dialog = await browseTo(parent)
    await dialog.getByRole('button', { name: 'New folder' }).click()
    await page.getByLabel('Folder name').fill(name)
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    // Creating selects the new folder in the listing; Open adopts it.
    await dialog.getByRole('button', { name: 'Open', exact: true }).click()
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
    await expect.poll(
      () => scaffold.ctx.workspaceRegistry.resolveByPath(join(parent, name)),
      { timeout: 10_000 },
    ).not.toBeUndefined()
  }

  /**
   * Adopt an existing directory, waiting for the adoption to settle host-side
   * (workspace registered + the flow's New-Session agent up), so later test
   * steps can't race the in-flight blank-session attach.
   */
  async function adoptDirectory(path: string, options: { waitForAgent?: boolean } = {}): Promise<void> {
    const agentsBefore = scaffold.ctx.agents.list().length
    const dialog = await browseTo(path)
    await dialog.getByRole('button', { name: 'Open', exact: true }).click()
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
    await expect.poll(
      () => scaffold.ctx.workspaceRegistry.resolveByPath(path),
      { timeout: 10_000 },
    ).not.toBeUndefined()
    // First adoption births a blank Session+Agent whose workspace attach must
    // settle before a test may delete the registration; re-registration after
    // a delete mints a fresh blank Session+Agent too (no cwd-based reuse
    // exists), so callers opt in only where a fresh attach is possible.
    if (options.waitForAgent === true) {
      await expect.poll(() => scaffold.ctx.agents.list().length, { timeout: 10_000 })
        .toBeGreaterThan(agentsBefore)
    }
  }

  /**
   * Reveal and click a row action, re-hovering if a projection update replaces
   * the row before its hover-only button becomes visible.
   */
  async function clickHoverAction(row: Locator, name: string): Promise<void> {
    const button = row.getByRole('button', { name })
    await expect.poll(async () => {
      await row.hover()
      return await button.isVisible()
    }, { timeout: 10_000 }).toBe(true)
    await button.click()
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    // Seed one cold session (Ungrouped bucket) for the flat view + hover card.
    const sessionCwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(sessionCwd, { recursive: true })
    await writeFile(join(sessionCwd, 'a.txt'), 'alpha\n')
    await writeFile(join(sessionCwd, 'b.txt'), 'beta\n')
    await seedSession(scaffold, await readFile(SEED, 'utf8'), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('adds two workspaces through the dialog, each on a folder it created', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ws-create'))
    const add = async (name: string): Promise<void> => {
      await addNewFolderWorkspace(scaffold.workspaceCwd, name)
      // The real workspace materializes in the tree as a group row.
      await expect.poll(() => page.getByText(name, { exact: true }).count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
    }
    await add('alpha-ws')
    await add('beta-ws')
    // Durable on the host: both registered, newest first (create prepends),
    // each titled after the folder the dialog made.
    const titles = scaffold.ctx.workspaceRegistry.list().map(workspace => workspace.title)
    expect(titles.slice(0, 2)).toEqual(['beta-ws', 'alpha-ws'])
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('renames a workspace over the wire with a duplicate-name pre-check', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ws-rename'))
    const alphaRow = page.locator('[role="treeitem"]').filter({ hasText: 'alpha-ws' }).first()
    await clickHoverAction(alphaRow, 'Workspace actions for alpha-ws')
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    const dialog = page.getByRole('dialog', { name: 'Rename workspace' })
    await dialog.waitFor({ timeout: 10_000 })
    const input = dialog.getByLabel('Workspace name')
    // Client pre-check: a name colliding with another live workspace raises
    // the inline alert and blocks the primary button before any wire call.
    await input.fill('beta-ws')
    await expect.poll(() => dialog.getByRole('alert').count(), { timeout: 5_000 }).toBe(1)
    expect(await dialog.getByRole('button', { name: 'Rename' }).isDisabled()).toBe(true)
    // A fresh name goes through workspace.rename to the durable registry.
    await input.fill('gamma-ws')
    await expect.poll(() => dialog.getByRole('alert').count(), { timeout: 5_000 }).toBe(0)
    await dialog.getByRole('button', { name: 'Rename' }).click()
    await expect.poll(() => page.getByRole('dialog', { name: 'Rename workspace' }).count(), { timeout: 10_000 }).toBe(0)
    await expect.poll(() => page.getByText('gamma-ws', { exact: true }).count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
    expect(await page.getByText('alpha-ws', { exact: true }).count()).toBe(0)
    // Host durability, then reload: the projection is rebuilt from the wire.
    expect(scaffold.ctx.workspaceRegistry.list().map(workspace => workspace.title)).toContain('gamma-ws')
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await expect.poll(() => page.getByText('gamma-ws', { exact: true }).count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('deletes only the Workspace registration and keeps its current Session, folder, and log', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ws-delete'))
    const slotConsoleErrors: string[] = []
    const transientSlotErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error' && /slot entry crashed/i.test(message.text())) {
        slotConsoleErrors.push(message.text())
      }
    })
    await page.exposeFunction('recordDshSlotError', (key: string) => {
      if (!transientSlotErrors.includes(key)) transientSlotErrors.push(key)
    })
    await page.evaluate(() => {
      const target = window as unknown as { recordDshSlotError(key: string): Promise<void> }
      const seen = new Set<string>()
      const collect = (): void => {
        for (const node of document.querySelectorAll<HTMLElement>('[data-slot-error]')) {
          const key = node.dataset.slotError ?? ''
          if (!seen.has(key)) {
            seen.add(key)
            void target.recordDshSlotError(key)
          }
        }
      }
      new MutationObserver(collect).observe(document.documentElement, { childList: true, subtree: true })
      collect()
    })
    // Register the scaffold's existing project directory through the real UI.
    await adoptDirectory(scaffold.workspaceCwd, { waitForAgent: true })
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(scaffold.workspaceCwd)
    if (workspace === undefined) throw new Error('GUI did not register the existing project directory')
    await workspace.attachSession(SessionId(SEED_ID))
    const header = (await scaffold.ctx.sessionPersistence.list())
      .map(snapshot => snapshot.header)
      .find(candidate => candidate.id === SEED_ID)
    if (header === undefined) throw new Error('seeded Session log disappeared before deletion')
    const seededLogPath = logPath(scaffold.persistenceRoot, header.cwd, header.id, 'zstd')
    expect(await readFile(join(scaffold.workspaceCwd, 'workspace', 'a.txt'), 'utf8')).toBe('alpha\n')
    await stat(seededLogPath)

    // Open the seeded (first/accounted) Session so deletion must preserve the
    // current selection while it moves into Ungrouped.
    const groupRow = page.locator('[role="treeitem"]').filter({ hasText: workspace.title }).first()
    await groupRow.waitFor({ timeout: 10_000 })
    // The header row is wrapped by its HoverCard anchor span, so the section
    // is the nearest groupSection ancestor, not the immediate parent.
    const groupSection = groupRow.locator('xpath=ancestor::*[contains(@class, "groupSection")][1]')
    await expect.poll(async () => {
      const count = await groupSection.locator('[role="treeitem"]').count()
      if (count < 2 && await groupRow.getAttribute('aria-expanded') !== 'true') {
        await groupRow.click()
        await page.waitForTimeout(50)
      }
      return await groupSection.locator('[role="treeitem"]').count()
    }, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
    const seededRow = groupSection.locator('[role="treeitem"]').nth(1)
    await seededRow.click()
    await expect.poll(() => seededRow.getAttribute('aria-selected'), { timeout: 10_000 }).toBe('true')

    await clickHoverAction(groupRow, `Workspace actions for ${workspace.title}`)
    await page.getByRole('menuitem', { name: 'Delete workspace' }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete workspace' })
    await dialog.waitFor({ timeout: 10_000 })
    const copy = await dialog.textContent()
    expect(copy).toContain('workspace list')
    expect(copy).toContain('folder and session logs will be kept')
    expect(copy).toContain('sessions will appear under Ungrouped')
    await dialog.getByRole('button', { name: 'Delete workspace' }).click()
    await expect.poll(() => dialog.count(), { timeout: 10_000 }).toBe(0)

    expect(scaffold.ctx.workspaceRegistry.get(workspace.id)).toBeUndefined()
    await expect.poll(
      () => page.getByRole('button', { name: `Workspace actions for ${workspace.title}` }).count(),
      { timeout: 10_000 },
    ).toBe(0)
    await expect.poll(() => page.getByText('Ungrouped', { exact: true }).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1)
    await expect.poll(
      () => page.locator('[role="treeitem"][aria-selected="true"]').count(),
      { timeout: 10_000 },
    ).toBe(1)
    expect(await readFile(join(scaffold.workspaceCwd, 'workspace', 'a.txt'), 'utf8')).toBe('alpha\n')
    await stat(seededLogPath)
    expect((await readPersistedEvents(scaffold, SessionId(SEED_ID))).length).toBeGreaterThan(0)

    // Re-registering the exact deleted path immediately, without a reload, is
    // a supported reversible flow. It creates a fresh Workspace id and does
    // NOT re-adopt the retained (non-blank) Session; the New Session flow
    // mints a fresh blank session and attaches it to the new registration
    // (no cwd-based blank reuse exists, so the account is never empty).
    await adoptDirectory(scaffold.workspaceCwd)
    await expect.poll(
      () => scaffold.ctx.workspaceRegistry.resolveByPath(scaffold.workspaceCwd),
      { timeout: 10_000 },
    ).not.toBeUndefined()
    const reregistered = await scaffold.ctx.workspaceRegistry.resolveByPath(scaffold.workspaceCwd)
    expect(reregistered?.id).toBeDefined()
    expect(reregistered?.id).not.toBe(workspace.id)
    await expect.poll(
      () => reregistered?.sessionIds ?? [],
      { timeout: 10_000 },
    ).not.toEqual([])
    expect(reregistered?.sessionIds).not.toContain(SEED_ID)
    await expect.poll(() => page.getByText('Ungrouped', { exact: true }).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1)
    expect(await readFile(join(scaffold.workspaceCwd, 'workspace', 'a.txt'), 'utf8')).toBe('alpha\n')
    await stat(seededLogPath)

    // Restore the deleted-registry state so reload still verifies deletion
    // persistence independently of the successful re-registration above.
    if (reregistered === undefined) throw new Error('same-path re-registration did not materialize')
    await scaffold.ctx.workspaceRegistry.delete(reregistered.id)
    await expect.poll(
      () => page.getByRole('button', { name: `Workspace actions for ${reregistered.title}` }).count(),
      { timeout: 10_000 },
    ).toBe(0)

    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await expect.poll(() => page.getByText('Ungrouped', { exact: true }).count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1)
    await expect.poll(
      () => page.locator('[role="treeitem"][aria-selected="true"]').count(),
      { timeout: 15_000 },
    ).toBe(1)
    expect(scaffold.ctx.workspaceRegistry.get(workspace.id)).toBeUndefined()
    expect(await readFile(join(scaffold.workspaceCwd, 'workspace', 'a.txt'), 'utf8')).toBe('alpha\n')
    await stat(seededLogPath)
    expect((await readPersistedEvents(scaffold, SessionId(SEED_ID))).length).toBeGreaterThan(0)

    expect(transientSlotErrors).toEqual([])
    expect(slotConsoleErrors).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('reuses a deleted title for a different new directory without any transient error surface', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ws-reuse-title'))
    const title = 'same-name'
    const oldPath = join(scaffold.workspaceCwd, 'adopted', title)
    await mkdir(oldPath, { recursive: true })
    const transientErrors: string[] = []
    const consoleErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    await page.exposeFunction('recordDshTransientWorkspaceError', (message: string) => {
      if (!transientErrors.includes(message)) transientErrors.push(message)
    })
    await page.evaluate(() => {
      const target = window as unknown as {
        recordDshTransientWorkspaceError(message: string): Promise<void>
      }
      const collect = (): void => {
        for (const node of document.querySelectorAll<HTMLElement>('[data-slot-error], [role="alert"]')) {
          const message = node.dataset.slotError ?? node.textContent?.trim() ?? ''
          if (message !== '') void target.recordDshTransientWorkspaceError(message)
        }
      }
      new MutationObserver(collect).observe(document.documentElement, { childList: true, subtree: true })
      collect()
    })

    await adoptDirectory(oldPath)
    await expect.poll(
      () => scaffold.ctx.workspaceRegistry.resolveByPath(oldPath),
      { timeout: 10_000 },
    ).not.toBeUndefined()
    const oldWorkspace = await scaffold.ctx.workspaceRegistry.resolveByPath(oldPath)
    if (oldWorkspace === undefined) throw new Error('old same-name Workspace was not registered')

    const oldRow = page.locator('[role="treeitem"]').filter({ hasText: title }).first()
    await clickHoverAction(oldRow, `Workspace actions for ${title}`)
    await page.getByRole('menuitem', { name: 'Delete workspace' }).click()
    await page.getByRole('dialog', { name: 'Delete workspace' })
      .getByRole('button', { name: 'Delete workspace' }).click()
    await expect.poll(() => scaffold.ctx.workspaceRegistry.get(oldWorkspace.id), { timeout: 10_000 }).toBeUndefined()

    await addNewFolderWorkspace(scaffold.workspaceCwd, title)
    const fresh = scaffold.ctx.workspaceRegistry.list().find(workspace => workspace.title === title)
    expect(fresh?.id).toBeDefined()
    expect(fresh?.id).not.toBe(oldWorkspace.id)
    expect(fresh?.path).toBe(join(scaffold.workspaceCwd, title))
    expect(transientErrors).toEqual([])
    expect(consoleErrors).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('switches to the flat "In one list" view and persists the preference', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ws-flat'))
    // Grouped default: workspace group rows render (the seeded session sits
    // under Ungrouped; the created workspaces are empty groups).
    await expect.poll(() => page.getByText('Workspaces', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    // Grouping and ordering moved into the View options menu.
    await page.getByRole('button', { name: 'View options' }).click()
    await page.getByRole('menuitem', { name: 'In one list' }).click()
    // Flat mode: the section label flips and the seeded session is a
    // top-level row with no group headers above it.
    await expect.poll(() => page.getByText('Sessions', { exact: true }).count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
    await expect.poll(() => page.getByText('Ungrouped', { exact: true }).count(), { timeout: 5_000 }).toBe(0)
    await expect.poll(() => page.locator('[role="treeitem"]').count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
    expect(await page.evaluate(() => localStorage.getItem('dsh.workspace.view.v5'))).toContain('flat')
    // Persisted across reload; then restore grouped for inter-spec hygiene.
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await expect.poll(() => page.getByText('Ungrouped', { exact: true }).count(), { timeout: 15_000 }).toBe(0)
    await page.getByRole('button', { name: 'View options' }).click()
    await page.getByRole('menuitem', { name: 'WorkSpace' }).click()
    await expect.poll(() => page.getByText('Ungrouped', { exact: true }).count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('matches the directory-browser dialog aria golden at a staged directory', async () => {
    // A staged subtree under the scaffold cwd keeps the listing deterministic
    // (normalizeAria scrubs the cwd), and pointing the in-process host's HOME
    // at the cwd collapses the breadcrumb ancestry into the Home crumb — no
    // machine-specific path segments or real $HOME contents enter the golden.
    const staged = join(scaffold.workspaceCwd, 'browse-golden')
    await mkdir(join(staged, 'alpha'), { recursive: true })
    await mkdir(join(staged, 'beta'), { recursive: true })
    // homedir() reads HOME on POSIX and USERPROFILE on Windows: root both
    // at the scaffold cwd so the golden's ancestry collapses everywhere.
    const realHome = process.env.HOME
    const realUserProfile = process.env.USERPROFILE
    process.env.HOME = scaffold.workspaceCwd
    process.env.USERPROFILE = scaffold.workspaceCwd
    try {
      const dialog = await browseTo(staged)
      await expect.poll(() => dialog.getByText('alpha', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
      const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(BROWSER_EXPECTED, snapshot, MODE)
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
    } finally {
      if (realHome === undefined) delete process.env.HOME
      else process.env.HOME = realHome
      if (realUserProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = realUserProfile
    }
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('walks the panes with the typed path: deeper past a separator, back up on erase, whole on a miss', async () => {
    // The panes must track the draft without leaving the editor, so the
    // typed text and what is listed under it never disagree.
    // Staged by this scenario itself (mkdir is recursive and idempotent), so
    // running it alone through -t sees the same tree the assertions describe.
    const staged = join(scaffold.workspaceCwd, 'browse-golden')
    await mkdir(join(staged, 'alpha', 'only-under-alpha'), { recursive: true })
    await mkdir(join(staged, 'beta'), { recursive: true })
    const dialog = await browseTo(staged)
    await expect.poll(() => dialog.getByText('alpha', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    await dialog.getByRole('button', { name: 'Edit path' }).click()
    const path = dialog.getByLabel('Edit path')
    // A directory part no pane lists: the panes walk to it, landing the
    // ordinary two-pane Miller view (level | its children) with the editor
    // still up and the draft intact.
    await path.fill(`${join(staged, 'alpha')}${sep}`)
    await expect.poll(() => dialog.getByText('only-under-alpha', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => dialog.getByRole('list').count(), { timeout: 10_000 }).toBe(2)
    expect(await path.inputValue()).toBe(`${join(staged, 'alpha')}${sep}`)
    // Erasing back past the separator walks the panes up, so the level being
    // typed is the last pane again (its children no longer stand to its
    // right) and the tail filters it.
    await path.fill(`${staged}${sep}al`)
    await expect.poll(() => dialog.getByText('only-under-alpha', { exact: true }).count(), { timeout: 10_000 }).toBe(0)
    expect(await dialog.getByText('alpha', { exact: true }).count()).toBe(1)
    expect(await dialog.getByText('beta', { exact: true }).count()).toBe(0)
    await expect.poll(() => dialog.getByRole('list').count(), { timeout: 10_000 }).toBe(2)
    // A tail nobody matches is a name still being spelled: the level shows
    // whole instead of emptying under it.
    await path.fill(`${staged}${sep}zzz`)
    await expect.poll(() => dialog.getByText('beta', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    expect(await dialog.getByText('alpha', { exact: true }).count()).toBe(1)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  /**
   * Expand Ungrouped and return its seeded session row. The only visible child
   * is the non-blank persisted Session; the blank Session created while
   * adopting the Workspace stays hidden.
   * @returns the session row locator, already present.
   */
  async function seededSessionRow() {
    const ungroupedRow = page.getByText('Ungrouped', { exact: true }).locator('..').locator('..')
    const ungroupedSection = ungroupedRow.locator('..')
    // Initial-current auto-expansion can race this gesture; converge on
    // expanded rather than assuming which update wins first.
    await expect.poll(async () => {
      if (await ungroupedRow.getAttribute('aria-expanded') !== 'true') {
        await page.getByText('Ungrouped', { exact: true }).click()
        await page.waitForTimeout(50)
      }
      return await ungroupedRow.getAttribute('aria-expanded')
    }, { timeout: 5_000 }).toBe('true')
    const row = ungroupedSection.locator('[role="treeitem"]').nth(1)
    await row.waitFor({ timeout: 10_000 })
    return row
  }

  it('shows the session hover card after a dwell on the row', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ws-hover'))
    // Dwell on the seeded row; the card opens after a 500ms hover delay,
    // portaled to body.
    const sessionRow = await seededSessionRow()
    const rowTitle = await sessionRow.locator('[class*="title"]').innerText()
    await sessionRow.hover()
    // Card content: the full title plus the Idle status line (no aria role —
    // text anchors are the stable selector).
    await expect.poll(() => page.getByText('Idle', { exact: true }).count(), { timeout: 5_000 }).toBeGreaterThanOrEqual(1)
    // The card is REACHABLE: it sits 8px off the row, so getting to it means
    // crossing ground that belongs to neither. Hovering it must not dismiss
    // it — the hazard this scenario pins.
    const card = page.getByRole('button', { name: `Copy: ${rowTitle}` })
    await card.hover()
    await page.waitForTimeout(POINTER_HOLD_MS)
    expect(await page.getByText('Idle', { exact: true }).count()).toBeGreaterThanOrEqual(1)
    // The full title is the card's primary value: activating anywhere on the
    // card writes it through the browser clipboard and localizes the success
    // feedback through the English locale seat.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    const cardHeight = (await card.boundingBox())?.height
    await card.click()
    const copied = page.getByRole('status').getByText('Copied', { exact: true })
    await copied.waitFor({ timeout: 5_000 })
    await page.waitForTimeout(POINTER_HOLD_MS)
    expect((await card.boundingBox())?.height).toBe(cardHeight)
    expect(await copied.isVisible()).toBe(true)
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(rowTitle)
    // Leaving anchor and card together closes it after the grace.
    await page.getByRole('button', { name: 'Settings' }).hover()
    await expect.poll(() => card.count(), { timeout: 5_000 }).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps an open row menu up while the pointer moves between trigger and list', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ws-row-menu'))
    const sessionRow = await seededSessionRow()
    // The trigger is display:none until its row hovers.
    const trigger = sessionRow.locator('button[aria-label^="Session actions for "]')
    const triggerName = await trigger.getAttribute('aria-label')
    if (triggerName === null) throw new Error('seeded Session row has no actions label')
    await clickHoverAction(sessionRow, triggerName)
    const item = page.getByRole('menuitem', { name: 'Rename' })
    await item.waitFor({ timeout: 5_000 })
    // Into the list, then back up to the trigger across the 4px gap below it:
    // without the gap-crossing grace, that return trip fires the list's
    // pointerleave and closes the menu — a hesitating pointer loses it.
    // Order matters — clicking leaves the pointer ON the trigger, so entering
    // the list has to come first for the return to be a real departure.
    await item.hover()
    await page.waitForTimeout(POINTER_TRANSIT_MS)
    await trigger.hover()
    await page.waitForTimeout(POINTER_HOLD_MS)
    expect(await page.getByRole('menuitem', { name: 'Rename' }).count()).toBe(1)
    // ...and back down into the list, which must still be there to enter.
    await item.hover()
    await page.waitForTimeout(POINTER_HOLD_MS)
    expect(await page.getByRole('menuitem', { name: 'Rename' }).count()).toBe(1)
    // Pointer-leave dismissal still applies once the pointer genuinely leaves.
    await page.getByRole('button', { name: 'Settings' }).hover()
    await expect.poll(() => page.getByRole('menuitem', { name: 'Rename' }).count(), { timeout: 5_000 }).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('archives the seeded session from its row menu, hiding it durably across reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ws-archive'))
    // The seeded session lives under Ungrouped (expanded by the hover-card
    // test's gesture; converge again for order independence).
    const ungroupedRow = page.getByText('Ungrouped', { exact: true }).locator('..').locator('..')
    const ungroupedSection = ungroupedRow.locator('..')
    await expect.poll(async () => {
      if (await ungroupedRow.getAttribute('aria-expanded') !== 'true') {
        await page.getByText('Ungrouped', { exact: true }).click()
        await page.waitForTimeout(50)
      }
      return await ungroupedRow.getAttribute('aria-expanded')
    }, { timeout: 5_000 }).toBe('true')
    // Anchor on session rows (the rows carrying a session actions button),
    // not a positional index, and assert the single-stray assumption loudly
    // so a fixture gaining a second stray fails here instead of archiving
    // the wrong row. CSS attribute match, not getByRole: the button is
    // display:none until its row hovers, and role queries skip hidden nodes.
    const sessionRows = ungroupedSection.locator('[role="treeitem"]')
      .filter({ has: page.locator('button[aria-label^="Session actions for "]') })
    await expect.poll(() => sessionRows.count(), { timeout: 10_000 }).toBe(1)
    const sessionRow = sessionRows.first()
    const rowTitle = await sessionRow.locator('[class*="title"]').innerText()
    // Row menu: hover reveals the actions button; Archive session commits
    // without a confirmation dialog (non-destructive: log + accounting stay).
    await clickHoverAction(sessionRow, `Session actions for ${rowTitle}`)
    await page.getByRole('menuitem', { name: 'Archive session' }).click()
    // The row disappears on the archive-set echo; with no other visible
    // stray, the whole Ungrouped bucket withdraws.
    await expect.poll(() => page.getByText(rowTitle, { exact: true }).count(), { timeout: 10_000 }).toBe(0)
    await expect.poll(() => page.getByText('Ungrouped', { exact: true }).count(), { timeout: 10_000 }).toBe(0)
    // Durable on the host: the registry-global set carries the id while the
    // session log itself stays in persistence untouched.
    expect([...scaffold.ctx.workspaceRegistry.archivedSessionIds]).toEqual([SessionId(SEED_ID)])
    expect((await scaffold.ctx.sessionPersistence.list()).map(snapshot => snapshot.header.id)).toContain(SessionId(SEED_ID))
    // Reload: the hidden state is rebuilt from the workspace.list baseline.
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await expect.poll(() => page.getByText('Workspaces', { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    // The archived row must not resurface (the Ungrouped bucket itself may
    // reappear if selection restore lands on another stray — not this test's
    // concern).
    expect(await page.getByText(rowTitle, { exact: true }).count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('opens folders with identical basenames as distinct workspaces', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ws-duplicate-basename'))
    const firstPath = join(scaffold.workspaceCwd, 'same-basename-a', 'xx')
    const secondPath = join(scaffold.workspaceCwd, 'same-basename-b', 'xx')
    await mkdir(firstPath, { recursive: true })
    await mkdir(secondPath, { recursive: true })

    await adoptDirectory(firstPath, { waitForAgent: true })
    await adoptDirectory(secondPath, { waitForAgent: true })

    const matchingWorkspaces = scaffold.ctx.workspaceRegistry.list()
      .filter(workspace => workspace.title === 'xx')
    expect(matchingWorkspaces.map(workspace => workspace.path).sort())
      .toEqual([firstPath, secondPath].sort())
    await expect.poll(
      () => page.locator('button[aria-label="Workspace actions for xx"]').count(),
      { timeout: 10_000 },
    ).toBe(2)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it.skipIf(MODE === 'record')('issued zero model calls and stayed clean', async () => {
    expect(tripwire.warnings).toEqual([])
    // The directory-browser aria golden is this spec's one owned artifact;
    // the seed it reuses is owned (and inventory-guarded) by seeded-history.
    await assertFixtureInventory(SNAPSHOT_DIR, ['.gitkeep', 'directory-browser.expected.md'])
  })
})
