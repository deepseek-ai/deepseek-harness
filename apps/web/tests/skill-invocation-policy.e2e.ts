// Web e2e scenario: the real host serves every user-invocable skill to the
// browser slash source — user-only (disable-model-invocation) entries appear
// with their marker while user-disabled quadrants stay hidden. A real
// chromium connects a fresh workspace seeded with all four policy quadrants;
// no model call is issued, so a stray stream fails loud on the open LLM seam.
import { mkdir, writeFile } from 'node:fs/promises'
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
    const directory = join(workspaceCwd, 'workspace', '.agents', 'skills', skill.name)
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
    await assertFixtureInventory(SNAPSHOT_DIR, ['menu-fuzzy.expected.md', 'menu.expected.md'])
  })
})
