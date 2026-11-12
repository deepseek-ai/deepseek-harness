/**
 * A forked subagent's transcript separates its inherited history from its own messages.
 * The replayed recording is borrowed read-only from its recorded-session owner,
 * `subagent-fork-schedule.snapshot.ts`; this file never re-records it.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import type {} from '@deepseek-ai/dsh-subagent'
import { launchWebScaffold, selectedSessionFixture, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const DIR = fileURLToPath(new URL('../../../snapshots/web/subagent-fork-schedule', import.meta.url))
const LABEL = 'Check child reminder refusal'
const PARENT_PROMPT = 'Reply PARENT_READY.'

it('places the inherited-history divider between the parent turn and the child prompt', async () => {
  const paths = await Promise.all(['session.v4.jsonl', 'session.1.v4.jsonl']
    .map(file => selectedSessionFixture(join(DIR, file))))
  const childPrompt = parseSessionLog(await readFile(paths[1]!, 'utf8')).findLast(event =>
    event.type === 'user/message' && event.data.source.kind === 'user')
  if (childPrompt?.type !== 'user/message') throw new Error('child fixture has no user prompt')
  const scaffold = await launchWebScaffold({
    replayFixture: paths[0]!, replayChildFixtures: [paths[1]!], compareReplaySession: false,
  })
  const browser = await chromium.launch()
  try {
    const page = await newEnglishPage(browser)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-fork-divider'))
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const parent = scaffold.ctx.agents.list().find(agent => agent.session.header.origin !== 'subagent')
    if (parent === undefined) throw new Error('fresh workspace did not publish its parent Agent')
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input][contenteditable="true"]').first()
    await input.fill(PARENT_PROMPT)
    await input.press('Enter')
    await settled

    const activation = await scaffold.ctx.subagents.startActivation({
      provider: 'fork', label: LABEL, delivery: 'caller',
      signal: new AbortController().signal, parent, prompt: [...childPrompt.data.content],
    })
    try {
      await activation.result
    } finally {
      await activation.dispose()
    }
    await page.getByRole('button', { name: '1 subagent' }).click()
    await page.getByRole('tree', { name: 'Subagent sessions' }).getByRole('treeitem', { name: new RegExp(LABEL) }).click()
    const divider = page.getByRole('separator', { name: 'Inherited history above' })
    await divider.waitFor({ timeout: 15_000 })
    expect(await divider.count()).toBe(1)
    const top = async (text: string) => (await page.getByText(text, { exact: true }).last().boundingBox())!.y
    const dividerTop = (await divider.boundingBox())!.y
    expect(await top('PARENT_READY')).toBeLessThan(dividerTop)
    expect(await top('CHILD_DONE')).toBeGreaterThan(dividerTop)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser.close()
    await scaffold.close()
  }
})
