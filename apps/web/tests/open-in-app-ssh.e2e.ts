/** SSH launch behavior over a recorded conversation and the shipped Web plugin rows. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/open-in-app-ssh', import.meta.url))
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const SEED_ID = 'open-in-app-ssh-web-e2e'
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: Open In under SSH', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      openInAppEnvironment: createLaunchEnvironmentSnapshot([
        { source: 'process', values: { SSH_CONNECTION: '10.0.0.2 55000 10.0.0.9 22' } },
      ]),
    })
    await seedSession(scaffold, await readFile(SEED, 'utf8'), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.addInitScript(() => {
      localStorage.setItem('dsh.open-in-app.choice', JSON.stringify('vscode'))
    })
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length > 0) throw new AggregateError(failures, 'Open In SSH scenario teardown failed')
  })

  it('hides a remembered app after the real host returns an empty catalog', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-open-in-app-ssh'))
    const [response] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/open-in-app/apps'),
      (async () => {
        await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
        const group = page.getByRole('treeitem').first()
        await group.waitFor()
        if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
        await page.getByRole('treeitem').nth(1).click()
        await page.getByText('DONE', { exact: true }).waitFor()
      })(),
    ])
    expect(response.status()).toBe(200)
    expect(await response.json()).toEqual({ apps: [] })
    expect(await page.getByRole('button', { name: /^Open workspace in / }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Choose an app to open in', exact: true }).count()).toBe(0)
    expect(await page.evaluate(() => localStorage.getItem('dsh.open-in-app.choice'))).toBe('"vscode"')
    const snapshot = (await captureStableAria(page, 'role=banner', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'header.expected.md'), snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['header.expected.md'])
  })
})
