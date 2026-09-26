/** Global navigation before the first Session, through the shipped Web composition. */
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'
import { initialShortcutConfig } from '@deepseek-ai/dsh-client-shortcuts/protocol'

let scaffold: WebScaffold
let browser: Browser

beforeAll(async () => {
  scaffold = await launchWebScaffold()
  browser = await chromium.launch()
})

afterAll(async () => {
  try { await browser?.close() }
  finally { await scaffold?.close() }
})

describe('navigation without a selected Session', () => {
  it.each(['web', 'win32', 'linux', 'darwin'] as const)('%s preserves its empty-header geometry and sidebar access', async (platform) => {
    const page = await newEnglishPage(browser)
    try {
      if (platform !== 'web') {
        await page.addInitScript(({ value, snapshot }) => {
          Object.assign(window, { dshDesktop: { protocolVersion: 1,
            keyboard: { subscribe: () => () => {}, closeWindow: async () => {} },
            shortcuts: { get: async () => ({ ...snapshot, status: 'ready' }),
              subscribe: () => () => {}, recording: async () => {},
              edit: async () => ({ status: 'not-ready', snapshot }) },
          } })
          const mark = () => { document.documentElement.setAttribute('data-platform', value) }
          if (document.documentElement === null) document.addEventListener('DOMContentLoaded', mark, { once: true })
          else mark()
        }, { value: platform, snapshot: initialShortcutConfig() })
      }
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.getByRole('textbox', { name: 'Choose workspace', exact: true }).waitFor()
      const sessionHeader = page.locator('[data-slot="conversation.session.header"]')
      expect(await sessionHeader.count()).toBe(0)
      const header = page.locator('[data-slot="conversation.header"] > header')
      expect(await header.evaluate(element => element.getBoundingClientRect().height)).toBe(platform === 'darwin' ? 40 : 0)
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
      const reopen = platform === 'darwin'
        ? page.locator('[data-shell-leading]').getByRole('button', { name: 'Open sidebar', exact: true })
        : page.getByRole('button', { name: 'Open sidebar', exact: true })
      await reopen.waitFor({ state: 'visible' })
      expect(await sessionHeader.count()).toBe(0)
      expect(await header.evaluate(element => element.getBoundingClientRect().height)).toBe(platform === 'darwin' ? 40 : 0)
      if (platform === 'darwin') {
        expect(await page.locator('[data-shell-leading]').getByRole('button', { name: 'New session', exact: true }).isVisible()).toBe(true)
      }
      // The open label precedes both the column slide and the rail's mount animation.
      // Reverse the pointer action only after the rendered sidebar has settled.
      const sidebarSettled = () => page.locator('[data-sidebar-collapsed]').evaluate((frame: HTMLElement) =>
        Number.parseFloat(getComputedStyle(frame).gridTemplateColumns) === Number.parseFloat(frame.style.gridTemplateColumns)
        && frame.getAnimations({ subtree: true }).every(animation => animation.playState === 'finished' || animation.playState === 'idle'))
      await expect.poll(sidebarSettled, { timeout: 30_000 }).toBe(true)
      await reopen.click()
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).waitFor({ state: 'visible' })
      expect(await sessionHeader.count()).toBe(0)
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    } catch (error) {
      await saveFailureShot(page, `sessionless-header-${platform}`)
      throw error
    } finally {
      await page.close()
    }
  })
})
