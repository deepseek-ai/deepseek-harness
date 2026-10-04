/** The optional Inspector renders a recorded Session through the shipped Web composition. */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold,
  seedSession, selectedSessionFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const directory = fileURLToPath(new URL('../../../snapshots/web/session-inspector', import.meta.url))
const fixture = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v4.jsonl', import.meta.url))
const bundle = fileURLToPath(new URL('../../../packages/experimental/inspector-profile', import.meta.url))
const picker = fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url))

it.skipIf(webSnapshotMode() === 'record')('inspects a replayed Session log and Chat groups through the optional bundle', async () => {
  const resources: { browser?: Browser; scaffold?: WebScaffold } = {}
  onTestFinished(async () => {
    try { await resources.browser?.close() } finally { await resources.scaffold?.close() }
  })
  const replayFixture = await selectedSessionFixture(fixture, false)
  const prompts = fixtureUserPrompts(await readFile(replayFixture, 'utf8'))
  expect(prompts).toHaveLength(1)
  const scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: bundle, enabled: true }], hmr: false },
    extraOverlayPath: picker, replayFixture, compareReplaySession: 'read-only', paceMs: 5,
  })
  resources.scaffold = scaffold
  const browser = await chromium.launch()
  resources.browser = browser
  const page = await newEnglishPage(browser)
  await page.setViewportSize({ width: 1680, height: 1000 })
  const tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const settled = scaffold.whenTurnSettled()
  const input = page.locator('[data-composer-input]').first()
  await input.fill(prompts[0]!)
  await input.press('Enter')
  await settled
  await page.getByText('DONE', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
  await page.locator('[data-sidebar-right-guide-entry="session-inspector-log"]').click()
  const mode = page.getByRole('combobox', { name: 'Presentation', exact: true })
  expect(await mode.inputValue()).toBe('session-log')
  const raw = page.getByRole('table', { name: 'Raw Log', exact: true })
  await raw.getByRole('button', { name: 'Filter types', exact: true }).click()
  await page.getByRole('combobox', { name: 'Type keyword', exact: true }).fill('user/message')
  await page.getByRole('option', { name: 'user/message', exact: true }).click()
  await raw.getByRole('button', { name: 'user/message', exact: true }).first().click()
  const panel = page.locator('section[aria-label="Raw Log"]')
  const details = panel.getByRole('separator').locator('..').locator('ul').first()
  expect(await details.innerText()).toContain(prompts[0])
  expect(await details.locator('details:not([open])').count()).toBe(0)
  expect(await panel.getByRole('navigation').count()).toBe(0)
  const expansion = await details.locator('details').evaluateAll(nodes => nodes.map(node =>
    `- ${node.querySelector('summary')?.textContent?.trim()}: ${node.hasAttribute('open') ? 'expanded' : 'collapsed'}`))
  await compareOrRefreshGolden(join(directory, 'raw-data.expected.md'), expansion.join('\n'), webSnapshotMode())
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  const times = await raw.locator('tbody tr td:nth-child(4)').allTextContents()
  const replacements = [...new Set(times)].filter(value => /^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(value))
    .map(value => [value, '{{time}}'] as const)
  await compareOrRefreshGolden(join(directory, 'log.expected.md'),
    await captureStableAria(page, 'section[aria-label="Raw Log"] table', scaffold.workspaceCwd, { replacements }), webSnapshotMode())
  await mode.selectOption('chat-node')
  const groups = page.getByRole('table', { name: 'Chat Group', exact: true })
  expect(await groups.getByRole('columnheader', { name: 'Time (UTC)' }).count()).toBe(0)
  await groups.getByRole('button', { name: 'assistant-step', exact: true }).first().click()
  await page.getByRole('navigation', { name: 'Raw data navigation', exact: true }).waitFor()
  const groupPanel = page.locator('section[aria-label="Chat Group"]')
  await groupPanel.locator('summary').filter({ hasText: 'Node Data' }).click()
  const blocks = groupPanel.getByText('blocks:', { exact: true }).locator('..')
  await blocks.click()
  await blocks.locator('..').getByText('Other properties:', { exact: true }).waitFor()
  await compareOrRefreshGolden(join(directory, 'array-details.expected.md'), await blocks.locator('..').ariaSnapshot(), webSnapshotMode())
  await groupPanel.getByRole('button', { name: 'Close', exact: true }).click()
  const kinds = await groups.locator('tbody tr td:nth-child(2) button:not([aria-label])').allTextContents()
  expect(kinds.at(-1)).toBe('turn-tail')
  await compareOrRefreshGolden(join(directory, 'groups.expected.md'), kinds.map(kind => `- ${kind}`).join('\n'), webSnapshotMode())
  expect(tripwire.pageErrors).toEqual([])
  await assertFixtureInventory(directory, ['log.expected.md', 'groups.expected.md', 'array-details.expected.md', 'navigation.expected.md', 'raw-data.expected.md'])
})

it.skipIf(webSnapshotMode() === 'record')('highlights nearby Chat content when the selected recorded call is not displayed', async () => {
  const resources: { browser?: Browser; scaffold?: WebScaffold } = {}
  onTestFinished(async () => {
    try { await resources.browser?.close() } finally { await resources.scaffold?.close() }
  })
  const scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: bundle, enabled: true }], hmr: false }, extraOverlayPath: picker,
  })
  resources.scaffold = scaffold
  await seedSession(scaffold, await readFile(await selectedSessionFixture(fixture), 'utf8'), 'inspector-navigation')
  const browser = await chromium.launch()
  resources.browser = browser
  const page = await newEnglishPage(browser)
  const tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('treeitem').first().click()
  await page.getByRole('treeitem').nth(1).click()
  await page.getByText('DONE', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
  await page.locator('[data-sidebar-right-guide-entry="session-inspector-log"]').click()
  const table = page.getByRole('table', { name: 'Raw Log', exact: true })
  await table.getByRole('button', { name: 'Filter types', exact: true }).click()
  await page.getByRole('combobox', { name: 'Type keyword', exact: true }).fill('tool/call')
  await page.getByRole('button', { name: 'Apply filter', exact: true }).click()
  const tool = page.locator('[data-slot="main.conversation"] [data-chat-flow-kind="tool-call"]')
  expect(await tool.count()).toBe(1)
  // The log and model identity remain available while its rendered occurrence has no box.
  await tool.evaluate((element) => { element.style.display = 'none' })
  await page.evaluate(() => {
    Reflect.set(window, '__inspectorNavigationResult', undefined)
    // Preserve the transient overlay's target even if a busy runner reads after its animation ends.
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const added of record.addedNodes) {
          if (!(added instanceof HTMLElement) || added.dataset.sessionInspectorHighlight !== 'reveal') continue
          const box = added.getBoundingClientRect()
          const hits = document.elementsFromPoint(box.x + box.width / 2, box.y + box.height / 2)
          const node = hits.map(hit => hit.closest<HTMLElement>('[data-chat-node-key]')).find(value => value !== null)
          const bounds = node?.getBoundingClientRect()
          Reflect.set(window, '__inspectorNavigationResult', {
            kind: node?.dataset.chatFlowKind, part: node?.dataset.chatGroupPart,
            visible: box.width > 0 && box.height > 0,
            matchesNodeBox: bounds !== undefined && (['x', 'y', 'width', 'height'] as const)
              .every(key => Math.abs(box[key] - bounds[key]) < 0.5),
          })
          observer.disconnect()
          return
        }
      }
    })
    observer.observe(document.body, { childList: true })
  })
  await table.getByRole('button', { name: 'tool/call', exact: true }).click()
  await page.waitForFunction(() => Reflect.get(window, '__inspectorNavigationResult') !== undefined)
  const result = await page.evaluate(() => Reflect.get(window, '__inspectorNavigationResult') as {
    kind: string
    part?: string
    visible: boolean
    matchesNodeBox: boolean
  })
  expect(result).toEqual({ kind: 'assistant-step', part: 'reasoning', visible: true, matchesNodeBox: true })
  await compareOrRefreshGolden(join(directory, 'navigation.expected.md'), [
    '- selected: tool/call', '- unavailable: tool-call',
    `- highlighted: ${result.kind}/${result.part ?? 'whole'}`, `- visible: ${String(result.visible)}`,
    `- bounds match highlighted node: ${String(result.matchesNodeBox)}`,
  ].join('\n'), webSnapshotMode())
  expect(tripwire.pageErrors).toEqual([])
})
