/**
 * A Turn this Client did not submit (a subagent-settled notice) wakes while the
 * reader follows the tail of a long Turn under "On next message" folding. The
 * notice Turn belongs to the long Turn's exchange, so the long Turn stays
 * expanded through the host's pre-Step gap and after the notice arrives, and a
 * reader who was following sees the notice and its reply at the tail.
 */
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentSettledMessageSource } from '@deepseek-ai/dsh-subagent'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

/** Settled Turns before the long one, so every work-details mode overflows the viewport. */
const HISTORY_TURNS = 3
const LONG_TURN = HISTORY_TURNS + 1
const NOTICE_TURN = HISTORY_TURNS + 2
/** Tool Steps in the finished Turn; their folded height must exceed the notice Turn's height. */
const TOOL_STEPS = 12
const OUTPUT_LINES = 40
/** The recorded host gap between the waking claim and Step 1, spent assembling the system prompt. */
const PRE_STEP_GAP_MS = 187
const REPLY = 'NOTICE_WAKE_REPLY'

interface Tail {
  /** Height of the room reserved below the flow. */
  readonly spacer: number
  readonly noticeVisible: boolean
  readonly replyVisible: boolean
  /** Whether the long Turn's process disclosure reports itself expanded. */
  readonly longTurnOpen: boolean
}

function readTail(page: Page): Promise<Tail> {
  return page.evaluate(([reply, longTurn]) => {
    const host = document.querySelector<HTMLElement>('[data-conversation-scroll]')
    if (host === null) throw new Error('conversation scrollport is absent')
    const viewTop = host.getBoundingClientRect().top
    const viewBottom = host.querySelector<HTMLElement>('[data-composer-seat]')?.getBoundingClientRect().top
      ?? host.getBoundingClientRect().bottom
    const inView = (element: Element): boolean => {
      const rect = element.getBoundingClientRect()
      return rect.height > 0.5 && rect.bottom > viewTop && rect.top < viewBottom
    }
    const spacer = host.querySelector<HTMLElement>('[data-chat-turn-spacer]')
    return {
      spacer: spacer === null ? 0 : Number.parseFloat(spacer.style.height) || 0,
      noticeVisible: [...host.querySelectorAll('[data-turn-trigger]')].some(inView),
      replyVisible: [...host.querySelectorAll('[data-chat-flow-kind="assistant-step"]')]
        .some(row => (row.textContent ?? '').includes(reply) && inView(row)),
      longTurnOpen: host.querySelector(`[data-turn-process="${longTurn}"]`)?.getAttribute('aria-expanded') === 'true',
    }
  }, [REPLY, String(LONG_TURN)] as const)
}

describe('web e2e: notice Turn after a long Detailed Turn', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
  })

  it.each(['detailed', 'standard'] as const)('keeps the new tail visible in %s work details', async (view) => {
    const scaffold: WebScaffold = await launchWebScaffold({})
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    try {
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await connectFreshWorkspace(page, scaffold.workspaceCwd)
      await scaffold.ctx.settings.update('ui-chat', { transcriptView: view, collapseTiming: 'next-input' })
      const agent = scaffold.ctx.agents.list().at(-1)
      if (agent === undefined) throw new Error('connected workspace created no Agent')
      const session = agent.session
      const setRunning = (running: boolean): void => { scaffold.ctx.emit('api-session/status', agent.id, running) }

      for (let turn = 1; turn <= HISTORY_TURNS; turn += 1) {
        session.append('turn/start', { turn })
        session.append('step/start', { turn, step: 1 })
        session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: `Earlier question ${String(turn)}.` }],
          source: { kind: 'user' },
        }), { surfaceOp: 'append' })
        session.append('assistant/message', {
          stream: [],
          turn,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: 'text', text: `Earlier answer ${String(turn)}. ${'This settled reply wraps across several lines of prose. '.repeat(24)}` }],
            source: { provider: 'fixture', model: 'fixture' },
          }),
        }, { surfaceOp: 'append' })
        session.append('step/end', { turn, step: 1 })
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
      }

      // A long running Turn streams Step by Step while the reader follows the tail.
      setRunning(true)
      session.append('turn/start', { turn: LONG_TURN })
      session.append('step/start', { turn: LONG_TURN, step: 1 })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Run the long diagnostic.' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      for (let step = 1; step <= TOOL_STEPS; step += 1) {
        const callId = ToolCallId(`notice-wake-${String(step)}`)
        const args = JSON.stringify({ command: `diagnose ${String(step)}`, description: `Diagnostic ${String(step)}` })
        session.append('assistant/message', {
          stream: [],
          turn: LONG_TURN,
          step,
          message: createAssistantMessage({
            content: [
              { type: 'reasoning', text: `Checking diagnostic ${String(step)}.` },
              { type: 'tool-call', id: callId, name: 'bash', arguments: args },
            ],
            source: { provider: 'fixture', model: 'fixture' },
          }),
        }, { surfaceOp: 'append' })
        const call = session.append('tool/call', { turn: LONG_TURN, step, callId, name: 'bash', arguments: args })
        session.append('tool/result', {
          turn: LONG_TURN,
          step,
          message: createToolResultMessage({
            callId,
            content: [{
              type: 'text',
              text: Array.from({ length: OUTPUT_LINES }, (_, line) => `diagnostic ${String(step)} line ${String(line + 1)}`).join('\n'),
            }],
            isError: false,
          }),
        }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
        session.append('step/end', { turn: LONG_TURN, step })
        session.append('step/start', { turn: LONG_TURN, step: step + 1 })
        await scaffold.ctx.sessions.flush(session)
        await page.locator(`[data-chat-node-key$="${callId}"]`).waitFor({ state: 'attached', timeout: 15_000 })
      }
      session.append('assistant/message', {
        stream: [],
        turn: LONG_TURN,
        step: TOOL_STEPS + 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: 'All diagnostics finished.' }],
          source: { provider: 'fixture', model: 'fixture' },
        }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn: LONG_TURN, step: TOOL_STEPS + 1 })
      await scaffold.ctx.sessions.flush(session)
      await page.getByText('All diagnostics finished.').waitFor({ timeout: 30_000 })
      await page.evaluate(() => {
        const host = document.querySelector<HTMLElement>('[data-conversation-scroll]')
        if (host !== null) host.scrollTop = host.scrollHeight
      })
      await page.locator('[data-chat-following-tail]').waitFor({ timeout: 10_000 })

      // The Turn ends; 15 ms later (the recorded production gap) a settled subagent wakes the next Turn.
      session.append('turn/end', { turn: LONG_TURN, reason: { kind: 'completed' } })
      await scaffold.ctx.sessions.flush(session)
      setRunning(false)
      await page.waitForTimeout(15)
      const source: SubagentSettledMessageSource = {
        kind: 'subagent-settled',
        form: 'notice',
        summary: 'Background subagent finished.',
        senderSessionId: SessionId('notice-wake-child'),
      }
      const notice = createUserMessage({
        content: [{ type: 'text', text: 'Background subagent notice-wake-child finished.' }],
        source,
      })
      session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [notice] })
      session.append('turn/start', { turn: NOTICE_TURN })
      session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
      setRunning(true)
      await scaffold.ctx.sessions.flush(session)
      // The browser has applied the notice Turn's start before the gap is held and sampled.
      await page.locator(`[data-chat-turn="${String(NOTICE_TURN)}"]`).first().waitFor({ state: 'attached', timeout: 15_000 })
      await page.waitForTimeout(PRE_STEP_GAP_MS)
      const gap = await readTail(page)
      session.append('step/start', { turn: NOTICE_TURN, step: 1 })
      session.append('user/message', notice, { surfaceOp: 'append' })
      await scaffold.ctx.sessions.flush(session)
      await page.locator('[data-turn-trigger]').first().waitFor({ state: 'attached', timeout: 15_000 })
      session.append('assistant/message', {
        stream: [],
        turn: NOTICE_TURN,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: `${REPLY} the subagent result is acknowledged.` }],
          source: { provider: 'fixture', model: 'fixture' },
        }),
      }, { surfaceOp: 'append' })
      await scaffold.ctx.sessions.flush(session)

      expect(gap).toMatchObject({ longTurnOpen: true, spacer: 0 })
      const settled = { noticeVisible: true, replyVisible: true, longTurnOpen: true, spacer: 0 }
      await expect.poll(() => readTail(page), { timeout: 15_000 }).toMatchObject(settled)
      // The settled tail survives later frames instead of passing through on the way to a fold.
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
      }))
      expect(await readTail(page)).toMatchObject(settled)
      expect(tripwire.warnings).toEqual([])
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      await page.context().close()
      await scaffold.close()
    }
  }, 180_000)
})
