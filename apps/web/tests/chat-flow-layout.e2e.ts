/** Cold history retains Chat spacing through the flow slot's display:contents anchor. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, seedSession, selectedSessionFixture, watchConsole } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

it.each(['turn-tail-actions', 'goal-multi-turn-actions', 'present'] as const)(
  'preserves process and answer spacing in cold %s history', async (scenario) => {
    const scaffold = await launchWebScaffold({})
    onTestFinished(() => scaffold.close())
    if (scenario === 'present') {
      await writeFile(join(scaffold.workspaceCwd, 'report.txt'), 'DELIVERED_REPORT\n')
      await writeFile(join(scaffold.workspaceCwd, '说明.txt'), 'DELIVERED_NOTE\n')
    }
    const fixture = await selectedSessionFixture(fileURLToPath(
      new URL(`../../../snapshots/web/${scenario}/session.v3.jsonl`, import.meta.url),
    ))
    await seedSession(scaffold, await readFile(fixture, 'utf8'), `flow-layout-${scenario}`)
    const browser = await chromium.launch()
    onTestFinished(() => browser.close())
    const page = await newEnglishPage(browser)
    const console = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[role="treeitem"]').first().click()
    await page.locator('[role="treeitem"]').nth(1).click()
    const controls = page.locator('[data-turn-process]')
    await expect.poll(() => controls.count()).toBe(scenario === 'goal-multi-turn-actions' ? 2 : 1)
    const process = controls.first()
    expect(await process.getAttribute('aria-expanded')).toBe('false')
    expect(await process.evaluate(element => element.closest('[data-slot="conversation.chat.flow"]') !== null)).toBe(true)

    if (scenario === 'goal-multi-turn-actions') {
      const trigger = page.locator('[data-turn-trigger]').first()
      await process.click()
      for (const fontSize of [10, 14, 22]) {
        await scaffold.ctx.settings.update('ui-theme', { fontSize })
        await expect.poll(() => page.evaluate(() => document.body.style.getPropertyValue('--dsh-content-font-size')))
          .toBe(`${String(fontSize)}px`)
        const group = page.locator('[data-process-activity]:visible').first()
        expect(await process.evaluate(element => element.getBoundingClientRect().top))
          .toBe(await trigger.evaluate(element => element.getBoundingClientRect().bottom) + 16)
        expect(await group.evaluate(element => element.getBoundingClientRect().top))
          .toBe(await process.evaluate(element => element.getBoundingClientRect().bottom) + 16)
      }
    } else {
      const answer = page.getByText(scenario === 'present' ? 'PRESENT_DONE' : 'DONE', { exact: true })
      await answer.waitFor()
      const answerBounds = await answer.evaluate((element) => {
        const seat = element.closest('[data-chat-flow-kind="assistant-step"]')
        if (seat === null) throw new Error('final answer has no Chat seat')
        const { top, bottom } = seat.getBoundingClientRect()
        return { top, bottom }
      })
      const processBottom = await process.evaluate(element => element.getBoundingClientRect().bottom)
      // Hidden process rows separate the folded control from the first visible reply, so it keeps the 12px reply gap.
      const lead = scenario === 'present' ? answer : page.getByText('Reading the workspace now.', { exact: true })
      const leadTop = await lead.evaluate((element) => {
        const seat = element.closest('[data-chat-flow-kind="assistant-step"]')
        if (seat === null) throw new Error('first visible reply has no Chat seat')
        return seat.getBoundingClientRect().top
      })
      expect(leadTop).toBe(processBottom + 12)
      if (scenario === 'present') {
        const geometry = await page.locator('[data-presented-files-row]').evaluate((grid) => {
          const root = grid.parentElement
          const tail = root?.closest('[data-turn-tail]')
          const actions = tail?.querySelector('button[aria-label="Copy"]')?.parentElement
          if (root === null || actions == null) throw new Error('presented files have no Turn footer')
          return { top: root.getBoundingClientRect().top, bottom: root.getBoundingClientRect().bottom,
            actionsTop: actions.getBoundingClientRect().top }
        })
        expect(geometry.top - answerBounds.bottom).toBeCloseTo(16, 1)
        expect(geometry.actionsTop - geometry.bottom).toBeCloseTo(20, 1)
      }
    }
    expect(console.pageErrors).toEqual([])
  },
)

/** Gap above each visible row of a kind, measured from the nearest visible row before it. */
function gapsAbove(page: Page, kind: string): Promise<{ above: string; gap: number }[]> {
  return page.evaluate((kind) => {
    const rows = [...document.querySelectorAll<HTMLElement>('[data-slot="conversation.chat.flow"] > *')]
      .filter(row => row.getBoundingClientRect().height > 0)
    const label = (row: HTMLElement) => row.dataset.chatGroupKey !== undefined ? 'group'
      : row.dataset.chatGroupPart === 'response' ? 'response' : row.dataset.chatFlowKind ?? ''
    return rows.flatMap((row, index) => index > 0 && label(row) === kind
      ? [{ above: label(rows[index - 1]!), gap: row.getBoundingClientRect().top - rows[index - 1]!.getBoundingClientRect().bottom }]
      : [])
  }, kind)
}

/**
 * Repeat the recorded question step once, so one Turn holds two answered questions with a process group between them.
 * @param text - the question-composer fixture, whose events carry no seq and whose first step asks the question.
 * @returns the fixture with an identical step 2 question and the answer step renumbered to step 3.
 */
function askTwice(text: string): string {
  const lines = text.trimEnd().split('\n')
  const types = lines.map(line => (JSON.parse(line) as { type: string }).type)
  const stepEnd = types.indexOf('step/end')
  const question = lines.slice(types.indexOf('tool/call') - 1, stepEnd + 1)
  // Line i (after the header) is the event with seq i - 1; the copied tool/call sits two lines after stepEnd.
  const repeated = [
    JSON.stringify({ type: 'step/start', data: { turn: 1, step: 2 } }),
    ...question.map(line => line
      .replaceAll('"step":1', '"step":2')
      .replaceAll('call_00_Cijldc88LYmVPCXYUsRq1617', 'call_01_repeated')
      .replace('{{message:7}}', '{{message:9}}')
      .replace('{{message:6}}', '{{message:10}}')
      .replace(/"sourceEventSeqs":\[\d+\]/, `"sourceEventSeqs":[${String(stepEnd + 2)}]`)),
  ]
  const rest = lines.slice(stepEnd + 1).map(line => line.replaceAll('"step":2', '"step":3'))
  return [...lines.slice(0, stepEnd + 1), ...repeated, ...rest].join('\n')
}

it.each(['question-composer', 'question-composer-twice', 'minimal-compact'] as const)('spaces message bubbles in cold %s history', async (scenario) => {
  const scaffold = await launchWebScaffold({})
  onTestFinished(() => scaffold.close())
  const fixture = await selectedSessionFixture(fileURLToPath(
    new URL(`../../../snapshots/web/${scenario.replace('-twice', '')}/session.v4.jsonl`, import.meta.url),
  ))
  const text = await readFile(fixture, 'utf8')
  await seedSession(scaffold, scenario === 'question-composer-twice' ? askTwice(text) : text, `bubble-spacing-${scenario}`)
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const console = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.locator('[role="treeitem"]').first().click()
  await page.locator('[role="treeitem"]').nth(1).click()
  const process = page.locator('[data-turn-process]').first()
  await process.waitFor()
  if (scenario === 'question-composer') {
    // Folded, the hidden process group separates the reply from the response below it.
    await expect.poll(() => gapsAbove(page, 'response')).toContainEqual({ above: 'question-reply', gap: 4 })
    await process.click()
    await expect.poll(() => gapsAbove(page, 'question-reply')).toEqual([{ above: 'group', gap: 12 }])
    expect(await gapsAbove(page, 'group')).toContainEqual({ above: 'question-reply', gap: 4 })
  } else if (scenario === 'question-composer-twice') {
    // Folded, a hidden process group separates the two answered questions.
    await expect.poll(() => gapsAbove(page, 'question-reply')).toContainEqual({ above: 'question-reply', gap: 4 })
    await process.click()
    await expect.poll(() => gapsAbove(page, 'question-reply')).toEqual([{ above: 'group', gap: 12 }, { above: 'group', gap: 12 }])
  } else {
    await expect.poll(() => gapsAbove(page, 'user')).toContainEqual({ above: 'manual-compaction', gap: 12 })
  }
  expect(console.pageErrors).toEqual([])
})
