/** An explicit New Session the Host refuses reports through the Workspace notice in the shipped Web composition. */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { describe, expect, it, onTestFinished } from 'vitest'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const NOTICE_EXPECTED = fileURLToPath(new URL('./expected/new-session-refused/notice.expected.md', import.meta.url))
const MODE = webSnapshotMode()
/** The default preset of this lane: its one row names a package the Host cannot resolve, as a preset copied before a plugin rename does. */
const PRESET_ID = 'renamed-plugin'

/** The default preset of this lane as a declaration: its one row names a package the Host cannot resolve. */
const BROKEN_PRESET = {
  id: PRESET_ID,
  name: 'Renamed plugin',
  description: 'Names a plugin that no longer resolves.',
  plugins: [{ id: 'ghost', name: '@deepseek-ai/dsh-no-such-plugin' }],
}

describe.skipIf(MODE === 'record')('web e2e: refused New Session', () => {
  it('shows the Host refusal as a notice and leaves the Workspace without a Session', async () => {
    const scaffold = await launchWebScaffold({
      firstUse: true,
      agentPresets: { default: PRESET_ID, definitions: [BROKEN_PRESET] },
    })
    onTestFinished(() => scaffold.close())
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
      const tripwire = watchConsole(page)
      try {
        await page.goto(scaffold.authenticatedUrl)
        // Startup prepares the default Workspace, and its own blank-Session
        // attempt is refused without a notice: the hero stays on the picker.
        await page.getByRole('button', { name: '选择工作区', exact: true }).waitFor()
        await expect.poll(() => scaffold.ctx.workspaceRegistry.list().length).toBe(1)
        expect(scaffold.ctx.sessions.list()).toEqual([])
        expect(await page.getByRole('alert').count()).toBe(0)

        await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
        const notice = page.getByRole('alert').filter({ hasText: '新建会话失败' })
        await notice.waitFor()
        await compareOrRefreshGolden(NOTICE_EXPECTED, await notice.ariaSnapshot(), MODE)
        expect(scaffold.ctx.sessions.list()).toEqual([])
        expect(scaffold.ctx.workspaceRegistry.list()).toHaveLength(1)
        expect(await page.locator('[data-composer-input][contenteditable="true"]').count()).toBe(0)
        expect(tripwire.pageErrors).toEqual([])
        expect(tripwire.warnings).toEqual([])
      } catch (error) {
        await saveFailureShot(page, 'web-e2e-new-session-refused')
        throw error
      }
    } finally {
      await browser.close()
    }
  })
})
