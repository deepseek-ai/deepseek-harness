/** Standard mode offers the installed documentation skill without loading it for an unrelated task. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { assertFixtureInventory, fixtureUserPrompts, launchWebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/standard-dsh-doc/session.v4.jsonl', import.meta.url))

it('lists dsh-doc once without loading instructions or calling tools for an ordinary task', async () => {
  const scaffold = await launchWebScaffold({ replayFixture: FIXTURE, compareReplaySession: true, paceMs: 10 })
  try {
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await connectFreshWorkspace(page, scaffold.workspaceCwd)
      const prompts = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
      expect(prompts).toHaveLength(1)
      const settled = scaffold.whenTurnSettled()
      const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
      await composer.fill(prompts[0]!)
      await composer.press('Enter')
      const sessionId = await settled
      const agent = scaffold.ctx.agents.get(sessionId)
      if (agent === undefined) throw new Error('standard documentation session is missing')
      const events = agent.session.snapshotEvents()
      expect(events.filter(event => event.type === 'tool/call')).toEqual([])
      const catalogs = events.flatMap(event => event.type === 'user/message'
        && event.data.source.kind === 'skill-catalog' ? [event.data] : [])
      expect(catalogs).toHaveLength(1)
      const skills = await scaffold.ctx.skills.list({ cwd: agent.session.header.cwd, scope: agent })
      expect(skills.filter(skill => skill.name === 'dsh-doc')).toHaveLength(1)
      expect(catalogs[0]?.source).toMatchObject({ entries: skills.map(skill => ({ name: skill.name })) })
      expect(events.filter(event => event.type === 'user/message'
        && event.data.source.kind === 'skill-invocation')).toEqual([])
      const names = scaffold.ctx.tools.schemas(agent).map(tool => tool.name)
      expect(names).not.toContain('cordis_inspect_list')
      expect(names).not.toContain('cordis_inspect_query')
      await page.getByText('READY', { exact: true }).waitFor()
      await assertFixtureInventory(dirname(FIXTURE), ['session.v4.jsonl'])
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})
