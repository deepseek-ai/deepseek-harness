/** Keep idle submissions in Chat across independently delivered Inbox and transcript frames. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import type { InboxState } from '@deepseek-ai/dsh-agent/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import {
  parseRemoteStreamClientMessage, parseRemoteStreamServerMessage,
} from '@deepseek-ai/dsh-api-gateway/stream-protocol'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/live-interactions/session.v3.jsonl', import.meta.url))
const SESSION_ID = 'idle-submission-handoff'
const TEXT = 'IDLE_SUBMISSION_HANDOFF Keep this message in the conversation.'
const HANDOFF_TIMEOUT_MS = 30_000

interface Delivery {
  readonly stream: string
  readonly inbox?: InboxState
  readonly event?: SessionEvent
  readonly send: () => void
}

/** Delay real Host frames while preserving FIFO within each logical stream. */
class HistoryDeliveryGate {
  private readonly streams = new Map<string, string>()
  private buffered: Delivery[] = []
  holding = false

  async install(page: Page): Promise<void> {
    await page.routeWebSocket('**/api/remote.mux', (socket) => {
      const server = socket.connectToServer()
      socket.onMessage((message) => {
        const frame = parseRemoteStreamClientMessage(String(message))
        if (frame.type === 'open') this.streams.set(frame.streamId, frame.endpoint)
        server.send(message)
      })
      server.onMessage((message) => {
        const frame = parseRemoteStreamServerMessage(String(message))
        const endpoint = this.streams.get(frame.streamId)
        if (!this.holding || (endpoint !== 'session/control' && endpoint !== 'session/follow')) {
          socket.send(message)
          return
        }
        const control = endpoint === 'session/control' && frame.type === 'item'
          ? frame.value as { type: string; sessionId?: string; key?: string; value?: InboxState } : undefined
        const inbox = control?.type === 'projection' && control.sessionId === SESSION_ID && control.key === 'inbox'
          ? control.value : undefined
        const follow = endpoint === 'session/follow' && frame.type === 'item'
          ? frame.value as { type: string; event?: SessionEvent } : undefined
        this.buffered.push({ stream: frame.streamId, send: () => { socket.send(message) },
          ...follow?.event === undefined ? {} : { event: follow.event }, ...inbox === undefined ? {} : { inbox } })
      })
    })
  }

  inboxDelivery(queued: boolean, text = TEXT): Delivery | undefined {
    return this.buffered.find(item => item.inbox !== undefined && item.inbox['next-turn'].some(message =>
      message.content.some(block => block.type === 'text' && block.text === text)) === queued)
  }

  admissionDelivery(text = TEXT): Delivery | undefined {
    return this.buffered.find(item => item.event?.type === 'user/message'
      && item.event.data.content.some(block => block.type === 'text' && block.text === text))
  }

  turnStartDelivery(): Delivery | undefined { return this.buffered.find(item => item.event?.type === 'turn/start') }


  releaseThrough(target: Delivery): void {
    let reached = false
    this.buffered = this.buffered.filter((item) => {
      if (reached || item.stream !== target.stream) return true
      item.send()
      reached = item === target
      return false
    })
  }

  releaseAll(): void {
    this.holding = false
    for (const item of this.buffered) item.send()
    this.buffered = []
  }
}

/** Match the scaffold's turn-completion budget for Host frames and browser rendering. */
function poll<T>(read: () => T) {
  return expect.poll(read, { timeout: HANDOFF_TIMEOUT_MS })
}

/** The caller's await reports Turn failure; an earlier assertion may bypass that await. */
function whenTurnSettled(scaffold: Awaited<ReturnType<typeof launchWebScaffold>>) {
  const settled = scaffold.whenTurnSettled(HANDOFF_TIMEOUT_MS)
  void settled.catch(() => undefined)
  return settled
}

async function placement(page: Page, input = TEXT) {
  return page.evaluate((text) => {
    const matching = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
      .filter(element => element.textContent?.includes(text))
    const echo = matching('[data-submission-echo]')
    const dock = matching('[data-queue-dock] li')
    const durable = matching('[data-chat-flow-kind="user"]')
    return {
      echo: echo.length,
      dock: dock.length,
      durable: durable.length,
      messageTop: (echo[0] ?? dock[0] ?? durable[0])?.getBoundingClientRect().top ?? null,
      composerTop: document.querySelector('[data-composer-card]')?.getBoundingClientRect().top ?? null,
    }
  }, input)
}

it.skipIf(webSnapshotMode() === 'record').each(['inbox-first', 'transcript-first'] as const)(
  'keeps an idle submission in Chat under CPU throttling (%s)', async (order) => {
    const scaffold = await launchWebScaffold({ replayFixture: FIXTURE, compareReplaySession: false })
    onTestFinished(() => scaffold.close())
    const gate = new HistoryDeliveryGate()
    try {
      await seedSession(scaffold, await readFile(FIXTURE, 'utf8'), SESSION_ID)
      const browser = await chromium.launch()
      onTestFinished(() => browser.close())
      const page = await newEnglishPage(browser)
      const tripwire = watchConsole(page)
      await gate.install(page)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.locator('[role="treeitem"]').first().click()
      await page.locator('[role="treeitem"]').nth(1).click()
      await page.locator('[data-chat-flow-kind="user"]').first().waitFor()
      await page.getByRole('button', { name: 'Send message', exact: true }).waitFor()
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 })
      const trace: Array<{ phase: string } & Awaited<ReturnType<typeof placement>>> = []
      gate.holding = true
      const settled = whenTurnSettled(scaffold)
      const input = page.locator('[data-composer-input]').first()
      await input.fill(TEXT)
      await input.press('Enter')
      // The prompt receipt is not a stream frame: the accepted echo shows while the gate holds every Host frame.
      await poll(() => placement(page)).toMatchObject({ echo: 1, dock: 0, durable: 0 })
      trace.push({ phase: 'accepted', ...await placement(page) })

      if (order === 'transcript-first') {
        await poll(() => gate.turnStartDelivery()).toBeDefined()
        gate.releaseThrough(gate.turnStartDelivery()!)
        await page.locator('[data-chat-flow-kind="turn-process"]').last().waitFor({ state: 'attached' })
        await poll(() => placement(page)).toMatchObject({ echo: 1, dock: 0, durable: 0 })
        trace.push({ phase: 'turn-start', ...await placement(page) })
        await poll(() => gate.admissionDelivery()).toBeDefined()
        gate.releaseThrough(gate.admissionDelivery()!)
        await poll(() => placement(page)).toMatchObject({ echo: 0, dock: 0, durable: 1 })
        trace.push({ phase: 'durable-before-inbox', ...await placement(page) })
      }

      await poll(() => gate.inboxDelivery(true)).toBeDefined()
      gate.releaseThrough(gate.inboxDelivery(true)!)
      await poll(() => placement(page)).toMatchObject({ echo: order === 'inbox-first' ? 1 : 0, dock: 0, durable: order === 'transcript-first' ? 1 : 0 })
      trace.push({ phase: 'inbox', ...await placement(page) })

      await poll(() => gate.inboxDelivery(false)).toBeDefined()
      gate.releaseThrough(gate.inboxDelivery(false)!)
      await poll(() => placement(page)).toMatchObject({ echo: order === 'inbox-first' ? 1 : 0, dock: 0, durable: order === 'transcript-first' ? 1 : 0 })
      trace.push({ phase: 'claim-projection', ...await placement(page) })

      if (order === 'inbox-first') {
        await poll(() => gate.turnStartDelivery()).toBeDefined()
        gate.releaseThrough(gate.turnStartDelivery()!)
        await page.locator('[data-chat-flow-kind="turn-process"]').last().waitFor({ state: 'attached' })
        await poll(() => placement(page)).toMatchObject({ echo: 1, dock: 0, durable: 0 })
        trace.push({ phase: 'turn-start', ...await placement(page) })
      }

      gate.releaseAll()
      await poll(() => placement(page)).toMatchObject({ echo: 0, dock: 0, durable: 1 })
      trace.push({ phase: 'durable', ...await placement(page) })
      for (const entry of trace) {
        expect(entry.messageTop, entry.phase).toBe(trace[0]?.messageTop)
        expect(entry.composerTop, entry.phase).toBe(trace[0]?.composerTop)
      }
      await settled
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
      await cdp.detach()
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      gate.releaseAll()
    }
  },
)
