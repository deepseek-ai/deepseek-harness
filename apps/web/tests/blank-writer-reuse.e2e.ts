/** Blank Session writer acquisition through the shipped Web composition. */

import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const HELD = SessionId('blank-held')
const FREE = SessionId('blank-free')

describe.each([false, true])('web e2e: selected blank writer held: %s', (held) => {
  let scaffold: WebScaffold
  let browser: Browser
  let writer: SessionHandle | undefined
  const tripwires: ReturnType<typeof watchConsole>[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    for (const sessionId of [HELD, FREE]) {
      const handle = await scaffold.ctx.agents.create({
        sessionId,
        meta: { cwd: scaffold.workspaceCwd },
        agentOptions: scaffold.ctx.agentDefaultModel.currentSelection(),
      })
      try {
        handle.agent.session.append('plan/mode', { active: true })
        await workspace.attachSession(sessionId)
      } finally {
        await handle.dispose()
      }
    }
    if (held) writer = await scaffold.ctx.sessionPersistence.open(HELD, 'write')
    browser = await chromium.launch()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await writer?.close()
    await scaffold?.close()
  })

  async function openSavedBlank(sessionId = HELD): Promise<Page> {
    const page = await newEnglishPage(browser)
    tripwires.push(watchConsole(page))
    await page.addInitScript((id) => {
      localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id }))
    }, sessionId)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[data-composer-input]').first().waitFor({ timeout: 30_000 })
    return page
  }

  async function selected(page: Page): Promise<string | undefined> {
    return page.evaluate(() => {
      const value = localStorage.getItem('dsh.sessions.current')
      return value === null ? undefined : (JSON.parse(value) as { sessionId?: string }).sessionId
    })
  }

  it('reuses the selected blank or creates on contention without trying another blank', async () => {
    const first = await openSavedBlank()
    await expect.poll(async () => {
      const id = await selected(first)
      return id !== undefined && (!held || id !== HELD)
    }).toBe(true)
    const selectedId = SessionId((await selected(first))!)
    expect(selectedId).not.toBe(FREE)
    await expect.poll(() => scaffold.ctx.agents.get(selectedId)).toBeDefined()
    if (!held) {
      expect(selectedId).toBe(HELD)
      const reclaimed = scaffold.ctx.agents.get(HELD)!
      expect(scaffold.ctx.sessionProjections.stateOf(reclaimed.session, 'plan')).toMatchObject({ active: true })
      await expect(scaffold.ctx.sessionPersistence.open(HELD, 'write'))
        .rejects.toMatchObject({ name: 'SessionAlreadyOwnedError' })
    }
    const count = held ? 3 : 2
    expect(scaffold.ctx.workspaceRegistry.list()[0]!.sessionIds).toHaveLength(count)

    const second = await openSavedBlank(selectedId)
    await expect.poll(() => selected(second)).toBe(selectedId)
    expect(scaffold.ctx.workspaceRegistry.list()[0]!.sessionIds).toHaveLength(count)

    await writer?.close()
    writer = undefined
    const third = await openSavedBlank()
    await expect.poll(() => scaffold.ctx.agents.get(HELD)).toBeDefined()
    await expect.poll(() => selected(third)).toBe(HELD)
    expect(scaffold.ctx.workspaceRegistry.list()[0]!.sessionIds).toHaveLength(count)
    for (const tripwire of tripwires) {
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    }
  })
})
