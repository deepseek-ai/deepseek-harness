/** Keyless assembled-Web evidence for syntax highlighting during a streamed code fence. */

import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/streaming-fence-highlight', import.meta.url))
const MID_EXPECTED = fileURLToPath(new URL('./snapshots/streaming-fence-highlight/mid-stream.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const PROVIDER = 'streaming-fence-highlight-test'
const MODEL = 'streaming-fence'
const PROMPT = 'Stream one TypeScript fence for the highlighting snapshot.'
const FIRST_REPLY = '```ts\nconst first: number = 1\n'
const OPEN_REPLY = `${FIRST_REPLY}const second = "two"\nlet tail`
const REPLY = `${OPEN_REPLY}\n\`\`\``

/** Deterministic model response held after each visible fence-growth frame. */
class StreamingFenceAdapter extends LlmAdapter {
  private resolveFirstPaused!: () => void
  private resolveFirstContinuation!: () => void
  private resolveSecondPaused!: () => void
  private resolveSecondContinuation!: () => void
  private firstContinued = false
  private secondContinued = false
  readonly firstPaused = new Promise<void>((resolve) => { this.resolveFirstPaused = resolve })
  readonly secondPaused = new Promise<void>((resolve) => { this.resolveSecondPaused = resolve })
  private readonly firstContinuation = new Promise<void>((resolve) => { this.resolveFirstContinuation = resolve })
  private readonly secondContinuation = new Promise<void>((resolve) => { this.resolveSecondContinuation = resolve })

  grow(): void {
    if (this.firstContinued) return
    this.firstContinued = true
    this.resolveFirstContinuation()
  }

  finish(): void {
    if (this.secondContinued) return
    this.secondContinued = true
    this.resolveSecondContinuation()
  }

  continue(): void {
    this.grow()
    this.finish()
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: FIRST_REPLY }
    this.resolveFirstPaused()
    await this.firstContinuation
    yield { type: 'text-delta', index: 0, text: OPEN_REPLY.slice(FIRST_REPLY.length) }
    this.resolveSecondPaused()
    await this.secondContinuation
    if (options.signal?.aborted === true) throw options.signal.reason
    yield { type: 'text-delta', index: 0, text: '\n```' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: REPLY } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface FenceTree {
  language: string
  pre: { className: string; style: string | null; tabIndex: string | null }
  lines: { text: string; style: string | null }[][]
}

/** Read the stable, user-visible subset of one rendered code fence. */
async function fenceTree(block: ReturnType<Page['locator']>): Promise<FenceTree> {
  return await block.evaluate((element) => {
    const pre = element.querySelector<HTMLPreElement>('pre.shiki')
    if (pre === null) throw new Error('streaming fence did not render through the shiki arm')
    return {
      language: element.querySelector('[class*="infostring"]')?.textContent ?? '',
      pre: {
        className: pre.className,
        style: pre.style.cssText,
        tabIndex: pre.getAttribute('tabindex'),
      },
      lines: [...pre.querySelectorAll('.line')].map(line =>
        [...line.querySelectorAll('span')].map(span => ({
          text: span.textContent ?? '',
          style: span.style.cssText,
        })),
      ),
    }
  })
}

describe.skipIf(MODE === 'record')('web e2e: streaming code-fence highlighting', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const adapter = new StreamingFenceAdapter()

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    scaffold.ctx.effect(
      () => scaffold.ctx.llm.registerAdapter([PROVIDER], adapter),
      'streaming fence highlight adapter',
    )
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    adapter.continue()
    await browser?.close()
    await scaffold?.close()
  })

  it('renders the growing fence through shiki and preserves its token tree when the turn settles', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-streaming-fence-highlight'))
    const input = page.locator('[data-composer-input]').first()
    const settled = scaffold.whenTurnSettled(30_000)
    await writeComposerDraft(page, input, PROMPT)
    await input.press('Enter')
    await adapter.firstPaused

    const streaming = page.locator('[data-streaming="true"]')
    await streaming.waitFor({ timeout: 10_000 })
    const block = streaming.locator('.md-code-block').filter({ hasText: 'const first' })
    await block.locator('pre.shiki span[style]').first().waitFor({ timeout: 10_000 })
    await block.evaluate((element) => {
      element.setAttribute('data-stream-block-retained', 'true')
      element.querySelector('pre.shiki')?.setAttribute('data-stream-pre-retained', 'true')
      element.querySelector('pre.shiki .line')?.setAttribute('data-stream-line-retained', 'true')
    })

    adapter.grow()
    await adapter.secondPaused
    await expect.poll(() => block.locator('pre.shiki .line').count()).toBe(3)
    expect(await block.evaluate(element => ({
      block: element.getAttribute('data-stream-block-retained'),
      pre: element.querySelector('pre.shiki')?.getAttribute('data-stream-pre-retained'),
      line: element.querySelector('pre.shiki .line')?.getAttribute('data-stream-line-retained'),
    }))).toEqual({ block: 'true', pre: 'true', line: 'true' })
    const midTree = await fenceTree(block)
    expect(midTree.language).toBe('ts')
    expect(midTree.lines).toHaveLength(3)
    expect(midTree.lines.flat().map(span => span.style)).toContain('color: var(--shiki-token-keyword);')

    const aria = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(
      MID_EXPECTED,
      `${aria}\n\n---\n\n${JSON.stringify(midTree, null, 2)}`,
      MODE,
    )

    adapter.finish()
    await settled
    await expect.poll(() => page.locator('[data-streaming="true"]').count(), { timeout: 10_000 }).toBe(0)
    const settledBlock = page.locator('.md-code-block').filter({ hasText: 'const first' })
    await settledBlock.locator('pre.shiki').waitFor({ timeout: 10_000 })
    expect(await fenceTree(settledBlock)).toEqual(midTree)
    expect(await settledBlock.evaluate(element => ({
      block: element.getAttribute('data-stream-block-retained'),
      pre: element.querySelector('pre.shiki')?.getAttribute('data-stream-pre-retained'),
      line: element.querySelector('pre.shiki .line')?.getAttribute('data-stream-line-retained'),
    }))).toEqual({ block: 'true', pre: 'true', line: 'true' })
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['mid-stream.expected.md'])
  }, 60_000)
})
