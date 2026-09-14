/** A file request elicits explicit SVG delivery without naming the present tool. */
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
const PROMPT = '简单画一个 SVG 表示冯诺依曼架构, 保存为 von-neumann.svg'
const FILE = 'von-neumann.svg'

describe('web e2e: requested SVG is explicitly delivered', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let cwd: string
  let replayRoot: string | undefined

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

  it('writes valid SVG and calls present before the final reply', async () => {
    if (MODE !== 'record') expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(PROMPT)
    await input.press('Enter')
    const sessionId = await settled
    const session = scaffold.ctx.agents.get(sessionId)?.session
    if (session?.header.cwd === undefined) throw new Error('SVG Session has no workspace')
    cwd = session.header.cwd
    if (MODE === 'record') await recordFixture(scaffold, sessionId, FIXTURE)

    const svg = await readFile(join(cwd, FILE), 'utf8')
    const document = await page.evaluate((source) => {
      const parsed = new DOMParser().parseFromString(source, 'image/svg+xml')
      return {
        root: parsed.documentElement.localName,
        namespace: parsed.documentElement.namespaceURI,
        errors: parsed.querySelectorAll('parsererror').length,
      }
    }, svg)
    expect(document).toEqual({ root: 'svg', namespace: 'http://www.w3.org/2000/svg', errors: 0 })

    const events = session.snapshotEvents()
    const declarations = events.filter(event => event.type === 'deliverables/presented')
    const delivery = declarations.find(event => event.data.files.some(file => resolve(cwd, file.path) === join(cwd, FILE)))
    expect(delivery, 'the file request must produce a successful present declaration').toBeDefined()
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
    if (await page.locator('[data-produced-files-row]').count() > 0) {
      expect(await page.getByText('本轮文件改动', { exact: true }).count()).toBe(1)
    }
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it.skipIf(MODE === 'record')('replays the delivered file and Chinese conversation', async () => {
    await assertFinalWorkspaceSnapshot(DIR, cwd)
    await expect.poll(() => page.getByRole('button', { name: `${FILE} 的更多文件操作`, exact: true }).isDisabled()).toBe(true)
    // Delivery owns the transcript; navigation and composer chrome have separate scenarios.
    const aria = await captureExpandedTurnProcessAria(page, '[data-chat-flow]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(DIR, 'ui.expected.md'), aria, MODE)
  })
})
