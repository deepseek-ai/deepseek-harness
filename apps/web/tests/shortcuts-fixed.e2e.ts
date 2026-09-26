/** Fixed approval keys through the real browser, Remote waterfall and recorded model command. */
import { access, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'
import { fixtureUserPrompts, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/approval-composer/session.v3.jsonl', import.meta.url))

describe('web e2e: fixed approval rejection keys', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  afterEach(async () => {
    const results = await Promise.allSettled([browser?.close(), scaffold?.close()])
    browser = undefined
    scaffold = undefined
    const failed = results.filter(result => result.status === 'rejected')
    if (failed.length > 0) throw new AggregateError(failed.map((result): unknown => result.reason), 'fixed shortcut teardown failed')
  })

  it.skipIf(webSnapshotMode() === 'record').each(['reject-button-enter', 'container-escape'] as const)(
    'rejects through %s without running the requested write', async (method) => {
      const events: SessionEvent[] = []
      scaffold = await launchWebScaffold({ replayFixture: FIXTURE, compareReplaySession: false })
      scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { events.push(event) })
      browser = await chromium.launch()
      page = await newEnglishPage(browser)
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await connectFreshWorkspace(page, scaffold.workspaceCwd)
      await page.locator('[aria-label^="Access mode"]').click()
      await page.getByRole('menuitem', { name: 'Read Only' }).click()
      await page.locator('[aria-label="Access mode, current: Read Only"]').waitFor()
      const input = page.locator('[data-composer-input]').first()
      const prompts = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
      expect(prompts).toHaveLength(1)
      const settled = scaffold.whenTurnSettled()
      await input.fill(prompts[0]!)
      await input.press('Enter')
      const panel = page.locator('[data-approval-key]')
      await panel.waitFor()
      if (method === 'reject-button-enter') {
        await panel.getByRole('button', { name: 'Reject', exact: true }).focus()
        await page.keyboard.press('Enter')
      } else {
        await panel.locator('[data-approval-scroll]').focus()
        await page.keyboard.press('Escape')
      }
      await settled
      expect(events.filter(event => event.type === 'approval/decided').map(event => event.data))
        .toMatchObject([{ outcome: 'rejected' }])
      expect(events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind))
        .toEqual(['completed'])
      await expect(access(join(scaffold.workspaceCwd, 'workspace', 'notes.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await panel.count()).toBe(0)
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    },
  )
})
