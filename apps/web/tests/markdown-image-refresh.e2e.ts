// A rewritten local image file shows its current bytes in a newly rendered Markdown image.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot, WEB_FIXTURE_TIME } from './support.ts'

const ALT = 'Rewritten chart'
const chart = (width: number, color: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="60"><rect width="100%" height="100%" fill="${color}"/></svg>`

/** Build one closed session whose reply shows `{{cwd}}/chart.svg`. */
function chartFixture(title: string): string {
  const session = Session.create(SessionId('markdown-image-refresh-source'))
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Draw the chart.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', { title, messageSeqs: [user.seq], source: { kind: 'fallback' } })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: `${title}\n\n![${ALT}]({{cwd}}/chart.svg)` }],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const header = {
    type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0,
    cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0,
  }
  return [JSON.stringify(header), ...session.snapshotEvents().map(event => JSON.stringify({ ...event, time: WEB_FIXTURE_TIME + event.seq * 1_000 })), ''].join('\n')
}

describe('web e2e: rewritten Markdown image files', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      openInAppEnvironment: createLaunchEnvironmentSnapshot([
        { source: 'process', values: { SSH_CONNECTION: '10.0.0.2 55000 10.0.0.9 22' } },
      ]),
    })
    await writeFile(join(scaffold.workspaceCwd, 'chart.svg'), chart(120, 'red'))
    await seedSession(scaffold, chartFixture('First chart'), 'markdown-image-refresh-first', undefined,
      { createdAt: WEB_FIXTURE_TIME - 120_000 })
    await seedSession(scaffold, chartFixture('Second chart'), 'markdown-image-refresh-second', undefined,
      { createdAt: WEB_FIXTURE_TIME - 60_000 })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('loads the current file for an image mounted after the file changes', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-markdown-image-refresh'))
    const width = () => page.getByRole('img', { name: ALT }).evaluate(element => (element as HTMLImageElement).naturalWidth)
    await page.getByRole('treeitem').first().click()
    // Seeded sessions list newest first under the expanded workspace.
    await page.getByRole('treeitem').nth(2).click()
    await page.getByText('First chart', { exact: true }).last().waitFor()
    await expect.poll(width, { timeout: 10_000 }).toBe(120)

    await writeFile(join(scaffold.workspaceCwd, 'chart.svg'), chart(240, 'blue'))
    await page.getByRole('treeitem').nth(1).click()
    await page.getByText('Second chart', { exact: true }).last().waitFor()
    await expect.poll(width, { timeout: 10_000 }).toBe(240)
    await page.getByRole('img', { name: ALT }).click({ button: 'right' })
    const action = page.getByRole('menuitem', { name: 'Download', exact: true })
    await action.waitFor()
    const [download] = await Promise.all([page.waitForEvent('download'), action.click()])
    expect(download.suggestedFilename()).toBe('chart.svg')
    const path = await download.path()
    if (path === null) throw new Error('Browser download unavailable')
    expect(await readFile(path, 'utf8')).toBe(chart(240, 'blue'))
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)
})
