/**
 * Opt-in browser stress reproduction for reasoning-stream renderer stalls.
 * A test-owned model adapter emits 100,000 individual chunks through the real
 * Host, Gateway, and browser carriers; the test measures event-loop and
 * scheduled-interaction delay while the assembled React surface keeps a
 * collapsed Think row live.
 */
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { launchWebScaffold, watchConsole, type WebScaffold } from '../tests/scaffold.ts'
import {
  connectFreshWorkspace, newEnglishPage, saveFailureShot, writeComposerDraft,
} from '../tests/support.ts'

const CHUNK_COUNT = 100_000
const CHUNKS_PER_INTERVAL = 128
const CHUNK_INTERVAL_MS = 16
const MAIN_THREAD_DELAY_BUDGET_MS = 250
const PROVIDER = 'reasoning-stress-test'
const MODEL = 'reasoning-storm'
const MARKER = `REASONING_STRESS_COMPLETE:${String(CHUNK_COUNT)}`

interface ReasoningChunkStormState {
  chunkCount: number
  chunksPerInterval: number
  intervalMs: number
  emitted: number
  marker: string
  emitting: boolean
}

/** Externally paced model stream whose counters are observed outside the browser. */
class ReasoningStressAdapter extends LlmAdapter {
  private finishStream!: () => void
  private resolveStarted!: () => void
  private resolveCompleted!: () => void
  private releaseBatch: (() => void) | undefined
  private resolveBatch: (() => void) | undefined
  private batchInFlight = false
  private finishRequested = false
  private readonly finishGate = new Promise<void>((resolve) => { this.finishStream = resolve })
  readonly started = new Promise<void>((resolve) => { this.resolveStarted = resolve })
  readonly completed = new Promise<void>((resolve) => { this.resolveCompleted = resolve })
  private emitted = 0
  private emitting = false

  finish(): void {
    this.finishRequested = true
    this.releaseBatch?.()
    this.finishStream()
  }

  async emitNextBatch(): Promise<void> {
    if (!this.emitting || this.releaseBatch === undefined) {
      throw new Error('reasoning stress adapter has no batch awaiting release')
    }
    if (this.batchInFlight) throw new Error('reasoning stress adapter accepts one batch release at a time')
    this.batchInFlight = true
    const delivered = new Promise<void>((resolve) => { this.resolveBatch = resolve })
    const release = this.releaseBatch
    this.releaseBatch = undefined
    release()
    await delivered
  }

  state(): ReasoningChunkStormState {
    return {
      chunkCount: CHUNK_COUNT,
      chunksPerInterval: CHUNKS_PER_INTERVAL,
      intervalMs: CHUNK_INTERVAL_MS,
      emitted: this.emitted,
      marker: MARKER,
      emitting: this.emitting,
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.emitting || this.emitted !== 0) throw new Error('reasoning stress adapter accepts one model call')
    this.emitting = true
    const parts: string[] = []
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    while (this.emitted < CHUNK_COUNT) {
      await new Promise<void>((resolve) => {
        this.releaseBatch = resolve
        if (this.emitted === 0) this.resolveStarted()
        if (this.finishRequested) resolve()
      })
      if (this.finishRequested) break
      options.signal?.throwIfAborted()
      const end = Math.min(this.emitted + CHUNKS_PER_INTERVAL, CHUNK_COUNT)
      while (this.emitted < end) {
        const text = this.emitted === CHUNK_COUNT - 1
          ? `\n${MARKER}`
          : this.emitted % 64 === 63 ? '推理\n' : '推理'
        parts.push(text)
        yield { type: 'reasoning-delta', index: 0, text }
        this.emitted += 1
      }
      this.batchInFlight = false
      this.resolveBatch?.()
      this.resolveBatch = undefined
    }
    this.emitting = false
    if (this.emitted === CHUNK_COUNT) this.resolveCompleted()
    await this.finishGate
    options.signal?.throwIfAborted()
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: parts.join('') } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface StressProbe {
  intervalId: number
  intervalMs: number
  lastTickAt: number
  maxDelayMs: number
  samples: number
  interactionDueAt: number
  interactionHandledAt: number | null
}

interface StressWindow extends Window {
  __reasoningStressProbe?: StressProbe
}

it('keeps the browser responsive while rendering 100,000 reasoning chunks', async () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page | undefined
  const adapter = new ReasoningStressAdapter()
  try {
    scaffold = await launchWebScaffold()
    scaffold.ctx.effect(
      () => scaffold!.ctx.llm.registerAdapter([PROVIDER], adapter),
      'reasoning stress adapter',
    )
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })
    browser = await chromium.launch({ headless: process.env.DSH_WEB_STRESS_HEADFUL !== '1' })
    page = await newEnglishPage(browser)
    const activePage = page
    const tripwire = watchConsole(activePage)
    onTestFailed(() => saveFailureShot(activePage, 'web-stress-reasoning-chunks'))
    await activePage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await activePage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(activePage, scaffold.workspaceCwd)

    await activePage.evaluate(() => {
      const intervalMs = 50
      const now = performance.now()
      const probe: StressProbe = {
        intervalId: 0,
        intervalMs,
        lastTickAt: now,
        maxDelayMs: 0,
        samples: 0,
        interactionDueAt: now + 1_000,
        interactionHandledAt: null,
      }
      probe.intervalId = window.setInterval(() => {
        const tickAt = performance.now()
        probe.maxDelayMs = Math.max(probe.maxDelayMs, tickAt - probe.lastTickAt - intervalMs)
        probe.lastTickAt = tickAt
        probe.samples++
      }, intervalMs)
      document.body.addEventListener('reasoning-stress-interaction', () => {
        probe.interactionHandledAt = performance.now()
      }, { once: true })
      window.setTimeout(() => {
        document.body.dispatchEvent(new CustomEvent('reasoning-stress-interaction'))
      }, 1_000)
      ;(window as StressWindow).__reasoningStressProbe = probe
    })

    const settled = scaffold.whenTurnSettled(540_000)
    const input = activePage.locator('[data-composer-input]').first()
    await writeComposerDraft(activePage, input, `Render ${String(CHUNK_COUNT)} reasoning chunks.`)
    await input.press('Enter')
    await adapter.started

    await adapter.emitNextBatch()
    const liveThink = activePage.locator('[data-variant="think"][data-state="running"]').last()
    await liveThink.waitFor({ timeout: 60_000 })
    await activePage.evaluate(intervalMs => new Promise<void>((resolve) => {
      window.setTimeout(resolve, intervalMs)
    }), CHUNK_INTERVAL_MS)
    while (adapter.state().emitted < CHUNK_COUNT) {
      await adapter.emitNextBatch()
      await activePage.evaluate(intervalMs => new Promise<void>((resolve) => {
        window.setTimeout(resolve, intervalMs)
      }), CHUNK_INTERVAL_MS)
    }
    await adapter.completed
    await expect.poll(() => liveThink.textContent(), { timeout: 60_000, interval: 100 }).toContain(MARKER)

    const browserReport = await activePage.evaluate(() => {
      const win = window as StressWindow
      const probe = win.__reasoningStressProbe
      if (probe === undefined) throw new Error('reasoning stress metrics unavailable')
      window.clearInterval(probe.intervalId)
      const interactionDelayMs = probe.interactionHandledAt === null
        ? null
        : probe.interactionHandledAt - probe.interactionDueAt
      return {
        maxMainThreadDelayMs: Math.max(0, probe.maxDelayMs),
        interactionDelayMs,
        heartbeatSamples: probe.samples,
      }
    })
    const report = { ...adapter.state(), ...browserReport }
    process.stdout.write(`reasoning-chunk stress report: ${JSON.stringify(report)}\n`)

    expect(report).toMatchObject({
      chunkCount: CHUNK_COUNT,
      chunksPerInterval: CHUNKS_PER_INTERVAL,
      intervalMs: CHUNK_INTERVAL_MS,
      emitted: CHUNK_COUNT,
    })
    expect(report.heartbeatSamples).toBeGreaterThan(0)
    const interactionDelayMs = report.interactionDelayMs
    if (interactionDelayMs === null) throw new Error(`scheduled interaction was not handled: ${JSON.stringify(report)}`)
    expect(report.maxMainThreadDelayMs, JSON.stringify(report)).toBeLessThan(MAIN_THREAD_DELAY_BUDGET_MS)
    expect(interactionDelayMs, JSON.stringify(report)).toBeLessThan(MAIN_THREAD_DELAY_BUDGET_MS)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    adapter.finish()
    await settled
  } finally {
    adapter.finish()
    await browser?.close()
    await scaffold?.close()
  }
}, 600_000)
