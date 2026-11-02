/** Built settings UI uses the shell file API; external edits wait for a new shell startup. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { DesktopUpdateSettings } from '../../desktop/src/update-settings.ts'
import type { DesktopChannelState, DesktopChannelChangeResult } from '../../desktop/src/ipc.ts'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { openSettings } from './support.ts'

it('persists a Desktop channel from Settings and keeps external edits startup-only', async () => {
  const scaffold = await launchWebScaffold({})
  try {
    const browser = await chromium.launch()
    try {
      const settings = new DesktopUpdateSettings(join(scaffold.harnessHome, 'shell'), 'nightly')
      await settings.save('nightly')
      let state: DesktopChannelState = { channel: 'nightly', packagedChannel: 'nightly', changing: false }
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })
      const tripwire = watchConsole(page)
      let detailOpens = 0
      await page.exposeFunction('openUpdateDetails', () => { detailOpens++ })
      await page.exposeFunction('readChannel', () => state)
      await page.exposeFunction('setChannel', async (channel: 'nightly' | 'stable'): Promise<DesktopChannelChangeResult> => {
        try {
          await settings.save(channel)
          state = { ...state, channel, error: undefined }
          return { kind: 'applied', state }
        } catch (_error) { return { kind: 'failed', state, reason: 'format' } }
      })
      await page.addInitScript(() => {
        const bridge = globalThis as typeof globalThis & {
          readChannel(): Promise<DesktopChannelState>
          openUpdateDetails(): Promise<void>
          setChannel(channel: 'nightly' | 'stable'): Promise<DesktopChannelChangeResult>
        }
        Object.assign(globalThis, { dshDesktop: { protocolVersion: 1, updates: {
          status: async () => ({ phase: 'idle' }), open: () => bridge.openUpdateDetails(), subscribe: () => () => {},
          channels: { get: () => bridge.readChannel(), set: (channel: 'nightly' | 'stable') => bridge.setChannel(channel),
            subscribe: () => () => {} },
        } } })
      })
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await openSettings(page, 'en')
      const row = page.getByRole('group', { name: 'Update channel', exact: true })
      await row.getByText('Development', { exact: true }).waitFor()
      await row.getByRole('button', { name: 'Update channel', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Stable', exact: true }).click()
      await row.getByText('Stable', { exact: true }).waitFor()
      await page.getByText('Update channel changed', { exact: true }).waitFor()
      expect(JSON.parse(await readFile(settings.path, 'utf8'))).toMatchObject({ updates: { channel: 'stable' } })
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/desktop-channel/stable.expected.md', import.meta.url)),
        await captureStableAria(page, '[role="group"][aria-label="Update channel"]', scaffold.workspaceCwd), webSnapshotMode())
      await writeFile(settings.path, JSON.stringify({ updates: { channel: 'nightly' } }))
      expect(await row.getByText('Stable', { exact: true }).count()).toBe(1)
      expect(await settings.load()).toEqual({ kind: 'ready', channel: 'nightly' })
      await writeFile(settings.path, '{broken')
      await row.getByRole('button', { name: 'Update channel', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Development', exact: true }).click()
      await page.getByText('Could not save: invalid settings file', { exact: true }).waitFor()
      await row.getByText('Stable', { exact: true }).waitFor()
      expect(await row.getByText('Stable', { exact: true }).count()).toBe(1)
      expect(await readFile(settings.path, 'utf8')).toBe('{broken')
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/desktop-channel/save-error.expected.md', import.meta.url)),
        await captureStableAria(page, '[role="group"][aria-label="Update channel"]', scaffold.workspaceCwd) + '\n'
          + await captureStableAria(page, '[role="alert"]', scaffold.workspaceCwd), webSnapshotMode())
      state = { ...state, error: 'format' }
      await page.reload({ waitUntil: 'load' })
      await page.getByRole('alert').filter({ hasText: 'Settings file error; updates are paused' }).waitFor()
      await page.getByRole('button', { name: 'View details', exact: true }).click()
      await expect.poll(() => detailOpens).toBe(1)
      expect(await readFile(settings.path, 'utf8')).toBe('{broken')
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    } finally { await browser.close() }
  } finally { await scaffold.close() }
})
