/** Creator mode adds its DSH customization intent to the actual model prompt. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-token-meter'
import { fixtureUserPrompts, launchWebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/creator-persona/session.v4.jsonl', import.meta.url))
const CUSTOMIZATION_INTENT = 'You help the user customize DeepSeek Harness itself.'

it('sends the Creator customization intent without taking actions for an ordinary request', async () => {
  const scaffold = await launchWebScaffold({
    replayFixture: FIXTURE, compareReplaySession: true, paceMs: 10,
    actionCards: true, agentPresets: { default: 'cordis' },
  })
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
      if (agent === undefined) throw new Error('Creator persona session is missing')
      expect(agent.session.header.agentPreset).toBe('cordis')
      const system = agent.session.deriveMessages().find(message => message.role === 'system')
      if (system === undefined) throw new Error('Creator request has no system prompt')
      // Each section is its own text block; adapters join them with blank lines.
      const prompt = system.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n\n')
      expect(prompt).toMatch(/^You are a coding agent powered by the .+ model\. You help the user customize DeepSeek Harness itself\.$/mu)
      expect(prompt.split(CUSTOMIZATION_INTENT)).toHaveLength(2)
      const sharedPrompt = prompt.replace(` ${CUSTOMIZATION_INTENT}`, '')
      console.info('Creator persona context increment', {
        utf8Bytes: Buffer.byteLength(prompt) - Buffer.byteLength(sharedPrompt),
        codePoints: Array.from(prompt).length - Array.from(sharedPrompt).length,
        heuristicTokens: scaffold.ctx.tokenMeter.estimateMessage(system)
          - scaffold.ctx.tokenMeter.estimateMessage({ ...system, content: [{ type: 'text', text: sharedPrompt }] }),
      })
      const catalog = agent.session.snapshotEvents().flatMap(event =>
        event.type === 'user/message' && event.data.source.kind === 'skill-catalog'
          ? event.data.source.entries.map(entry => entry.name) : [])
      expect(catalog).toContain('dsh-doc')
      expect(catalog).not.toContain('official-plugins')
      expect(catalog).not.toContain('personalized-pages')
      expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/call')).toEqual([])
      await page.getByText('READY', { exact: true }).waitFor()
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})
