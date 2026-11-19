// Manual diagnostic: main-thread cost of dragging the right Sidebar's resize
// handle beside a long, fully loaded synthetic transcript. It reports frame
// gaps, style recalculation (with the element count it touched), layout, and
// the share of both forced synchronously from script, plus the final column
// and composer widths; host speed is not a correctness contract, so nothing is
// asserted beyond the loaded turn count. Run after `pnpm run build:artifacts`:
//   RB_TURNS=200 RB_SAMPLES=3 RB_STEPS=40 DSH_SNAPSHOT=replay \
//     pnpm exec vitest run --config vitest.web.perf.config.ts apps/web/tests/rightbar-drag.perf.ts
import { performance } from 'node:perf_hooks'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  type ToolCallId,
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, type SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { launchWebScaffold, seedSession, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const TURNS = Number(process.env.RB_TURNS ?? 200)
const SAMPLES = Number(process.env.RB_SAMPLES ?? 3)
const STEPS = Number(process.env.RB_STEPS ?? 40)
const STEP_PX = 8
const STEP_GAP_MS = 8
const SESSION_ID = 'perf-rightbar-drag'
const TAIL = '[data-chat-flow-key*="turn-tail"]'
/** A narrow window where the column falls below the content width, a wide one, and a wide one with a dragged preference. */
const SCENARIOS = [
  { viewport: 1680, preference: null },
  { viewport: 2560, preference: null },
  { viewport: 2560, preference: 720 },
] as const

function prose(turn: number): string {
  const paragraph = `Turn ${String(turn)} synthetic analysis: the renderer measures every row, wraps mixed text 混合中文段落用于换行测量, and keeps \`inline code\` beside **bold** words. `
  const parts = [paragraph.repeat(6), paragraph.repeat(4)]
  parts.push(Array.from({ length: 6 }, (_, i) => `- item ${String(i)}: ${paragraph.slice(0, 120)}`).join('\n'))
  if (turn % 10 === 0) parts.push('```ts\n' + Array.from({ length: 40 }, (_, i) => `const value${String(i)} = compute(${String(i)}, "${'x'.repeat(30)}")`).join('\n') + '\n```')
  if (turn % 15 === 0) parts.push('| a | b | c |\n|---|---|---|\n' + Array.from({ length: 8 }, (_, i) => `| ${String(i)} | ${paragraph.slice(0, 60)} | ${String(i * 3)} |`).join('\n'))
  return parts.join('\n\n')
}

function historyFixture(): string {
  const session = Session.create(brandString<SessionId>(SESSION_ID))
  for (let turn = 1; turn <= TURNS; turn++) {
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) session.append('system/message', { turn, step: 1, message: createSystemMessage('') }, { surfaceOp: 'append' })
    const user = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `Question ${String(turn)}: ` + '请检查宽度变化时的排版。 '.repeat(12) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    if (turn === 1) session.append('session/title', { title: 'RIGHTBAR_DRAG_PERF', messageSeqs: [user.seq], source: { kind: 'fallback' } })
    const tool = turn % 5 === 0
    const callId = brandString<ToolCallId>(`rb-call-${String(turn)}`)
    session.append('assistant/message', {
      turn, step: 1, stream: [],
      message: createAssistantMessage({
        source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        content: [
          { type: 'reasoning', text: 'Compare the synthetic module and test. '.repeat(20) },
          { type: 'text', text: prose(turn) },
          ...tool ? [{ type: 'tool-call' as const, id: callId, name: 'synthetic_tool', arguments: '{"path":"src/a.ts"}' }] : [],
        ],
      }),
      usage: { inputTokens: 4000, outputTokens: 800 },
    }, { surfaceOp: 'append' })
    if (tool) {
      const call = session.append('tool/call', { turn, step: 1, callId, name: 'synthetic_tool', arguments: '{"path":"src/a.ts"}' })
      session.append('tool/result', { turn, step: 1, message: createToolResultMessage({
        callId, isError: false, content: [{ type: 'text', text: 'Synthetic tool output line.\n'.repeat(40) }],
      }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    }
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return [JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 1700000000000, cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }),
    ...session.snapshotEvents().map(event => JSON.stringify(event)), ''].join('\n')
}

interface TraceEvent {
  name: string
  ph: string
  dur?: number
  ts: number
  tid: number
  pid: number
  args?: { elementCount?: number }
}

const SCRIPT_EVENTS = new Set(['FunctionCall', 'EventDispatch', 'FireAnimationFrame', 'TimerFire', 'RunMicrotasks', 'v8.callFunction'])

/** Frame timestamps the page collects during one drag. */
type FrameProbe = Window & { rightbarFrames?: { frames: number[]; running: boolean } }

/** Sum style recalculation, layout, and the share of each forced synchronously from script. */
function summarizeTrace(buffer: Buffer): Record<string, number> {
  const parsed = JSON.parse(buffer.toString('utf8')) as { traceEvents: TraceEvent[] } | TraceEvent[]
  const events = (Array.isArray(parsed) ? parsed : parsed.traceEvents).filter(e => e.ph === 'X')
  const scripts = events.filter(e => SCRIPT_EVENTS.has(e.name))
  // Style or layout run inside a script task is forced (synchronous) by a geometry read or style query.
  const nested = (e: TraceEvent) => scripts.some(s =>
    s.tid === e.tid && s.pid === e.pid && s.ts <= e.ts && e.ts + (e.dur ?? 0) <= s.ts + (s.dur ?? 0))
  const ms = (list: TraceEvent[]) => list.reduce((t, e) => t + (e.dur ?? 0), 0) / 1000
  const layouts = events.filter(e => e.name === 'Layout')
  const styles = events.filter(e => e.name === 'UpdateLayoutTree')
  const forcedLayouts = layouts.filter(nested)
  const forcedStyles = styles.filter(nested)
  return {
    layoutMs: ms(layouts), layouts: layouts.length,
    forcedLayouts: forcedLayouts.length, forcedLayoutMs: ms(forcedLayouts),
    styleMs: ms(styles), styles: styles.length,
    forcedStyles: forcedStyles.length, forcedStyleMs: ms(forcedStyles),
    styledElements: styles.reduce((t, e) => t + (e.args?.elementCount ?? 0), 0),
    maxStyleMs: Math.max(0, ...styles.map(e => (e.dur ?? 0) / 1000)),
    maxLayoutMs: Math.max(0, ...layouts.map(e => (e.dur ?? 0) / 1000)),
    scriptMs: ms(events.filter(e => e.name === 'FunctionCall' || e.name === 'EventDispatch' || e.name === 'FireAnimationFrame')),
    paintMs: ms(events.filter(e => e.name === 'Paint')),
  }
}

async function loadAll(page: Page): Promise<number> {
  let count = await page.locator(TAIL).count()
  while (count < TURNS) {
    const more = page.getByRole('button', { name: 'Load earlier', exact: true })
    await more.click({ timeout: 60_000 })
    await page.waitForFunction(
      ({ selector, previous }) => document.querySelectorAll(selector).length > previous,
      { selector: TAIL, previous: count },
      { timeout: 60_000 },
    )
    count = await page.locator(TAIL).count()
  }
  return count
}

async function dragOnce(browser: Browser, page: Page, direction: 1 | -1): Promise<Record<string, number>> {
  const handle = page.locator('[data-side="rightbar"]')
  const box = await handle.boundingBox()
  if (box === null) throw new Error('rightbar handle missing')
  const x0 = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.evaluate(() => {
    const probe = { frames: [] as number[], running: true }
    ;(window as FrameProbe).rightbarFrames = probe
    const tick = (t: number) => { if (!probe.running) return; probe.frames.push(t); requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  })
  await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] })
  await page.mouse.move(x0, y)
  await page.mouse.down()
  const start = performance.now()
  for (let i = 1; i <= STEPS; i++) {
    await page.mouse.move(x0 - direction * i * STEP_PX, y)
    await page.waitForTimeout(STEP_GAP_MS)
  }
  const moved = performance.now()
  await page.mouse.up()
  // Settled: the last frame within a 600 ms window whose transcript column or composer width differs from its predecessor.
  const settle = await page.evaluate(() => new Promise<{ settleMs: number; columnWidth: number; composerWidth: number }>((resolve) => {
    const start = window.performance.now()
    const read = () => [
      document.querySelector('[data-chat-flow]')?.getBoundingClientRect().width ?? 0,
      document.querySelector('[data-composer-input]')?.getBoundingClientRect().width ?? 0,
    ]
    let last = read()
    let changedAt = 0
    const tick = (t: number) => {
      const next = read()
      if (next[0] !== last[0] || next[1] !== last[1]) changedAt = t - start
      last = next
      if (t - start < 600) requestAnimationFrame(tick)
      else resolve({ settleMs: changedAt, columnWidth: next[0]!, composerWidth: next[1]! })
    }
    requestAnimationFrame(tick)
  }))
  const settled = moved + settle.settleMs
  const trace = summarizeTrace(await browser.stopTracing())
  const frames = await page.evaluate(() => {
    const probe = (window as FrameProbe).rightbarFrames!
    probe.running = false
    return probe.frames
  })
  const gaps = frames.slice(1).map((t, i) => t - frames[i]!).sort((a, b) => a - b)
  const pick = (q: number) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * q))] ?? 0
  return {
    dragMs: moved - start, settleMs: settle.settleMs, totalMs: settled - start,
    columnWidth: settle.columnWidth, composerWidth: settle.composerWidth,
    frames: frames.length, frameP50: pick(0.5), frameP95: pick(0.95), frameMax: gaps.at(-1) ?? 0,
    ...trace,
  }
}

function median(values: number[]): number {
  return values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!
}

it(`drags the right Sidebar beside ${String(TURNS)} loaded turns`, async () => {
  if (webSnapshotMode() !== 'replay') throw new Error('requires DSH_SNAPSHOT=replay')
  const scaffold = await launchWebScaffold()
  const results: Record<string, Record<string, number>[]> = {}
  try {
    await seedSession(scaffold, historyFixture(), SESSION_ID)
    const browser = await chromium.launch({ headless: true })
    try {
      for (const { viewport, preference } of SCENARIOS) {
        for (let sample = 0; sample < SAMPLES; sample++) {
          const page = await newEnglishPage(browser)
          await page.setViewportSize({ width: viewport, height: 1000 })
          page.setDefaultTimeout(60_000)
          if (preference !== null) await page.addInitScript((value) => { localStorage.setItem('dsh.conversation.contentWidth', value) }, String(preference))
          await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
          await page.getByRole('treeitem').first().click()
          await page.getByRole('treeitem').nth(1).click()
          await page.locator(TAIL).last().waitFor()
          const loaded = await loadAll(page)
          expect(loaded).toBe(TURNS)
          await page.getByRole('button', { name: 'Open right sidebar' }).first().click()
          await page.locator('[data-side="rightbar"]').waitFor()
          await page.waitForTimeout(800)
          const nodes = await page.evaluate(() => document.querySelectorAll('*').length)
          for (const direction of [1, -1] as const) {
            const key = `${String(viewport)}/${preference === null ? 'auto' : 'pref' + String(preference)}/${direction === 1 ? 'widen' : 'narrow'}`
            const result = { ...await dragOnce(browser, page, direction), nodes }
            ;(results[key] ??= []).push(result)
            console.log(JSON.stringify({ rb: 'sample', key, sample, ...result }))
          }
          await page.close()
        }
      }
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
  const summary = Object.fromEntries(Object.entries(results).map(([key, samples]) => [key,
    Object.fromEntries(Object.keys(samples[0]!).map(metric => [metric, Math.round(median(samples.map(s => s[metric]!)) * 10) / 10]))]))
  console.log(JSON.stringify({ rb: 'median', turns: TURNS, steps: STEPS, summary }, null, 1))
})
