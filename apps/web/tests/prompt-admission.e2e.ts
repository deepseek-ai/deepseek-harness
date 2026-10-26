// Keyless browser coverage for Host acceptance through the shipped Web
// composition and the real wire: while the prompt request of a sent message is
// held, the composer stays read-only behind the sending control and Chat shows
// no echo; once the Host accepts the prompt the composer clears and takes the
// keyboard back. queue-actions covers a refused prompt keeping its draft.
import { fileURLToPath } from 'node:url'
import type { Browser, Route } from 'playwright'
import { chromium } from 'playwright'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/live-interactions/session.v3.jsonl', import.meta.url))
const MODE = webSnapshotMode()

const HELD = 'Message held until the Host accepts it'
const FOLLOW_UP = 'Typed once the message was accepted'

describe('web e2e: prompt admission', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined

  afterEach(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    browser = undefined
    const closing = scaffold
    scaffold = undefined
    await closing?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'prompt-admission teardown failed')
  })

  it.skipIf(MODE === 'record')('holds a message in the read-only composer until the Host accepts it', async () => {
    const sessionEvents: SessionEvent[] = []
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE, compareReplaySession: false })
    const host = scaffold
    host.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    const userMessages = (): number => sessionEvents
      .filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length
    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    await page.goto(host.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, host.workspaceCwd)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-prompt-admission'))
    const input = page.locator('[data-composer-input]').first()

    const held = Promise.withResolvers<Route>()
    await page.route('**/api/session/prompt', (route) => { held.resolve(route) }, { times: 1 })
    await input.fill(HELD)
    await input.press('Enter')
    const prompt = await held.promise
    const sending = page.getByRole('button', { name: 'Sending message', exact: true })
    await expect.poll(() => sending.getAttribute('aria-busy')).toBe('true')
    expect(await input.getAttribute('contenteditable')).toBe('false')
    expect(await input.textContent()).toBe(HELD)
    expect(await page.locator('[data-submission-echo]').count()).toBe(0)
    expect(userMessages()).toBe(0)

    const settled = host.whenTurnSettled()
    await prompt.continue()
    await settled
    await expect.poll(() => input.textContent()).toBe('')
    expect(await input.getAttribute('contenteditable')).toBe('true')
    // The keyboard returns to the composer, so the next message can be typed at once.
    await page.keyboard.type(FOLLOW_UP)
    await expect.poll(() => input.textContent()).toBe(FOLLOW_UP)
    await page.locator('[data-chat-flow-kind="user"]', { hasText: HELD }).waitFor()
    expect(userMessages()).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
  })
})
