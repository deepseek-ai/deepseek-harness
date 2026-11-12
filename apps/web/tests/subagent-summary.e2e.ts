/** Keyless browser coverage of subagent task summaries and durable creation receipts. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  AssistantStreamAccumulator, type LlmAttemptId, type ToolCallId,
  createAssistantMessage, createToolResultMessage, createUserMessage,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, expandOwningTurnProcess, newEnglishPage } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/subagent-summary/', import.meta.url))
const MODE = webSnapshotMode()
const DESCRIPTION = 'Review subagent task summaries'
const PROMPT = 'Inspect the subagent tool card across its lifecycle.\nCheck streaming arguments, creation receipts, and restored history.\nReturn findings without changing unrelated files.'
const SOURCE = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

async function snapshotGolden(name: string, actual: string): Promise<void> {
  if (MODE === 'refresh') await mkdir(SNAPSHOT_DIR, { recursive: true })
  await compareOrRefreshGolden(join(SNAPSHOT_DIR, `${name}.expected.md`), actual, MODE)
}

function startTurn(agent: Agent, turn: number): void {
  agent.session.append('turn/start', { turn })
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `Inspect subagent summary case ${turn}.` }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  agent.session.append('step/start', { turn, step: 1 })
}

function appendCall(agent: Agent, turn: number, callId: ToolCallId, args: string, name = 'subagent'): SessionEvent<'tool/call'> {
  agent.session.append('assistant/message', {
    turn, step: 1, stream: [],
    message: createAssistantMessage({
      content: [{ type: 'tool-call', id: callId, name, arguments: args }], source: SOURCE,
    }),
  }, { surfaceOp: 'append' })
  return agent.session.append('tool/call', { turn, step: 1, callId, name, arguments: args })
}

function finishCall(agent: Agent, call: SessionEvent<'tool/call'>, text: string, isError = false, meta?: SessionEvent<'tool/result'>['data']['meta']): void {
  const { turn, step, callId } = call.data
  agent.session.append('tool/result', {
    turn, step, message: createToolResultMessage({ callId, content: [{ type: 'text', text }], isError }),
    ...meta === undefined ? {} : { meta },
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  agent.session.append('step/end', { turn, step })
  agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function toolSelector(callId: ToolCallId): string {
  return `[data-chat-call-id="${callId}"] [data-tool="subagent"]`
}

async function expectSummary(card: Locator, text: string): Promise<void> {
  const header = card.locator('[data-disclosure-row]').first()
  await expect.poll(() => header.textContent(), { timeout: 10_000 }).toBe(`Create subagent${text}`)
}

async function expandTask(card: Locator, prompt: string): Promise<void> {
  await expandOwningTurnProcess(card.page(), card)
  const toggle = card.locator('[data-expandable]').first()
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  const task = card.locator('details').filter({ has: card.page().locator('summary', { hasText: /^Task$/u }) })
  await task.waitFor()
  if (await task.getAttribute('open') === null) await task.locator('summary').click()
  await expect.poll(() => task.locator('p').textContent()).toBe(prompt)
}

describe.skipIf(MODE === 'record')('web e2e: subagent task summary', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let agent: Agent

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[class*="frame"]').waitFor()
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const connected = scaffold.ctx.agents.list()[0]
    if (connected === undefined) throw new Error('Subagent summary fixture has no connected Agent')
    agent = connected
  })

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('streams the description and preserves it through creation and restored history', async () => {
    const callId = brandString<ToolCallId>('subagent-summary-described')
    const selector = toolSelector(callId)
    const card = page.locator(selector)
    const snapshots: string[] = []
    const capture = async (stage: string): Promise<void> => {
      await expandOwningTurnProcess(page, card)
      snapshots.push(`## ${stage}\n\n${await captureStableAria(page, selector, scaffold.workspaceCwd)}`)
    }
    startTurn(agent, 1)
    await scaffold.ctx.sessions.flush(agent.session)
    await page.locator('[data-chat-turn="1"]').getByText('Inspect subagent summary case 1.', { exact: true }).waitFor()

    const attemptId = brandString<LlmAttemptId>('subagent-summary-stream')
    const stream = new AssistantStreamAccumulator()
    let revision = 0
    let index = 0
    const emit = (frame: AssistantStreamFrame): void => { scaffold.ctx.emit('agent/assistant-stream', { agent, frame }) }
    const push = (chunk: StreamChunk): void => {
      const time = Date.now()
      stream.push({ time, chunk })
      emit({ type: 'chunk', attemptId, revision: ++revision, index: index++, time, chunk })
    }
    emit({ type: 'start', attemptId, revision: ++revision, turn: 1, step: 1 })
    push({ type: 'block-start', index: 0, blockType: 'tool-call' })
    push({ type: 'tool-call-delta', index: 0, id: callId, name: 'subagent', argumentsDelta: `{"prompt":${JSON.stringify(PROMPT)},` })
    await card.waitFor({ state: 'attached' })
    await expandOwningTurnProcess(page, card)
    await expect.poll(() => card.getAttribute('data-state')).toBe('preparing')
    await expectSummary(card, '')
    await capture('Preparing without description')
    push({ type: 'tool-call-delta', index: 0, id: callId, argumentsDelta: '"description":"Review subagent' })
    await expectSummary(card, 'Review subagent')
    push({ type: 'tool-call-delta', index: 0, id: callId, argumentsDelta: ' task summaries\\nAdditional description context' })
    await expectSummary(card, DESCRIPTION)
    await capture('Preparing with partial description')
    push({ type: 'tool-call-delta', index: 0, id: callId, argumentsDelta: '"}' })
    const args = JSON.stringify({ prompt: PROMPT, description: `${DESCRIPTION}\nAdditional description context` })
    const block = { type: 'tool-call' as const, id: callId, name: 'subagent', arguments: args }
    push({ type: 'block-end', index: 0, block })
    push({ type: 'finish', reason: { kind: 'tool-calls' } })
    const message = agent.session.append('assistant/message', {
      turn: 1, step: 1, stream: [...stream.snapshot()],
      message: createAssistantMessage({ content: [block], source: SOURCE }),
    }, { surfaceOp: 'append' })
    emit({ type: 'end', attemptId, revision: ++revision, index, outcome: { kind: 'committed', eventType: 'assistant/message', seq: message.seq } })
    const call = agent.session.append('tool/call', { turn: 1, step: 1, callId, name: 'subagent', arguments: args })
    await scaffold.ctx.sessions.flush(agent.session)
    await expect.poll(() => card.getAttribute('data-state')).toBe('running')
    await expectSummary(card, DESCRIPTION)
    await capture('Running')

    finishCall(agent, call, 'Delegation accepted.', false, { kind: 'activation', subagentId: 'child-foo' })
    await scaffold.ctx.sessions.flush(agent.session)
    await expect.poll(() => card.getAttribute('data-state')).toBe('ok')
    await expectSummary(card, DESCRIPTION)
    await capture('Created')
    await expandTask(card, PROMPT)
    await expectSummary(card, DESCRIPTION)
    expect(await card.getByText('Agent response', { exact: true }).count()).toBe(0)
    await card.getByText('Started', { exact: true }).waitFor()
    expect(await card.locator('dt').allTextContents()).toEqual(['Agent task description', 'ID'])
    expect(await card.locator('dd').allTextContents()).toEqual([`${DESCRIPTION}\nAdditional description context`, 'child-foo'])
    await capture('Creation receipt and complete task')

    const beforeReload = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await card.waitFor({ state: 'attached' })
    await expandOwningTurnProcess(page, card)
    await expectSummary(card, DESCRIPTION)
    await expandTask(card, PROMPT)
    await expectSummary(card, DESCRIPTION)
    expect(await card.getByText('Agent response', { exact: true }).count()).toBe(0)
    await capture('Restored creation receipt')
    acknowledgeReloadConnectionLoss(tripwire, beforeReload)
    await snapshotGolden('lifecycle', snapshots.join('\n\n'))
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('falls back to the prompt, keeps synchronous replies in details, and preserves errors', async () => {
    const cases = [
      { id: 'fallback', args: { prompt: 'Review the fallback summary.\nKeep the complete task in details.' }, summary: 'Review the fallback summary.', result: 'started subagent fallback-worker' },
      { id: 'reply', args: { description: 'Check synchronous agent reply', prompt: 'Review the synchronous report.\nKeep every instruction available.' }, summary: 'Check synchronous agent reply', result: 'The synchronous agent found two issues.\nBoth are documented in the report.' },
      { id: 'title-only', args: {}, summary: '', result: 'started subagent empty-worker' },
      { id: 'error', args: { description: 'Delegate a failing task', prompt: 'Attempt the requested delegation.' }, summary: 'Subagent capacity exceeded', result: 'Subagent capacity exceeded\nWait for an active agent to finish.', error: true },
    ]
    const snapshots: string[] = []
    for (const [index, fixture] of cases.entries()) {
      const turn = index + 2
      const callId = brandString<ToolCallId>(`subagent-summary-${fixture.id}`)
      const selector = toolSelector(callId)
      const card = page.locator(selector)
      startTurn(agent, turn)
      const call = appendCall(agent, turn, callId, JSON.stringify(fixture.args))
      await scaffold.ctx.sessions.flush(agent.session)
      await card.waitFor({ state: 'attached' })
      await expandOwningTurnProcess(page, card)
      await expectSummary(card, fixture.args.description ?? fixture.args.prompt?.split('\n')[0] ?? '')
      finishCall(agent, call, fixture.result, fixture.error)
      await scaffold.ctx.sessions.flush(agent.session)
      await expect.poll(() => card.getAttribute('data-state')).toBe(fixture.error === true ? 'error' : 'ok')
      await expectSummary(card, fixture.summary)
      if (fixture.args.prompt !== undefined && fixture.error !== true) {
        await expandTask(card, fixture.args.prompt)
        await expectSummary(card, fixture.summary)
        if (fixture.id === 'reply') {
          await card.getByText('Agent response', { exact: true }).waitFor()
          await card.getByText('The synchronous agent found two issues.', { exact: false }).waitFor()
          await card.getByText('Both are documented in the report.', { exact: false }).waitFor()
          expect(await card.getByText('Started', { exact: true }).count()).toBe(0)
        } else expect(await card.getByText('Agent response', { exact: true }).count()).toBe(0)
      }
      await expandOwningTurnProcess(page, card)
      snapshots.push(`## ${fixture.id}\n\n${await captureStableAria(page, selector, scaffold.workspaceCwd)}`)
    }
    await snapshotGolden('variants', snapshots.join('\n\n'))
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('presents fork creation with a distinct title, task summary, and restored receipt', async () => {
    const name = 'subagent_fork'
    const callId = brandString<ToolCallId>('subagent-fork-summary')
    const selector = `[data-chat-call-id="${callId}"] [data-tool="${name}"]`
    const card = page.locator(selector)
    const description = 'Review inherited conversation context'
    const prompt = 'Summarize the earlier agreed requirements.\nDo not modify files.'
    const snapshots: string[] = []
    const capture = async (stage: string): Promise<void> => {
      snapshots.push(`## ${stage}\n\n${await captureStableAria(page, selector, scaffold.workspaceCwd)}`)
    }
    const expectForkSummary = async (): Promise<void> => {
      await expect.poll(() => card.locator('[data-disclosure-row]').first().textContent())
        .toBe(`Fork subagent${description}`)
    }
    startTurn(agent, 6)
    const call = appendCall(agent, 6, callId, JSON.stringify({ description, prompt }), name)
    await scaffold.ctx.sessions.flush(agent.session)
    await card.waitFor({ state: 'attached' })
    await expandOwningTurnProcess(page, card)
    await expect.poll(() => card.getAttribute('data-state')).toBe('running')
    await expectForkSummary()
    await capture('Running')
    finishCall(agent, call, 'started subagent fork-worker')
    await scaffold.ctx.sessions.flush(agent.session)
    await expect.poll(() => card.getAttribute('data-state')).toBe('ok')
    await expandTask(card, prompt)
    await expectForkSummary()
    expect(await card.locator('dt').allTextContents()).toEqual(['Agent task description', 'ID'])
    expect(await card.locator('dd').allTextContents()).toEqual([description, 'fork-worker'])
    expect(await card.getByText('Agent response', { exact: true }).count()).toBe(0)
    await capture('Creation receipt and complete task')
    const beforeReload = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await card.waitFor({ state: 'attached' })
    await expandTask(card, prompt)
    await expectForkSummary()
    await capture('Restored creation receipt')
    acknowledgeReloadConnectionLoss(tripwire, beforeReload)
    await snapshotGolden('fork', snapshots.join('\n\n'))
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['lifecycle.expected.md', 'variants.expected.md', 'fork.expected.md'])
  })
})
