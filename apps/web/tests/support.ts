// Shared plumbing for the web smoke tests (dist location, free port, failure shots).
import { existsSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { expect } from 'vitest'

/** The built page under test; `pnpm run test:web` rebuilds it before running. */
export const DIST_INDEX = fileURLToPath(new URL('../dist/index.html', import.meta.url))

export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

const installationRequire = createRequire(join(REPO_ROOT, 'apps/cli/package.json'))

/**
 * The built copy of a workspace package, as the dsh installation resolves it.
 * The Host plugins a scaffold profile loads run from built packages through
 * Node's own loader; a scaffold call that must share their module state
 * (app-boot keeps the root Include it mounted per context) has to run that
 * same copy, not the source a bare import gets through the tsconfig paths,
 * and not the test runner's own inlined copy of the built file either.
 * `require` of an ES module goes through Node's loader and shares its
 * module map with the plugins' imports; it needs a graph without top-level
 * await, which the built Host packages keep.
 * @param name - the workspace package name.
 * @returns the package's built module namespace, for the caller to type as the package's own.
 */
export function requireBuilt(name: string): unknown {
  return installationRequire(name)
}

/**
 * Browser language a page must advertise to boot into the product's Chinese
 * surface: with no stored preference the client derives its initial locale
 * from the browser, and Playwright's default browser asks for English.
 */
export const ZH_BROWSER_LOCALE = 'zh-CN'

/** Same-day anchor for seeded event times and the Asia/Shanghai browser clock. */
export const WEB_FIXTURE_TIME = Date.parse('2026-01-15T12:00:00+08:00')

/**
 * Open the standard browser-test page advertising English before client boot.
 * This keeps role locators and goldens deterministic while leaving the Host
 * settings document free to override the provisional browser-derived locale;
 * scenarios asserting the Chinese surface advertise
 * {@link ZH_BROWSER_LOCALE} instead. The context uses Asia/Shanghai to preserve
 * the recorded Web user-source timezone independently of the host timezone.
 * @param browser - Playwright browser owning the page.
 * @param height - Viewport height; width is fixed to the lane baseline.
 * @returns the initialized page.
 */
export async function newEnglishPage(browser: Browser, height = 1000): Promise<Page> {
  return await browser.newPage({ viewport: { width: 1680, height }, locale: 'en-US', timezoneId: 'Asia/Shanghai' })
}

/**
 * Scroll a locator whose rendered element can be replaced during layout.
 * @param target - locator resolved again when its previous element detached.
 */
export async function scrollIntoView(target: Locator): Promise<void> {
  await expect.poll(() => target.evaluate((element) => {
    if (!element.isConnected) return false
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
    return true
  }), { timeout: 10_000 }).toBe(true)
}

/**
 * Expand every eligible Turn process and secondary group so a Tool-focused
 * scenario can exercise the original row contract beneath product-default
 * compact Chat presentation.
 * @param page - page containing the Chat view.
 */
export async function expandTurnProcesses(page: Page): Promise<void> {
  const controls = page.locator('[data-turn-process], [data-process-activity]')
  await controls.first().waitFor({ state: 'visible', timeout: 10_000 })
  const count = await controls.count()
  for (let index = 0; index < count; index++) {
    const control = controls.nth(index)
    if (await control.isVisible() && await control.getAttribute('aria-expanded') === 'false') await control.click()
  }
}

/**
 * Expand the Turn process and secondary group containing a hidden descendant.
 * @param page - page containing the Chat view.
 * @param target - descendant whose outer process disclosures should open.
 */
export async function expandOwningTurnProcess(page: Page, target: Locator): Promise<void> {
  if (await target.isVisible()) return
  const turn = await target.evaluate(element => element.closest<HTMLElement>('[data-chat-turn]')?.dataset.chatTurn)
  if (turn !== undefined) {
    const control = page.locator(`[data-turn-process="${turn}"]`)
    await control.waitFor({ state: 'visible', timeout: 10_000 })
    if (await control.getAttribute('aria-expanded') === 'false') await control.click()
  }
  const group = target.locator('xpath=ancestor::*[@data-chat-group-key][1]')
  const header = group.locator('[data-process-activity]').first()
  if (await header.isVisible() && await header.getAttribute('aria-expanded') === 'false') await header.click()
}

/** Fail loud on a stale checkout instead of testing yesterday's bundle. */
export function requireDist(): void {
  if (!existsSync(DIST_INDEX)) {
    throw new Error('web app dist not built — run `pnpm run build` from the repository root (`pnpm run test:web` does this first)')
  }
}

/** OS-assigned free port, released before use (the spawned `dsh web` needs a concrete --port). */
export function probeFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close(() => { reject(new Error('port probe returned no address')) })
        return
      }
      probe.close(() => { resolvePort(address.port) })
    })
  })
}

/**
 * Drive the hero's workspace picker through the composed directory dialog
 * until the live composer unlocks. A fresh world has no Workspace, so the boot
 * lands in the Workspace-trigger view state (startup auto-selection has nothing to
 * select); every scenario that types into the composer must connect one
 * first. With nothing to list, activating the composer surface raises the dialog directly —
 * adding a workspace is the picker's only entry. The directory is staged here
 * and adopted through the path editor, which is idempotent across the repeated
 * connects a scenario may make; creating a folder from inside the dialog (the
 * product's other half of the same route) is covered by
 * workspace-management.e2e.ts. The default name 'workspace' keeps the session
 * header cwd at <root>/workspace, the materialization proof several scenarios
 * assert.
 * @param page - the page under test.
 * @param root - host directory the workspace folder is staged in (the scaffold's `workspaceCwd`).
 * @param name - folder name staged and adopted as the workspace.
 */
export async function connectFreshWorkspace(page: Page, root: string, name = 'workspace'): Promise<void> {
  mkdirSync(join(root, name), { recursive: true })
  await page.getByRole('textbox', { name: 'Choose workspace' }).click()
  const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
  await dialog.waitFor({ timeout: 10_000 })
  await dialog.getByRole('button', { name: 'Edit path' }).click()
  const pathInput = dialog.getByRole('textbox', { name: 'Edit path' })
  await pathInput.fill(join(root, name))
  await pathInput.press('Enter')
  await dialog.getByRole('button', { name: 'Open', exact: true }).click()
  // The pick connected the workspace: the blank session's live composer
  // replaces the locked placeholder and enables.
  await page.locator('[data-composer-input][contenteditable="true"][data-placeholder="Describe what you want to build, / commands, @ files or sessions"]')
    .waitFor({ timeout: 15_000 })
}

/**
 * {@link connectFreshWorkspace} over a page that advertises
 * {@link ZH_BROWSER_LOCALE}: the English helper's anchors assume the locale
 * most other scenarios boot, so a scenario that deliberately keeps zh needs
 * the localized picker copy.
 * @param page - the browser page under test.
 * @param root - workspace parent directory.
 * @param name - directory created under `root` and connected.
 * @param modelAvailable - require an editable composer when the selected model is available.
 */
export async function connectFreshWorkspaceZh(page: Page, root: string, name = 'workspace', modelAvailable = true): Promise<void> {
  mkdirSync(join(root, name), { recursive: true })
  await page.getByRole('textbox', { name: '选择工作区' }).click()
  const dialog = page.getByRole('dialog', { name: '选择工作区目录' })
  await dialog.waitFor({ timeout: 10_000 })
  await dialog.getByRole('button', { name: '编辑路径' }).click()
  const pathInput = dialog.getByRole('textbox', { name: '编辑路径' })
  await pathInput.fill(join(root, name))
  await pathInput.press('Enter')
  await dialog.getByRole('button', { name: '打开', exact: true }).click()
  const editable = modelAvailable ? '[contenteditable="true"]' : ''
  await page.locator(`[data-composer-input]${editable}[data-placeholder="描述你想要构建的内容, / 调用指令, @ 文件或对话"]`)
    .waitFor({ timeout: 15_000 })
}

/**
 * Replace the composer draft through per-key gestures. `fill()` issues
 * select-all and insertText inside one task; directly after a trigger-menu or
 * chip interaction Lexical's internal selection has not yet absorbed the DOM
 * selection, and the batched edit lands on a null selection and is silently
 * dropped, leaving the previous draft in place. Real keystrokes leave room for
 * `selectionchange` between keys, which is also what a user's typing does.
 *
 * Waits for the surface to be editable first. While the input machine is
 * adjudicating or submitting a send — and in every locked state (removed
 * session, no workspace, an owner block) — the composer renders read-only
 * with `contenteditable="false"` on the same element. `fill()` throws
 * immediately on that element, and `isEnabled()` reports `true` for a
 * `<div>` regardless of the attribute — so a gesture directly after a
 * submit must gate on the attribute, not on enablement. A running turn by
 * itself keeps the composer editable (that is what queueing types into).
 * @param page - the page under test.
 * @param input - the `[data-composer-input]` surface locator.
 * @param text - the replacement draft; `''` clears the draft. Must not
 * contain a newline: typed Enter submits the composer.
 */
export async function writeComposerDraft(
  page: Page,
  input: ReturnType<Page['locator']>,
  text: string,
): Promise<void> {
  await input.and(page.locator('[contenteditable="true"]')).waitFor({ timeout: 15_000 })
  await input.click()
  await page.keyboard.press('ControlOrMeta+A')
  if (text === '') await page.keyboard.press('Backspace')
  else await page.keyboard.type(text)
}

/** Failure evidence goes to the gitignored .artifacts/ (repo convention). */
export async function saveFailureShot(page: Page, name: string): Promise<void> {
  const dir = fileURLToPath(new URL('../../../.artifacts', import.meta.url))
  mkdirSync(dir, { recursive: true })
  try {
    await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true })
  } catch {
    // Best-effort evidence: a dead page/browser at failure time must not mask the real assertion error.
  }
}

/**
 * Assert a visible tooltip paints above the element a user would read through
 * it, at the bubble's center and bottom edge. The bubble ignores pointer events
 * by design, so the measurement enables them for its own duration; each probe
 * reports the bubble or the covering element, so a failure names its cover.
 * @param tooltip - locator for the visible `[role="tooltip"]` bubble.
 */
export async function expectTooltipOnTop(tooltip: Locator): Promise<void> {
  const probes = await tooltip.evaluate((bubble) => {
    const rect = bubble.getBoundingClientRect()
    const previous = bubble.style.pointerEvents
    bubble.style.pointerEvents = 'auto'
    const probe = (y: number): string => {
      const hit = document.elementFromPoint(rect.left + rect.width / 2, y)
      if (hit === null) return 'none'
      return bubble.contains(hit) ? 'tooltip' : `${hit.tagName}.${hit.classList.value}`.slice(0, 120)
    }
    const probes = { center: probe(rect.top + rect.height / 2), bottom: probe(rect.bottom - 1) }
    bubble.style.pointerEvents = previous
    return probes
  })
  expect(probes).toEqual({ center: 'tooltip', bottom: 'tooltip' })
}

/**
 * The conversation engine's Context key format, restated here rather than
 * imported: these specs live in the Host compiler aggregate, which must not
 * reach the Client plane. The engine's own copy is
 * `conversationContextKey` in ui-conversation; a drift between them makes
 * the key miss its rendered node, so the assertion fails loudly.
 * @param kind - Definition kind.
 * @param id - Definition-local business identity.
 * @returns the engine-owned Context key.
 */
export function conversationContextKey(kind: string, id: string): string {
  return `${kind.length}:${kind}${id}`
}

/** Open Settings through the Web gear or Desktop account menu.
 * @param page - browser page with the mounted sidebar.
 * @param locale - current UI language.
 */
export async function openSettings(page: Page, locale: 'en' | 'zh'): Promise<void> {
  const label = locale === 'zh' ? '设置' : 'Settings'
  if (await page.evaluate(() => 'dshDesktop' in globalThis)) {
    await page.getByRole('button', { name: locale === 'zh' ? '账号菜单' : 'Account menu', exact: true }).click()
    await page.getByRole('menuitem', { name: label, exact: true }).click()
  } else {
    await page.getByRole('button', { name: label, exact: true }).click()
  }
}
