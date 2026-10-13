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
import { expectFirstLineTerminalState, expectWrappedCommandText } from './terminal-command-browser.ts'

const COMMAND = 'node ./scripts/start-worker.mjs --workspace=/tmp/diagnostics/long-workspace-name-for-background-command-details --log-level=debug --trace-tag=background-shell-full-command-selection --include=worker,lifecycle,transport,subscriptions --output=/tmp/diagnostics/background-worker.log'
const ARGS = { command: COMMAND, description: 'Start the diagnostic worker', run_in_background: true }
const OUTPUT = 'started background job bash-1'
const LONG_ARGS = { ...ARGS, command: `${COMMAND} --token=${'x'.repeat(1024)}` }

/** A settled shell call rendered from durable arguments and its original result. */
function shellFixture(arguments_: typeof ARGS, output: string): string {
  const session = Session.create(SessionId('shell-command-details-source'))
  const callId = ToolCallId('shell-command-details-background')
  const args = JSON.stringify(arguments_)
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: arguments_.run_in_background
      ? 'Start the diagnostic worker in the background.' : 'Run the diagnostic worker.' }],
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
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: output }], isError: false }),
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

it.each([
  { name: 'background', args: ARGS, output: OUTPUT },
  { name: 'background-long-token', args: LONG_ARGS, output: OUTPUT },
  {
    name: 'foreground-multiline',
    args: { ...LONG_ARGS, command: `${LONG_ARGS.command}\necho done\n`, run_in_background: false },
    output: 'done\n[exit code: 0]',
  },
])('expands $name to wrapped commands with only foreground output', async ({ name, args, output }) => {
  const scaffold = await launchWebScaffold({})
  try {
    await seedSession(scaffold, shellFixture(args, output), 'shell-command-details-browser')
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
      const commands = card.locator('[data-command-text]')
      const input = commands.first()
      await input.waitFor()
      const background = args.run_in_background
      const selectableText = args.command.split('\n')[0]!
      const inputSection = card.locator('[data-terminal] [class*="_header_"]')
      expect(await input.textContent()).toBe(selectableText)
      if (background) {
        expect(await commands.allTextContents()).toEqual([args.command])
        expect(await card.locator('[data-terminal]').count()).toBe(1)
        expect(await card.getByText(OUTPUT, { exact: true }).count()).toBe(0)
        expect(await card.locator('[data-terminal][data-body], [data-terminal][data-running], [data-terminal] [data-state]').count()).toBe(0)
        expect(await card.getByRole('button', { name: 'Copy', exact: true }).count()).toBe(0)
      } else {
        expect(await commands.allTextContents()).toEqual([selectableText, 'echo done'])
        expect(await card.locator('[data-terminal]').count()).toBe(1)
        expect(await card.getByText('done', { exact: true }).count()).toBe(1)
      }
      expect(await card.getByRole('button', { name: 'Inspect', exact: true }).count()).toBe(1)
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme'))).toBe(colorScheme === 'dark')
        for (const width of ['', '380px', '']) {
          await card.evaluate((element, value) => { element.style.width = value }, width)
          if (!background && width === '380px') await expectFirstLineTerminalState(card.locator('[data-terminal]'), 'done')
          await expectWrappedCommandText(page, input, selectableText, inputSection)
          expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
          if (name !== 'background') {
            expect(await inputSection.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
            await inputSection.evaluate((element) => { element.scrollTop = 0 })
            await row.focus()
            await page.keyboard.press('Tab')
            const focusTarget = background ? inputSection : card.getByRole('button', { name: 'Copy', exact: true })
            expect(await focusTarget.evaluate(element => document.activeElement === element)).toBe(true)
            await page.keyboard.press('End')
            await expect.poll(() => inputSection.evaluate(element =>
              element.scrollTop + element.clientHeight >= element.scrollHeight - 1)).toBe(true)
            await page.keyboard.press('Home')
            await expect.poll(() => inputSection.evaluate(element => element.scrollTop)).toBe(0)
          }
        }
        await card.evaluate((element) => { element.style.width = '' })
      }
      await page.emulateMedia({ colorScheme: null })
      const expected = fileURLToPath(new URL(`./expected/shell-command-details/${name}.expected.md`, import.meta.url))
      await compareOrRefreshGolden(expected,
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

it.each([
  { name: 'bash', background: false },
  { name: 'pwsh', background: false },
  { name: 'bash', background: true },
  { name: 'pwsh', background: true },
] as const)('keeps the $name command mounted through settlement (background=$background)', async ({ name, background }) => {
  const scaffold = await launchWebScaffold({})
  try {
    const id = await seedSession(scaffold, shellFixture(ARGS, OUTPUT), 'shell-status-dot-browser')
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl)
      await page.getByRole('treeitem').first().click()
      await page.getByRole('treeitem').nth(1).click()
      await page.locator('[data-sample="bash"]').waitFor({ state: 'attached' })
      const resolved = await scaffold.ctx.sessionController.resolveAgent(id)
      if ('error' in resolved) throw resolved.error
      const session = resolved.agent.session
      const callId = ToolCallId(`status-dot-${name}-${background ? 'background' : 'foreground'}`)
      const args = JSON.stringify({ command: LONG_ARGS.command, description: `Long ${name} command`, run_in_background: background })
      session.append('turn/start', { turn: 2 })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Show a long running command.' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('step/start', { turn: 2, step: 1 })
      session.append('assistant/message', {
        turn: 2, step: 1, stream: [],
        message: createAssistantMessage({
          content: [{ type: 'tool-call', id: callId, name, arguments: args }],
          source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        }),
      }, { surfaceOp: 'append' })
      const call = session.append('tool/call', { turn: 2, step: 1, callId, name, arguments: args })
      await scaffold.ctx.sessions.flush(session)
      const callRow = page.locator(`[data-chat-call-id="${callId}"]`)
      const toggle = callRow.locator('[data-expandable]').first()
      await toggle.waitFor({ state: 'attached' })
      await expandOwningTurnProcess(page, toggle)
      await toggle.click()
      const card = callRow.locator('[data-terminal]')
      await card.waitFor()
      await card.evaluate((element) => { element.style.width = '380px' })
      await card.scrollIntoViewIfNeeded()
      const header = card.locator('[class*="_header_"]')
      const mountedCard = await card.elementHandle()
      if (mountedCard === null) throw new Error('Running command card is not mounted')
      expect(await header.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
      expect(await card.getByRole('button', { name: 'Copy', exact: true }).count()).toBe(0)
      for (const state of ['ongoing', 'done'] as const) {
        if (state === 'done') {
          session.append('tool/result', {
            turn: 2, step: 1,
            message: createToolResultMessage({
              callId, content: [{ type: 'text', text: background ? OUTPUT : 'status dot output\n[exit code: 0]' }], isError: false,
            }),
          }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
          session.append('step/end', { turn: 2, step: 1 })
          session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
          await scaffold.ctx.sessions.flush(session)
        }
        for (const colorScheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme })
          await expect.poll(() => page.locator('body').evaluate(element =>
            element.hasAttribute('data-ds-dark-theme'))).toBe(colorScheme === 'dark')
          if (background && state === 'done') {
            await expect.poll(() => card.getAttribute('data-running')).toBeNull()
            expect(await card.evaluate((element, previous) => element === previous, mountedCard)).toBe(true)
            expect(await toggle.getAttribute('aria-expanded')).toBe('true')
            expect(await card.getAttribute('data-body')).toBeNull()
            expect(await card.getAttribute('data-running')).toBeNull()
            expect(await card.locator('[data-state]').count()).toBe(0)
          } else await expectFirstLineTerminalState(card, state)
          expect(await card.locator('[data-command-text]').textContent()).toBe(LONG_ARGS.command)
        }
      }
      expect(await card.getByText('status dot output', { exact: true }).count()).toBe(background ? 0 : 1)
      expect(await card.getByText(OUTPUT, { exact: true }).count()).toBe(0)
      expect(await card.getByRole('button', { name: 'Copy', exact: true }).count()).toBe(background ? 0 : 1)
      expect(await callRow.getByRole('button', { name: 'Inspect', exact: true }).count()).toBe(1)
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})
