/** The shipped composer preserves drafts when an application Enter chord has extra modifiers. */
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

it('preserves the composer draft and menu for application Enter combinations', async () => {
  const scaffold = await launchWebScaffold({})
  const events: SessionEvent[] = []
  const off = scaffold.ctx.on('session/event', (_session, event) => { events.push(event) })
  try {
    const browser = await chromium.launch()
    let failurePage: Page | undefined
    try {
      const page = await newEnglishPage(browser)
      failurePage = page
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl)
      await connectFreshWorkspace(page, scaffold.workspaceCwd, 'composer-shortcuts')
      const input = page.locator('[data-composer-input][contenteditable="true"]').first()
      for (const draft of ['unsent draft', '/']) {
        await writeComposerDraft(page, input, draft)
        const markup = await input.innerHTML()
        for (const chord of ['Alt+Enter', 'Meta+Alt+Enter', 'Control+Alt+Enter', 'Control+Meta+Enter', 'Meta+Shift+Enter', 'Control+Shift+Enter']) {
          await input.press(chord)
          expect(await input.innerHTML(), `${draft}: ${chord}`).toBe(markup)
        }
        await input.press('Escape')
      }
      await writeComposerDraft(page, input, 'first line')
      await input.press('Shift+Enter')
      await page.keyboard.type('second line')
      expect(await input.innerText()).toBe('first line\nsecond line')
      expect(events.filter(event => event.type === 'user/message')).toHaveLength(0)
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    } catch (error) {
      if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-composer-shortcuts')
      throw error
    } finally {
      await browser.close()
    }
  } finally {
    off()
    await scaffold.close()
  }
})
