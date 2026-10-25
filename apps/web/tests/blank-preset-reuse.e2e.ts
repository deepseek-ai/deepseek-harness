/** Blank Session reuse under the requested or default Agent preset through the shipped Web composition. */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

/** A preset these blank Sessions recorded that the deployment no longer declares. */
const UNDECLARED = 'liangshen'

describe('web e2e: blank Session reuse under the requested preset', () => {
  let scaffold: WebScaffold
  let browser: Browser
  const tripwires: ReturnType<typeof watchConsole>[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  /** Store a blank Session recorded under `agentPreset`, with a plan-mode switch, as the only member of a new Workspace. */
  async function storeBlank(sessionId: SessionId, folder: string, agentPreset: string): Promise<void> {
    const path = join(scaffold.workspaceCwd, folder)
    await mkdir(path)
    const workspace = await scaffold.ctx.workspaceRegistry.create(path)
    const handle = await scaffold.ctx.agents.create({
      sessionId,
      meta: { cwd: path, agentPreset },
      agentOptions: scaffold.ctx.agentDefaultModel.currentSelection(),
    })
    try {
      handle.agent.session.append('plan/mode', { active: true })
      await workspace.attachSession(sessionId)
    } finally {
      await handle.dispose()
    }
  }

  async function openPage(saved?: SessionId): Promise<Page> {
    const page = await newEnglishPage(browser)
    tripwires.push(watchConsole(page))
    if (saved !== undefined) {
      await page.addInitScript((id) => {
        localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id }))
      }, saved)
    }
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

  /** The live Agent's mounted preset, its projected preset, and its plan-mode state. */
  function liveComposition(sessionId: SessionId) {
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) return undefined
    const projections = scaffold.ctx.sessionProjections.snapshot(agent.session).values
    return {
      mounted: scaffold.ctx.agentPresets.composedPreset(agent.ctx),
      projected: projections.agentPreset,
      plan: projections.plan,
    }
  }

  async function storedSelections(sessionId: SessionId): Promise<unknown[]> {
    await scaffold.ctx.sessionPersistence.flush()
    const handle = await scaffold.ctx.sessionPersistence.open(sessionId, 'read')
    try {
      const { events } = await handle.read()
      return events
        .filter((event: SessionEvent) => event.type === 'agent-preset/selected')
        .map((event: SessionEvent) => event.data)
    } finally {
      await handle.close()
    }
  }

  it('reuses a blank recorded under an undeclared preset under the default when startup connects its Workspace', async () => {
    const stale = SessionId('blank-undeclared')
    await storeBlank(stale, 'undeclared', UNDECLARED)

    const page = await openPage()
    await expect.poll(() => selected(page)).toBe(stale)
    await expect.poll(() => liveComposition(stale)).toMatchObject({
      mounted: 'standard', projected: 'standard', plan: { active: true },
    })
    expect(await storedSelections(stale)).toEqual([{ agentPreset: 'standard' }])
    expect(scaffold.ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(stale))?.sessionIds).toEqual([stale])
    expect(await page.getByRole('alert').count()).toBe(0)
  })

  it('restores a saved blank under the preset it recorded', async () => {
    const picked = SessionId('blank-picked')
    await storeBlank(picked, 'picked', 'minimal')

    const page = await openPage(picked)
    await expect.poll(() => selected(page)).toBe(picked)
    await expect.poll(() => liveComposition(picked)).toMatchObject({ mounted: 'minimal', projected: 'minimal' })
    expect(await storedSelections(picked)).toEqual([])
  })

  it('restores a saved blank under the default once its recorded preset is undeclared', async () => {
    const saved = SessionId('saved-undeclared')
    await storeBlank(saved, 'saved-undeclared', UNDECLARED)

    const page = await openPage(saved)
    await expect.poll(() => selected(page)).toBe(saved)
    await expect.poll(() => liveComposition(saved)).toMatchObject({
      mounted: 'standard', projected: 'standard', plan: { active: true },
    })
    expect(await storedSelections(saved)).toEqual([{ agentPreset: 'standard' }])
    expect(await page.getByRole('alert').count()).toBe(0)
    for (const tripwire of tripwires) {
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    }
  })
})
