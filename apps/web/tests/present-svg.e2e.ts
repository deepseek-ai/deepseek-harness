/** An explicit file-card request exercises SVG delivery without naming the present tool. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import {
  assertFinalWorkspaceSnapshot, captureExpandedTurnProcessAria, compareOrRefreshGolden,
  fixtureUserPrompts, launchWebScaffold, recordFixture, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspaceZh, ZH_BROWSER_LOCALE } from './support.ts'

const DIR = fileURLToPath(new URL('../../../snapshots/web/present-svg', import.meta.url))
const FIXTURE = join(DIR, 'session.v3.jsonl')
const MODE = webSnapshotMode()
const RECORD_PROMPT = '简单画一个 SVG 表示冯诺依曼架构，保存为 von-neumann.svg，并提供独立文件卡片，方便打开。'
const FILE = 'von-neumann.svg'

describe('web e2e: requested SVG is explicitly delivered', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let cwd: string
  let replayRoot: string | undefined
  const connectionDiagnostics: string[] = []

  beforeAll(async () => {
    let replayOverride: string | undefined
    if (MODE !== 'record') {
      replayRoot = await mkdtemp(join(tmpdir(), 'dsh-present-svg-replay-'))
      replayOverride = join(replayRoot, 'replay.override.json')
      const script = deriveReplayScript(parseSessionLog(await readFile(FIXTURE, 'utf8')))
      // Recorded absolute paths must follow each isolated Session's working directory.
      const cwdToken = '{{fromRequest:Your working directory is ([^\\n]+)\\.}}'
      await writeFile(replayOverride, JSON.stringify(script).replaceAll('{{cwd}}', JSON.stringify(cwdToken).slice(1, -1)))
    }
    scaffold = await launchWebScaffold({
      compareReplaySession: true,
      extraOverlayPath: fileURLToPath(new URL('./present-svg.overlay.yml', import.meta.url)),
      ...(replayOverride === undefined ? {} : { replayFixture: FIXTURE, replayOverride }),
    })
    browser = await chromium.launch()
    page = await browser.newPage({
      viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE, timezoneId: 'Asia/Shanghai',
    })
    tripwire = watchConsole(page)
    page.on('console', (message) => {
      if (message.text().startsWith('[connection]')) connectionDiagnostics.push(message.text())
    })
    page.on('websocket', (socket) => {
      const openedAt = Date.now()
      let received = 0
      socket.on('framereceived', () => { received++ })
      socket.on('socketerror', (error) => { connectionDiagnostics.push(error) })
      socket.on('close', () => {
        connectionDiagnostics.push(`WebSocket closed after ${Date.now() - openedAt}ms and ${received} received frames`)
      })
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]')
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  })

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      try {
        await scaffold?.close()
      } finally {
        if (replayRoot !== undefined) await rm(replayRoot, { recursive: true, force: true })
      }
    }
  })

  it('writes valid SVG and provides the requested file card before the final reply', async () => {
    const prompts = MODE === 'record' ? [RECORD_PROMPT] : fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
    expect(prompts).toHaveLength(1)
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(prompts[0]!)
    await input.press('Enter')
    const sessionId = await settled
    const session = scaffold.ctx.agents.get(sessionId)?.session
    if (session?.header.cwd === undefined) throw new Error('SVG Session has no workspace')
    cwd = session.header.cwd
    if (MODE === 'record') await recordFixture(scaffold, sessionId, FIXTURE)

    const svg = await readFile(join(cwd, FILE), 'utf8')
    const parsedSvg = await page.evaluate((source) => {
      const parsed = new DOMParser().parseFromString(source, 'image/svg+xml')
      return {
        root: parsed.documentElement.localName,
        namespace: parsed.documentElement.namespaceURI,
        errors: parsed.querySelectorAll('parsererror').length,
      }
    }, svg)
    expect(parsedSvg).toEqual({ root: 'svg', namespace: 'http://www.w3.org/2000/svg', errors: 0 })

    const events = session.snapshotEvents()
    const declarations = events.filter(event => event.type === 'deliverables/presented')
    const delivery = declarations.find(event => event.data.files.some(file => resolve(cwd, file.path) === join(cwd, FILE)))
    expect(delivery, 'explicit file-card delivery requires a successful present declaration').toBeDefined()
    if (delivery === undefined) throw new Error('SVG was written but not delivered')
    expect(events.some(event => (
      event.type === 'tool/call' && event.data.name === 'present' && event.data.callId === delivery.data.callId
    ) || (
      event.type === 'tool/ptc-dispatch' && event.data.name === 'present'
      && event.data.subCallId === delivery.data.callId && !event.data.isError
    ))).toBe(true)
    expect(events.some(event => event.type === 'assistant/message' && event.seq > delivery.seq
      && event.data.message.content.some(block => block.type === 'text'))).toBe(true)

    const card = page.locator('[data-presented-file]').filter({ hasText: FILE })
    await card.waitFor({ state: 'visible' })
    expect(await card.count()).toBe(1)
    expect(await page.getByText('产物', { exact: true }).count()).toBe(0)
    // The scaffold workspace is not a git repository; the write call supplies its single changed file.
    const changes = page.locator('[data-changed-files]')
    expect(await changes.count()).toBe(1)
    expect(await changes.getByText(`已编辑 ${FILE}`, { exact: true }).count()).toBe(1)
    expect(await changes.getByRole('list').count()).toBe(0)
    expect(await changes.locator('svg').evaluate(icon => icon.innerHTML))
      .toBe(await card.locator('svg').evaluate(icon => icon.innerHTML))
    expect(await changes.evaluate(element => element.getBoundingClientRect().height)).toBe(62)
    const appearance = await page.evaluate(() => {
      const previous = document.body.getAttribute('data-ds-dark-theme')
      try {
        return [false, true].map((dark) => {
          document.body.toggleAttribute('data-ds-dark-theme', dark)
          const cards = ['[data-presented-file]', '[data-changed-files]'].map((selector) => {
            const card = document.querySelector(selector)!
            const tile = card.querySelector('svg')!.parentElement!
            return { fill: getComputedStyle(tile).backgroundColor, tileBorder: getComputedStyle(tile).border,
              cardBorder: getComputedStyle(card).border }
          })
          return { fills: cards.map(card => card.fill), matchingTiles: cards[0]!.tileBorder === cards[1]!.tileBorder,
            matchingCards: cards[0]!.cardBorder === cards[1]!.cardBorder }
        })
      } finally {
        if (previous === null) document.body.removeAttribute('data-ds-dark-theme')
        else document.body.setAttribute('data-ds-dark-theme', previous)
      }
    })
    expect(appearance).toEqual([
      { fills: ['color(srgb 1 1 1 / 0.5)', 'color(srgb 1 1 1 / 0.5)'], matchingTiles: true, matchingCards: true },
      { fills: ['color(srgb 1 1 1 / 0.05)', 'color(srgb 1 1 1 / 0.05)'], matchingTiles: true, matchingCards: true },
    ])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings, connectionDiagnostics.join('\n')).toEqual([])
  })

  it.skipIf(MODE === 'record')('replays the delivered file and Chinese conversation', async () => {
    await assertFinalWorkspaceSnapshot(DIR, cwd)
    expect(await page.locator('[data-presented-file] [data-open-target]').count()).toBe(0)
    // Delivery owns the transcript; navigation and composer chrome have separate scenarios.
    const aria = await captureExpandedTurnProcessAria(page, '[data-chat-flow]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(DIR, 'ui.expected.md'), aria, MODE)
  })

  it('opens the single edited file from its compact card', async () => {
    await page.locator('[data-changed-files]').getByRole('button', { name: `查看 ${FILE} 的改动` }).click()
    const review = page.locator('[data-changes-review]')
    await review.waitFor({ state: 'visible' })
    expect(await review.getByRole('button', { name: '选择要查看的文件' }).innerText()).toContain(FILE)
    expect(tripwire.pageErrors).toEqual([])
  })
})
