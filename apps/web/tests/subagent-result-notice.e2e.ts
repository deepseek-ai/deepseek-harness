/** Keyless browser coverage of structured subagent outcomes and historical notice fallback. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type BrowserContext } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createSettlementMessage } from '@deepseek-ai/dsh-subagent/src/continuation-messages.ts'
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { connectFreshWorkspace, connectFreshWorkspaceZh } from './support.ts'

const DIR = fileURLToPath(new URL('./expected/subagent-result-notice/', import.meta.url))
const MODE = webSnapshotMode()
const OUTPUT = '## Research result\nThe original child reply stays available.'
const OUTCOMES = [
  { reason: 'completed', en: 'Subagent run completed', zh: '子智能体已完成任务' },
  { reason: 'aborted', en: 'Subagent run stopped', zh: '子智能体任务已停止' },
  { reason: 'error', en: 'Subagent run failed', zh: '子智能体执行失败' },
  { reason: 'max-tokens', en: 'Subagent reached the token limit', zh: '子智能体已达 token 上限' },
  { reason: 'refusal', en: 'Subagent declined the task', zh: '子智能体拒绝执行' },
] as const satisfies readonly { reason: SubagentStopReason; en: string; zh: string }[]

describe.skipIf(MODE === 'record')('web e2e: subagent result notices', () => {
  let browser: Browser
  beforeAll(async () => { browser = await chromium.launch() })
  afterAll(async () => { await browser?.close() })

  it.each(['en', 'zh'] as const)('shows recorded outcomes and preserves notice bodies in %s', async (locale) => {
    const scaffold = await launchWebScaffold()
    let context: BrowserContext | undefined
    try {
      context = await browser.newContext({
        locale: locale === 'en' ? 'en-US' : 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1280, height: 900 },
      })
      const page = await context.newPage()
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await (locale === 'en' ? connectFreshWorkspace : connectFreshWorkspaceZh)(page, scaffold.workspaceCwd)
      const agent = scaffold.ctx.agents.list()[0]
      if (agent === undefined) throw new Error('Notice fixture has no connected Agent')
      const session = agent.session
      const appendTurn = (turn: number, message: ReturnType<typeof createUserMessage>): void => {
        const waking = message.source.kind !== 'user'
        if (waking) session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
        session.append('turn/start', { turn })
        if (waking) session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
        session.append('step/start', { turn, step: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        session.append('assistant/message', {
          turn, step: 1, stream: [], message: createAssistantMessage({
            content: [{ type: 'text', text: `Acknowledged ${turn}.` }], source: { provider: 'fixture', model: 'fixture' },
          }),
        }, { surfaceOp: 'append' })
        session.append('step/end', { turn, step: 1 })
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
      }
      appendTurn(1, createUserMessage({ content: [{ type: 'text', text: 'Inspect child execution results.' }], source: { kind: 'user' } }))
      const childId = SessionId('notice-result-child')
      const notices: { title: string; message: ReturnType<typeof createUserMessage> }[] = OUTCOMES.map(outcome => ({
        title: outcome[locale],
        message: createSettlementMessage(childId, 'agent-1', {
          stopReason: outcome.reason, output: [{ type: 'text', text: OUTPUT }],
        }),
      }))
      notices.push({
        title: OUTCOMES[0][locale],
        message: createSettlementMessage(childId, 'agent-1', { stopReason: 'completed', output: [] }),
      })
      notices.push({
        title: locale === 'en' ? 'Subtask status updated' : '子任务状态更新',
        message: createUserMessage({
          source: { kind: 'subagent-settled', form: 'notice', senderSessionId: childId, summary: 'Background subagent finished.' },
          content: [{ type: 'text', text: 'Background subagent finished.' }],
        }),
      })
      for (const [index, notice] of notices.entries()) appendTurn(index + 2, notice.message)
      await scaffold.ctx.sessions.flush(session)
      const snapshots: string[] = []
      for (const [index, notice] of notices.entries()) {
        const selector = `[data-chat-turn="${index + 2}"] [data-turn-trigger]`
        const card = page.locator(selector)
        await card.waitFor({ state: 'attached' })
        const header = card.locator('button').first()
        await expect.poll(() => header.locator(':scope > span').nth(1).textContent()).toBe(notice.title)
        await header.click()
        const original = notice.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
        expect(await card.locator('[data-context-text]').textContent()).toBe(original)
        snapshots.push(await captureStableAria(page, selector, scaffold.workspaceCwd))
        await header.click()
      }
      await page.setViewportSize({ width: 390, height: 844 })
      for (const card of await page.locator('[data-turn-trigger]').all()) {
        const geometry = await card.evaluate((element) => {
          const header = element.querySelector('button')!
          const title = header.querySelectorAll('span')[1]!
          const time = header.querySelector('time')!
          return {
            fits: element.scrollWidth <= element.clientWidth,
            separate: title.getBoundingClientRect().right <= time.getBoundingClientRect().left,
          }
        })
        expect(geometry).toEqual({ fits: true, separate: true })
      }
      const warningCount = tripwire.warnings.length
      await page.reload({ waitUntil: 'load' })
      await page.locator('[data-turn-trigger]').first().waitFor({ state: 'attached' })
      for (const [index, notice] of notices.entries()) {
        await expect.poll(() => page.locator(`[data-chat-turn="${index + 2}"] [data-turn-trigger] > button`).textContent())
          .toContain(notice.title)
      }
      acknowledgeReloadConnectionLoss(tripwire, warningCount)
      if (MODE === 'refresh') await mkdir(DIR, { recursive: true })
      await compareOrRefreshGolden(join(DIR, `${locale}.expected.md`), snapshots.join('\n\n'), MODE)
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    } finally {
      try { await context?.close() } finally { await scaffold.close() }
    }
  })

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(DIR, ['en.expected.md', 'zh.expected.md'])
  })
})
