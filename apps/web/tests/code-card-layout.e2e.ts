/** Browser geometry for read offsets and horizontally scrolled diff fills. */
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { expandTurnProcesses, newEnglishPage, saveFailureShot } from './support.ts'

const LONG_LINE = 'source_columns_'.repeat(80)
const OFFSETS = [999, 99_999]

/** Seed durable tool results without invoking a model or allocating a large file. */
function layoutFixture(): string {
  const calls: { name: string; args: Record<string, JsonValue>; result: string; meta: JsonValue }[] = OFFSETS.map((offset) => {
    const path = `offset-${offset}.txt`
    const lines = [{ number: offset, text: 'short' }, { number: offset + 1, text: LONG_LINE }]
    return {
      name: 'read', args: { file_path: path, offset },
      result: `<path>${path}</path>\n<type>file</type>\n<content>\n${lines.map(line => `${line.number}: ${line.text}`).join('\n')}\n</content>`,
      meta: { path, offset, lines, totalLines: offset + 2 },
    }
  })
  const oldText = `old_${LONG_LINE}\nshort old`
  const newText = `new_${LONG_LINE}\nshort new`
  calls.push({
    name: 'edit', args: { file_path: 'long.txt', old_string: oldText, new_string: newText },
    result: 'Edited long.txt', meta: { diffs: [{ path: 'long.txt', oldText, newText }] },
  })
  const session = Session.create(SessionId('code-card-layout-source'))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Inspect the source windows and edit the long lines.' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  const namedCalls = calls.map((call, index) => ({ ...call, id: ToolCallId(`layout-${index}`), arguments: JSON.stringify(call.args) }))
  session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createAssistantMessage({
      content: namedCalls.map(call => ({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments })),
      source: { provider: 'fixture', model: 'fixture' },
    }),
  }, { surfaceOp: 'append' })
  for (const call of namedCalls) {
    const source = session.append('tool/call', { turn: 1, step: 1, callId: call.id, name: call.name, arguments: call.arguments })
    session.append('tool/result', {
      turn: 1, step: 1, meta: call.meta,
      message: createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: call.result }], isError: false }),
    }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
  }
  session.append('step/end', { turn: 1, step: 1 })
  session.append('step/start', { turn: 1, step: 2 })
  session.append('assistant/message', {
    stream: [], turn: 1, step: 2,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'CODE_LAYOUT_DONE' }], source: { provider: 'fixture', model: 'fixture' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 2 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [
    JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0, cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }),
    ...session.snapshotEvents().map(event => JSON.stringify(event)), '',
  ].join('\n')
}

describe('web e2e: code-card layout', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, layoutFixture(), 'code-card-layout')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[role="treeitem"]').first().click()
    await page.locator('[role="treeitem"]').nth(1).click()
    await page.getByText('CODE_LAYOUT_DONE', { exact: true }).waitFor()
    await expandTurnProcesses(page)
    for (const row of await page.locator('[data-variant="read"], [data-variant="edit"]').all()) {
      await row.locator('[data-expandable]').click()
    }
    await page.locator('[data-read]').nth(1).waitFor()
    await page.locator('[data-diff]').waitFor()
  })

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it.each(OFFSETS)('keeps offset %i line numbers clear of aligned source in both wrap modes', async (offset) => {
    onTestFailed(() => saveFailureShot(page, `code-card-offset-${offset}`))
    const card = page.locator('[data-read]').filter({ hasText: `offset-${offset}.txt` })
    const wrap = card.getByRole('button', { name: 'Wrap lines', exact: true })
    const heights: number[] = []
    for (const wrapped of [false, true]) {
      if (wrapped) await wrap.click()
      expect(await wrap.getAttribute('aria-pressed')).toBe(String(wrapped))
      const rows = await card.locator('[class*="gutter"]').evaluateAll(gutters => gutters.map((gutter) => {
        const content = gutter.nextElementSibling!
        const range = document.createRange()
        range.selectNodeContents(gutter)
        const glyphs = range.getBoundingClientRect()
        const slot = gutter.getBoundingClientRect()
        const source = content.getBoundingClientRect()
        return {
          fits: glyphs.left >= slot.left - 1 && glyphs.right <= slot.right + 1,
          gap: source.left - glyphs.right, left: source.left, height: source.height,
        }
      }))
      expect(rows).toHaveLength(2)
      expect(rows.every(row => row.fits && row.gap >= 11)).toBe(true)
      expect(rows[0]!.left).toBe(rows[1]!.left)
      heights.push(rows[1]!.height)
    }
    expect(heights[1]!).toBeGreaterThan(heights[0]!)
    await wrap.click()
  })

  it.each([false, true])('fills long diff rows through horizontal scrolling with dark=%s', async (dark) => {
    onTestFailed(() => saveFailureShot(page, `code-card-diff-${dark}`))
    await page.evaluate(value => document.body.toggleAttribute('data-ds-dark-theme', value), dark)
    const card = page.locator('[data-diff]')
    const body = card.locator(':scope > div').nth(1)
    const wrap = card.getByRole('button', { name: 'Wrap lines', exact: true })
    for (const wrapped of [false, true]) {
      if (wrapped) await wrap.click()
      const result = await body.evaluate((element) => {
        element.scrollLeft = element.scrollWidth
        const viewport = element.getBoundingClientRect()
        const rows = [...element.children].filter(row => ['+ ', '- '].includes(getComputedStyle(row, '::before').content.replaceAll('"', '')))
        return {
          overflow: element.scrollWidth - element.clientWidth,
          fills: rows.map(row => ({
            width: row.getBoundingClientRect().width, right: row.getBoundingClientRect().right,
            fill: getComputedStyle(row).backgroundColor, marker: getComputedStyle(row).boxShadow,
          })),
          scrollWidth: element.scrollWidth, right: viewport.right,
        }
      })
      expect(result.fills).toHaveLength(4)
      if (wrapped) expect(result.overflow).toBeLessThanOrEqual(1)
      else expect(result.overflow).toBeGreaterThan(100)
      for (const row of result.fills) {
        expect(row.width).toBeGreaterThanOrEqual(result.scrollWidth - 1)
        expect(row.right).toBeGreaterThanOrEqual(result.right - 1)
        expect(row.fill).toMatch(dark ? /0\.12\)$/ : /0\.08\)$/)
        expect(row.marker).toContain('inset')
      }
    }
    await wrap.click()
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
