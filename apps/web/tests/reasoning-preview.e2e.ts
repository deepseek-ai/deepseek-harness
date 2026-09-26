/** Streaming reasoning previews through the assembled Chat and a paused model adapter. */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { connectFreshWorkspace, expandOwningTurnProcess, newEnglishPage, writeComposerDraft } from './support.ts'

const SUMMARY = `Next paragraph: ${'inspect the loaded context and pending tools '.repeat(8).trim()}`
const DELTAS = ['First paragraph', `\nDetails\n\n\n${SUMMARY}`, '\nMore detail']
const UI_EXPECTED = fileURLToPath(new URL('./expected/reasoning-preview/running.expected.md', import.meta.url))

class PausedReasoningAdapter extends LlmAdapter {
  override async listModels(provider: string) { return [{ provider, id: 'paused', name: `${provider}/paused` }] }
  readonly stages = DELTAS.map(text => ({
    text,
    arrived: Promise.withResolvers<undefined>(),
    proceed: Promise.withResolvers<undefined>(),
  }))

  release(): void {
    for (const stage of this.stages) stage.proceed.resolve(undefined)
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    for (const stage of this.stages) {
      yield { type: 'reasoning-delta', index: 0, text: stage.text }
      stage.arrived.resolve(undefined)
      await stage.proceed.promise
      options.signal?.throwIfAborted()
    }
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: DELTAS.join('') } }
    yield { type: 'block-start', index: 1, blockType: 'text' }
    yield { type: 'text-delta', index: 1, text: 'Done' }
    yield { type: 'block-end', index: 1, block: { type: 'text', text: 'Done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('shows completed paragraph first lines across blank lines with a right-edge fade', async () => {
  const scaffold = await launchWebScaffold()
  const adapter = new PausedReasoningAdapter()
  try {
    scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter(['reasoning-preview-test'], adapter))
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: 'reasoning-preview-test', model: 'paused' })
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      const console = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await connectFreshWorkspace(page, scaffold.workspaceCwd)
      await page.setViewportSize({ width: 480, height: 1000 })
      const input = page.locator('[data-composer-input]').first()
      const settled = scaffold.whenTurnSettled()
      await writeComposerDraft(page, input, 'Show a streamed reasoning preview.')
      await input.press('Enter')

      const [first, second, third] = adapter.stages
      if (first === undefined || second === undefined || third === undefined) throw new Error('preview stages are incomplete')
      await first.arrived.promise
      const reasoning = page.locator('[data-variant="think"][data-state="running"]')
      await expandOwningTurnProcess(page, reasoning)
      await reasoning.waitFor()
      expect(await reasoning.getAttribute('data-preview')).toBeNull()

      first.proceed.resolve(undefined)
      await second.arrived.promise
      const preview = reasoning.locator('[data-streaming]')
      await expect.poll(() => preview.textContent()).toBe('First paragraph')
      expect(await preview.isVisible()).toBe(true)
      await preview.evaluate((element) => { element.setAttribute('data-retained-preview', 'true') })

      second.proceed.resolve(undefined)
      await third.arrived.promise
      await expect.poll(() => preview.textContent()).toBe(SUMMARY)
      expect(await preview.getAttribute('data-retained-preview')).toBe('true')
      expect(await preview.evaluate(element => getComputedStyle(element).maskImage)).toContain('linear-gradient')
      expect(await preview.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
      expect(await reasoning.getByRole('button').getAttribute('aria-expanded')).toBe('false')
      await compareOrRefreshGolden(UI_EXPECTED,
        await captureStableAria(page, '[data-variant="think"]', scaffold.workspaceCwd), webSnapshotMode())

      third.proceed.resolve(undefined)
      await settled
      await page.getByText('Done', { exact: true }).waitFor()
      expect(console.pageErrors).toEqual([])
      expect(console.warnings).toEqual([])
    } finally {
      adapter.release()
      await browser.close()
    }
  } finally {
    adapter.release()
    await scaffold.close()
  }
})
