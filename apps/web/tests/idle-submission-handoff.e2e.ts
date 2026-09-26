/** Keep idle submissions in Chat across independently delivered Inbox and transcript frames. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type { InboxState } from '@deepseek-ai/dsh-agent/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import {
  parseRemoteStreamClientMessage, parseRemoteStreamServerMessage,
} from '@deepseek-ai/dsh-api-gateway/stream-protocol'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/live-interactions/session.v3.jsonl', import.meta.url))
const SESSION_ID = 'idle-submission-handoff'
const TEXT = 'IDLE_SUBMISSION_HANDOFF Keep this message in the conversation.'

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

  turnEndDelivery(): Delivery | undefined { return this.buffered.find(item => item.event?.type === 'turn/end') }

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
    const releasePrompt = Promise.withResolvers<undefined>()
    const promptBlocked = Promise.withResolvers<undefined>()
    const gate = new HistoryDeliveryGate()
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      await seedSession(scaffold, await readFile(FIXTURE, 'utf8'), SESSION_ID)
      browser = await chromium.launch()
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
      await page.route('**/api/session/prompt', async (route) => {
        promptBlocked.resolve(undefined)
        await releasePrompt.promise
        await route.continue()
      }, { times: 1 })
      const trace: Array<{ phase: string } & Awaited<ReturnType<typeof placement>>> = []
      const settled = scaffold.whenTurnSettled()
      gate.holding = true
      const input = page.locator('[data-composer-input]').first()
      await input.fill(TEXT)
      await input.press('Enter')
      await promptBlocked.promise
      await expect.poll(() => placement(page)).toMatchObject({ echo: 1, dock: 0, durable: 0 })
      trace.push({ phase: 'optimistic', ...await placement(page) })
      releasePrompt.resolve(undefined)

      if (order === 'transcript-first') {
        await expect.poll(() => gate.turnStartDelivery()).toBeDefined()
        gate.releaseThrough(gate.turnStartDelivery()!)
        await page.locator('[data-turn-process]').last().filter({ hasText: 'Deep diving' }).waitFor()
        await expect.poll(() => placement(page)).toMatchObject({ echo: 1, dock: 0, durable: 0 })
        trace.push({ phase: 'turn-start', ...await placement(page) })
        await expect.poll(() => gate.admissionDelivery()).toBeDefined()
        gate.releaseThrough(gate.admissionDelivery()!)
        await expect.poll(() => placement(page)).toMatchObject({ echo: 0, dock: 0, durable: 1 })
        trace.push({ phase: 'durable-before-inbox', ...await placement(page) })
      }

      await expect.poll(() => gate.inboxDelivery(true)).toBeDefined()
      gate.releaseThrough(gate.inboxDelivery(true)!)
      await expect.poll(() => placement(page)).toMatchObject({ echo: order === 'inbox-first' ? 1 : 0, dock: 0, durable: order === 'transcript-first' ? 1 : 0 })
      trace.push({ phase: 'inbox', ...await placement(page) })

      await expect.poll(() => gate.inboxDelivery(false)).toBeDefined()
      gate.releaseThrough(gate.inboxDelivery(false)!)
      await expect.poll(() => placement(page)).toMatchObject({ echo: order === 'inbox-first' ? 1 : 0, dock: 0, durable: order === 'transcript-first' ? 1 : 0 })
      trace.push({ phase: 'claim-projection', ...await placement(page) })

      if (order === 'inbox-first') {
        await expect.poll(() => gate.turnStartDelivery()).toBeDefined()
        gate.releaseThrough(gate.turnStartDelivery()!)
        await page.locator('[data-turn-process]').last().filter({ hasText: 'Deep diving' }).waitFor()
        await expect.poll(() => placement(page)).toMatchObject({ echo: 1, dock: 0, durable: 0 })
        trace.push({ phase: 'turn-start', ...await placement(page) })
      }

      gate.releaseAll()
      await expect.poll(() => placement(page)).toMatchObject({ echo: 0, dock: 0, durable: 1 })
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
      releasePrompt.resolve(undefined)
      gate.releaseAll()
      try { await browser?.close() } finally { await scaffold.close() }
    }
  },
)

it.skipIf(webSnapshotMode() === 'record').each(['ABC', 'ACB', 'BAC', 'BCA', 'CAB', 'CBA'])(
  'hands off three rapid submissions through all Turns in Host order %s', async (hostOrder) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-input-handoff-'))
    const releases = new Map(['A', 'B', 'C'].map(id => [id, Promise.withResolvers<undefined>()]))
    const blocked = new Set<string>()
    const gate = new HistoryDeliveryGate()
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    let scaffold: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
    try {
      const fixture = await readFile(FIXTURE, 'utf8')
      const recorded = deriveReplayScript(parseSessionLog(fixture))
      expect(recorded).toHaveLength(1)
      const override = join(root, 'replay.override.json')
      await writeFile(override, JSON.stringify([recorded[0], recorded[0], recorded[0]]))
      scaffold = await launchWebScaffold({ replayFixture: FIXTURE, replayOverride: override, compareReplaySession: false })
      await seedSession(scaffold, fixture, SESSION_ID)
      browser = await chromium.launch()
      const page = await newEnglishPage(browser)
      const tripwire = watchConsole(page)
      await gate.install(page)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.locator('[role="treeitem"]').first().click()
      await page.locator('[role="treeitem"]').nth(1).click()
      await page.locator('[data-chat-flow-kind="user"]').first().waitFor()
      await page.getByRole('button', { name: 'Send message', exact: true }).waitFor()
      const text = (id: string) => `RAPID_INPUT_${id}`
      await page.route('**/api/session/prompt', async (route) => {
        const request = route.request().postData() ?? ''
        const id = [...releases.keys()].find(id => request.includes(text(id)))
        if (id === undefined) throw new Error('unexpected prompt in rapid input fixture')
        blocked.add(id)
        await releases.get(id)!.promise
        await route.continue()
      })
      gate.holding = true
      const input = page.locator('[data-composer-input]').first()
      for (const id of releases.keys()) {
        await input.fill(text(id))
        await input.press('Enter')
        await expect.poll(() => blocked.has(id)).toBe(true)
        await expect.poll(() => placement(page, text(id))).toMatchObject({ echo: 1, dock: 0, durable: 0 })
      }
      const entered: string[] = []
      for (const id of hostOrder) {
        const settled = scaffold.whenTurnSettled()
        releases.get(id)!.resolve(undefined)
        await expect.poll(() => gate.turnStartDelivery()).toBeDefined()
        gate.releaseThrough(gate.turnStartDelivery()!)
        await expect.poll(() => gate.admissionDelivery(text(id))).toBeDefined()
        gate.releaseThrough(gate.admissionDelivery(text(id))!)
        entered.push(id)
        for (const candidate of releases.keys()) {
          const admitted = entered.includes(candidate)
          await expect.poll(() => placement(page, text(candidate))).toMatchObject({
            echo: admitted ? 0 : 1, dock: 0, durable: admitted ? 1 : 0,
          })
        }
        await expect.poll(() => gate.inboxDelivery(true, text(id))).toBeDefined()
        gate.releaseThrough(gate.inboxDelivery(true, text(id))!)
        await expect.poll(() => placement(page, text(id))).toMatchObject({ echo: 0, dock: 0, durable: 1 })
        await expect.poll(() => gate.inboxDelivery(false, text(id))).toBeDefined()
        gate.releaseThrough(gate.inboxDelivery(false, text(id))!)
        await expect.poll(() => gate.turnEndDelivery()).toBeDefined()
        gate.releaseThrough(gate.turnEndDelivery()!)
        await settled
      }
      gate.releaseAll()
      const actual = await page.locator('[data-chat-flow-kind="user"]').allTextContents()
      expect(actual.filter(value => value.includes('RAPID_INPUT_')).map(value =>
        [...releases.keys()].find(id => value.includes(text(id))))).toEqual(hostOrder.split(''))
      expect(await page.locator('[data-submission-echo]').count()).toBe(0)
      expect(await page.locator('[data-queue-dock]').count()).toBe(0)
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      for (const release of releases.values()) release.resolve(undefined)
      gate.releaseAll()
      try { await browser?.close() } finally {
        try { await scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
      }
    }
  },
)
