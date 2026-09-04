// Keyless browser regression for pwsh UI parity with bash: a seeded session
// whose pwsh call/result is presented by the REAL tool-pwsh on replay (the
// api-proxy recomputes presentation views from logged args/result content)
// must render with the same terminal card layout as bash and show the parsed exit-status
// pill — not a generic console-fenced card. The seed is authored, not
// recorded: its header line carries no `cwd`
// field (seedSession writes the session cwd itself, and a Windows temp path
// substituted into the header would not round-trip through its JSON parse),
// and no event references the workspace, so the lane replays on any host
// with a usable `pwsh` — the lane mounts the pwsh stack through an overlay
// (the shipped tree keeps the bash stack).
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  fixtureUserPrompts, launchWebScaffold, seedSession, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/pwsh-terminal', import.meta.url))
const SEED = join(SNAPSHOT_DIR, 'session.v2.jsonl')
const TERMINAL_EXPECTED = join(SNAPSHOT_DIR, 'terminal-card.expected.md')
const OVERLAY = fileURLToPath(new URL('./pwsh-terminal.overlay.yml', import.meta.url))
const PROMPT = 'Run a PowerShell command that fails, then stop.'
const SEED_ID = 'pwsh-terminal-web-e2e'
const MODE = webSnapshotMode()

// The overlay swaps the shipped bash executor for @deepseek-ai/dsh-pwsh-local;
// a host without a usable `pwsh` cannot boot it, so the lane self-skips,
// mirroring the pwshOnly ACP scenarios. The probe follows the executor's own
// resolution (Program Files installs on Windows are found even when bare
// `pwsh` is not on PATH), the same judgment the tool-pwsh tests reuse; record
// mode skips the lane anyway, so the probe stays inert there.
const HAS_PWSH = MODE === 'record' ? false : spawnSync(
  resolvePwshPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'],
  { encoding: 'utf8' },
).status === 0

describe.skipIf(MODE === 'record' || !HAS_PWSH)('web e2e: pwsh calls use the bash terminal-card layout', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    const fixture = await readFile(SEED, 'utf8')
    expect(fixtureUserPrompts(fixture), 'seed fixture must carry the single drive prompt').toEqual([PROMPT])
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    await seedSession(scaffold, fixture, SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('renders the seeded pwsh call as a terminal card with the parsed exit pill', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-pwsh-terminal'))
    // Open the seeded session through content search: the sidebar groups
    // sessions by workspace and its row order is world-dependent, while the
    // search index covers the seeded log deterministically. Search is a
    // collapsed header action; expand it so the input is actionable.
    const searchButton = page.getByRole('button', { name: 'Search sessions' })
    if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
    const search = page.getByPlaceholder('Search sessions', { exact: false })
    await search.fill('Run a PowerShell command')
    const result = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
    await expect.poll(() => result.count(), { timeout: 15_000 }).toBe(1)
    await result.click()
    await page.getByRole('tab', { name: 'Chat', exact: true }).waitFor({ timeout: 15_000 })
    // The tool row is expand-gated: the settled row uses the bash layout and carries the
    // shell-family variant, and the terminal card lives in the expanded body.
    const row = page.locator('[data-tool="pwsh"]').first()
    await row.waitFor({ timeout: 15_000 })
    if (await row.getAttribute('aria-expanded') !== 'true') await row.click()
    const card = page.locator('[data-terminal]').first()
    await card.waitFor({ timeout: 15_000 })
    // The parsed exit pill replaces the `[exit code: 1]` marker in the output
    // body — the bash tool's terminal presentation, not the generic fence.
    const text = await card.textContent()
    expect(text).toContain('exit code 1')
    expect(text).toContain('Get-Item : Cannot find path')
    expect(text).not.toContain('[exit code: 1]')
    const snapshot = (await captureStableAria(page, '[data-terminal]', scaffold.workspaceCwd))
      // normalizeAria collapses the workspace basename with a '/' split, which
      // misses Windows temp paths; collapse it here too (a no-op on POSIX) so
      // the golden is platform-independent.
      .split(scaffold.workspaceCwd.split(/[\\/]/).pop()!).join('{{workspace}}')
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(TERMINAL_EXPECTED, snapshot, MODE)
  }, 60_000)

  it('guards the lane fixture inventory', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v2.jsonl', 'terminal-card.expected.md'])
  })
})
