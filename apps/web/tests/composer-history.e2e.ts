/** Composer ArrowUp/ArrowDown recall of loaded prompts in the shipped Web composition. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it, onTestFailed } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import { launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const PROMPTS = ['First history prompt', 'Second history prompt\nwith a second line'] as const

function reply(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 16, outputTokens: 4 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

let browser: Browser
let page: Page
let replayDir: string
let scaffold: WebScaffold

beforeAll(async () => {
  replayDir = await mkdtemp(join(tmpdir(), 'dsh-composer-history-'))
  const replayOverride = join(replayDir, 'replay.override.json')
  const doc: ReplayOverrideDoc = PROMPTS.map((_, index) => ({ kind: 'chunks', chunks: reply(`Reply ${String(index + 1)}`) }))
  await writeFile(replayOverride, JSON.stringify(doc))
  scaffold = await launchWebScaffold({ replayFixture: join(replayDir, 'override-only.jsonl'), replayOverride })
  browser = await chromium.launch()
  page = await newEnglishPage(browser, 800)
  watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await connectFreshWorkspace(page, scaffold.workspaceCwd, 'composer-history-e2e')
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await scaffold?.close()
  if (replayDir !== undefined) await rm(replayDir, { recursive: true, force: true })
})

it.skipIf(webSnapshotMode() === 'record')('recalls loaded prompts with the arrow keys from an empty draft, also after a reload', async () => {
  onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-history'))
  const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
  await composer.waitFor({ timeout: 15_000 })
  for (const [index, prompt] of PROMPTS.entries()) {
    const settled = scaffold.whenTurnSettled(30_000)
    await composer.fill(prompt)
    await composer.press('Enter')
    await page.getByText(`Reply ${String(index + 1)}`, { exact: true }).waitFor({ timeout: 15_000 })
    await settled
    await expect.poll(() => composer.textContent(), { timeout: 10_000 }).toBe('')
  }
  // The editor document's plain text: paragraphs and line-break nodes both end a line.
  const draft = () => composer.evaluate((element) => {
    interface Node { type: string; text?: string; children?: Node[] }
    const editor = (element as HTMLElement & { __lexicalEditor: { getEditorState(): { toJSON(): { root: Node } } } }).__lexicalEditor
    const line = (node: Node): string => node.type === 'linebreak' ? '\n' : node.text ?? (node.children ?? []).map(line).join('')
    return (editor.getEditorState().toJSON().root.children ?? []).map(line).join('\n')
  })

  // Typed text is never displaced: ArrowUp only moves the caret.
  await composer.pressSequentially('unsent')
  await composer.press('ArrowUp')
  expect(await draft()).toBe('unsent')
  await composer.press('ControlOrMeta+a')
  await composer.press('Backspace')
  await expect.poll(draft).toBe('')

  // From an empty draft the arrows walk the history with the caret at the draft end.
  await composer.press('ArrowUp')
  await expect.poll(draft).toBe(PROMPTS[1])
  await composer.press('ArrowUp')
  await expect.poll(draft).toBe(PROMPTS[0])
  // Past the oldest entry the native arrow moves the caret to the line start,
  // so the next ArrowDown returns it to the end before recalling again.
  await composer.press('ArrowUp')
  expect(await draft()).toBe(PROMPTS[0])
  await composer.press('ArrowDown')
  expect(await draft()).toBe(PROMPTS[0])
  await composer.press('ArrowDown')
  await expect.poll(draft).toBe(PROMPTS[1])

  // Away from the draft end the arrows move the caret inside the two-line entry.
  await composer.press('ArrowLeft')
  await composer.press('ArrowUp')
  await composer.press('ArrowDown')
  expect(await draft()).toBe(PROMPTS[1])
  await composer.press('End')
  await composer.press('ArrowUp')
  await expect.poll(draft).toBe(PROMPTS[0])
  await composer.press('ArrowDown')
  await expect.poll(draft).toBe(PROMPTS[1])
  await composer.press('ArrowDown')
  await expect.poll(draft).toBe('')

  // Recall reads the loaded Session history, so it survives a page reload.
  await page.reload({ waitUntil: 'load' })
  const reloaded = page.locator('[data-composer-input][contenteditable="true"]').last()
  await reloaded.waitFor({ timeout: 15_000 })
  await page.getByText('Reply 2', { exact: true }).waitFor({ timeout: 15_000 })
  await reloaded.click()
  await reloaded.press('ArrowUp')
  await expect.poll(() => reloaded.evaluate((element) => {
    interface Node { type: string; text?: string; children?: Node[] }
    const editor = (element as HTMLElement & { __lexicalEditor: { getEditorState(): { toJSON(): { root: Node } } } }).__lexicalEditor
    const line = (node: Node): string => node.type === 'linebreak' ? '\n' : node.text ?? (node.children ?? []).map(line).join('')
    return (editor.getEditorState().toJSON().root.children ?? []).map(line).join('\n')
  })).toBe(PROMPTS[1])
})
