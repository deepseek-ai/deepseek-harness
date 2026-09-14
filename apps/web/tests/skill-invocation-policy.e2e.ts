// Web e2e scenario: the real host serves every user-invocable skill to the
// browser slash source — user-only (disable-model-invocation) entries appear
// with their marker while user-disabled quadrants stay hidden. A real
// chromium connects a fresh workspace seeded with all four policy quadrants;
// no model call is issued, so a stray stream fails loud on the open LLM seam.
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/skill-invocation-policy', import.meta.url))
const MENU_EXPECTED = join(SNAPSHOT_DIR, 'menu.expected.md')
const FUZZY_MENU_EXPECTED = join(SNAPSHOT_DIR, 'menu-fuzzy.expected.md')
const MODE = webSnapshotMode()

interface SeedSkill {
  name: string
  description: string
  frontmatter: string
}

const SKILLS: readonly SeedSkill[] = [
  {
    name: 'policy-shared',
    description: 'Available to both model and user invocation',
    frontmatter: '',
  },
  {
    name: 'policy-model-only',
    description: 'Available only to model invocation',
    frontmatter: 'user-invocable: false\n',
  },
  {
    name: 'policy-user-only',
    description: 'Available only to user invocation',
    frontmatter: 'disable-model-invocation: true\n',
  },
  {
    name: 'policy-trusted-only',
    description: 'Available only to trusted internal callers',
    frontmatter: 'disable-model-invocation: true\nuser-invocable: false\n',
  },
]

async function seedSkills(workspaceCwd: string): Promise<void> {
  for (const skill of SKILLS) {
    const root = join(workspaceCwd, 'workspace', '.agents', 'skills')
    const directory = skill.name === 'policy-shared' ? join(workspaceCwd, 'linked-skills', skill.name) : join(root, skill.name)
    await mkdir(directory, { recursive: true })
    const policyLines = skill.frontmatter === '' ? [] : skill.frontmatter.trimEnd().split('\n')
    await writeFile(join(directory, 'SKILL.md'), [
      '---',
      `name: ${skill.name}`,
      `description: ${skill.description}`,
      ...policyLines,
      '---',
      '',
      `# ${skill.name}`,
      '',
    ].join('\n'))
    if (skill.name === 'policy-shared') {
      await mkdir(root, { recursive: true })
      await symlink(join(directory, 'SKILL.md'), join(root, `${skill.name}.md`))
    }
  }
}

describe('web e2e: skill invocation policy through the real host', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSkills(scaffold.workspaceCwd)
    await writeFile(join(scaffold.workspaceCwd, 'workspace', 'meeting-notes.md'), '# Meeting notes\n\nReference preview fixture.\n')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('renders every user-invocable skill and marks the user-only entry', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-skill-invocation-policy'))
    const input = page.locator('[data-composer-input]').first()
    await input.fill('/policy')
    const menu = page.getByRole('listbox', { name: 'Trigger suggestions' })
    await expect.poll(
      () => menu.getByRole('option', { name: /policy-shared/ }).count(),
      { timeout: 10_000 },
    ).toBe(1)

    // The user-only quadrant is invocable here — its only entry point — and
    // wears the user-only marker; both user-disabled quadrants stay hidden.
    expect(await menu.getByRole('option', { name: /policy-user-only user-only · / }).count()).toBe(1)
    expect(await menu.getByRole('option', { name: /policy-model-only/ }).count()).toBe(0)
    expect(await menu.getByRole('option', { name: /policy-trusted-only/ }).count()).toBe(0)

    const snapshot = await captureStableAria(page, '[role="listbox"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(MENU_EXPECTED, snapshot, MODE)

    // Discovery needs no prefix: an in-order subsequence of one skill name
    // ranks that skill alone, through the ranker the command group uses.
    await writeComposerDraft(page, input, '/plcyusr')
    await expect.poll(() => menu.getByRole('option').count(), { timeout: 10_000 }).toBe(1)
    expect(await menu.getByRole('option', { name: /policy-user-only/ }).count()).toBe(1)
    const fuzzySnapshot = await captureStableAria(page, '[role="listbox"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(FUZZY_MENU_EXPECTED, fuzzySnapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['menu-fuzzy.expected.md', 'menu.expected.md', 'preview.expected.md'])
  })

  it('opens skill and file references beside the unchanged draft with matching hover backgrounds', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-reference-preview'))
    const input = page.locator('[data-composer-input]').first()
    await writeComposerDraft(page, input, '/policy-shared hello @meeting-notes')
    const menu = page.getByRole('listbox', { name: 'Trigger suggestions' })
    const option = menu.getByRole('option', { name: /meeting-notes\.md/ })
    await option.click()
    const skill = input.locator('[data-composer-text-ref]').filter({ hasText: '/policy-shared' })
    const file = input.locator('[data-composer-chip]')
    const draft = await input.textContent()
    const alignment = await input.evaluate((el) => {
      const skill = el.querySelector<HTMLElement>('[data-composer-text-ref]')!
      const chip = el.querySelector<HTMLElement>('[data-composer-chip] span')!
      const plain = el.querySelector<HTMLElement>('[data-lexical-text]:not([data-composer-text-ref])')!
      const textTop = (element: Element): number => {
        const range = el.ownerDocument.createRange()
        range.selectNodeContents(element)
        return range.getBoundingClientRect().top
      }
      return {
        skillTop: skill.getBoundingClientRect().top,
        fileTop: chip.getBoundingClientRect().top,
        skillHeight: skill.getBoundingClientRect().height,
        fileHeight: chip.getBoundingClientRect().height,
        skillTextTop: textTop(skill),
        fileTextTop: textTop(chip.lastElementChild!),
        plainTextTop: textTop(plain),
      }
    })
    expect(alignment.fileHeight).toBeCloseTo(alignment.skillHeight, 0)
    expect(alignment.fileTop).toBeCloseTo(alignment.skillTop, 0)
    expect(alignment.fileTextTop).toBeCloseTo(alignment.plainTextTop, 0)
    expect(alignment.skillTextTop).toBeCloseTo(alignment.plainTextTop, 0)
    await skill.hover()
    const skillBackground = await skill.evaluate(el => getComputedStyle(el).backgroundColor)
    expect(skillBackground).not.toBe('rgba(0, 0, 0, 0)')
    await skill.click()
    const preview = page.locator('[data-document-markdown]')
    await expect.poll(() => preview.textContent()).toContain('policy-shared')
    expect(await input.textContent()).toBe(draft)
    const snapshot = await captureStableAria(page, '[data-document-markdown]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'preview.expected.md'), snapshot, MODE)
    await file.hover()
    expect(await file.locator('span').first().evaluate(el => getComputedStyle(el).backgroundColor)).toBe(skillBackground)
    await file.click()
    await expect.poll(() => preview.textContent()).toContain('Reference preview fixture.')
    expect(await input.textContent()).toBe(draft)
    await file.hover()
    await skill.dblclick()
    await expect.poll(() => preview.textContent()).toContain('policy-shared')
    await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).not.toBe('')
    expect(await input.textContent()).toBe(draft)
    await skill.hover()
    await expect.poll(() => skill.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(skillBackground)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    // Establish the deletion caret before the key event; Chromium delivers
    // native selectionchange asynchronously after pointer and arrow actions.
    await input.evaluate((el) => {
      el.focus()
      const selection = el.ownerDocument.getSelection()!
      selection.selectAllChildren(el)
      selection.collapseToEnd()
      el.ownerDocument.dispatchEvent(new Event('selectionchange'))
    })
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace')
    await expect.poll(() => input.locator('[data-composer-chip]').count()).toBe(0)
    expect(await input.textContent()).toContain('/policy-shared')
  })
})
