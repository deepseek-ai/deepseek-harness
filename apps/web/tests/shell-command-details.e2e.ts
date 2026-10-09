import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  seedSession, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { expandOwningTurnProcess, newEnglishPage } from './support.ts'
import { expectCommandFocusAfterResize, expectSelectableCommandText } from './terminal-command-browser.ts'

const COMMAND = 'node ./scripts/start-worker.mjs --workspace=/tmp/diagnostics/long-workspace-name-for-background-command-details --log-level=debug --trace-tag=background-shell-full-command-selection --include=worker,lifecycle,transport,subscriptions --output=/tmp/diagnostics/background-worker.log'
const ARGS = { command: COMMAND, description: 'Start the diagnostic worker', run_in_background: true }
const OUTPUT = 'started background job bash-1'
const EXPECTED = fileURLToPath(new URL('./expected/shell-command-details/background.expected.md', import.meta.url))

/** A settled background launch acknowledgement rendered from durable call arguments. */
function backgroundFixture(): string {
  const session = Session.create(SessionId('shell-command-details-source'))
  const callId = ToolCallId('shell-command-details-background')
  const args = JSON.stringify(ARGS)
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Start the diagnostic worker in the background.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createAssistantMessage({
      content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: args }],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
  const call = session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: args })
  session.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: OUTPUT }], isError: false }),
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('step/start', { turn: 1, step: 2 })
  session.append('assistant/message', {
    stream: [], turn: 1, step: 2,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'Diagnostic worker launched.' }],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 2 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [
    JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0, isSeeded: false, delegationDepth: 0 }),
    ...session.snapshotEvents().map(event => JSON.stringify(event)),
    '',
  ].join('\n')
}

it('expands a background Bash launch to selectable arguments and its original acknowledgement', async () => {
  const scaffold = await launchWebScaffold({})
  try {
    await seedSession(scaffold, backgroundFixture(), 'shell-command-details-browser')
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl)
      await page.locator('[class*="frame"]').waitFor()
      const group = page.getByRole('treeitem').first()
      await group.waitFor()
      await group.click()
      await page.getByRole('treeitem').nth(1).click()
      const row = page.locator('[data-sample="bash"]').first()
      await expandOwningTurnProcess(page, row)
      await row.waitFor()
      expect(await row.getAttribute('aria-expanded')).toBe('false')
      await row.click()
      const card = row.locator('..')
      const input = card.locator('[data-command-text]')
      await input.waitFor()
      expect(await input.textContent()).toBe(JSON.stringify(ARGS, null, 2))
      expect(await card.getByText(OUTPUT, { exact: true }).count()).toBe(1)
      expect(await card.locator('[data-terminal]').count()).toBe(0)
      expect(await card.getByRole('button', { name: 'Inspect', exact: true }).count()).toBe(1)
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme'))).toBe(colorScheme === 'dark')
        for (const width of ['', '380px']) {
          await card.evaluate((element, value) => { element.style.width = value }, width)
          await input.scrollIntoViewIfNeeded()
          await expectSelectableCommandText(page, input, COMMAND, 'Command arguments')
          await expectCommandFocusAfterResize(card, input)
        }
        await card.evaluate((element) => { element.style.width = '' })
      }
      await page.emulateMedia({ colorScheme: null })
      await compareOrRefreshGolden(EXPECTED,
        await captureStableAria(page, '[data-chat-call-id="shell-command-details-background"]', scaffold.workspaceCwd), webSnapshotMode())
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})
