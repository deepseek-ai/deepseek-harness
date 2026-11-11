/** Reasoning rows of one Assistant message keep the 4px process-row gap, and display-empty reasoning adds none. */
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, seedSession, watchConsole } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

type Block = readonly ['reasoning' | 'signature' | 'text' | 'bash', string]

/** Turn 1: reasoning around a signature-only block. Turn 2: signature-only blocks before and after reasoning. */
const TURNS: readonly (readonly (readonly Block[])[])[] = [
  [[['reasoning', 'a'], ['signature', 's1'], ['reasoning', 'b'], ['bash', 'k1']], [['text', 'Answer one']]],
  [
    [['reasoning', 'c'], ['bash', 'k2']],
    [['signature', 's2'], ['signature', 's3'], ['reasoning', 'd'], ['bash', 'k3']],
    [['reasoning', 'e'], ['signature', 's4'], ['signature', 's5'], ['bash', 'k4']],
    [['text', 'Answer two']],
  ],
]

function bashArguments(label: string): string {
  return JSON.stringify({ command: `echo ${label}`, description: `Run ${label}` })
}

function content([kind, label]: Block): Record<string, string> {
  switch (kind) {
    case 'reasoning': return { type: 'reasoning', text: `Thinking ${label}\n\nDetails for ${label}.` }
    case 'signature': return { type: 'reasoning', text: `<signature>${label}</signature>` }
    case 'text': return { type: 'text', text: label }
    case 'bash': return {
      type: 'tool-call', id: `call_${label}`, name: 'bash', arguments: bashArguments(label),
    }
  }
}

/** One closed Session whose Assistant messages carry the block layouts above. */
function sessionLog(): string {
  const header = {
    type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0, cwd: '{{cwd}}',
    isSeeded: false, delegationDepth: 0,
  }
  const events: Record<string, unknown>[] = []
  let message = 0
  const id = (): string => `{{message:${String(++message)}}}`
  TURNS.forEach((steps, index) => {
    const turn = index + 1
    events.push({ type: 'turn/start', data: { turn } })
    steps.forEach((blocks, stepIndex) => {
      const step = stepIndex + 1
      events.push({ type: 'step/start', data: { turn, step } })
      if (step === 1) {
        events.push({
          type: 'user/message', surfaceOp: 'append',
          data: { content: [{ type: 'text', text: `Turn ${String(turn)}` }], source: { kind: 'user' }, role: 'user', id: id() },
        })
      }
      events.push({
        type: 'assistant/message', surfaceOp: 'append',
        data: {
          turn, step, stream: [],
          message: {
            role: 'assistant', content: blocks.map(content), id: id(),
            source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
          },
        },
      })
      for (const [kind, label] of blocks) {
        if (kind !== 'bash') continue
        const callId = `call_${label}`
        events.push({ type: 'tool/call', data: { turn, step, callId, name: 'bash', arguments: bashArguments(label) } })
        events.push({
          type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [events.length - 1],
          data: {
            turn, step, meta: { cwd: '{{cwd}}' },
            message: {
              role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
              content: [{ type: 'text', text: `${label}\n` }], isError: false, id: id(),
            },
          },
        })
      }
      events.push({ type: 'step/end', data: { turn, step } })
    })
    events.push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  })
  return [header, ...events].map(line => JSON.stringify(line)).join('\n')
}

it('keeps 4px between reasoning and tool rows around display-empty reasoning blocks', async () => {
  const scaffold = await launchWebScaffold({})
  onTestFinished(() => scaffold.close())
  await scaffold.ctx.settings.update('ui-chat', { transcriptView: 'verbose' })
  await seedSession(scaffold, sessionLog(), 'reasoning-spacing')
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const console = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.locator('[role="treeitem"]').first().click()
  await page.locator('[role="treeitem"]').nth(1).click()
  await page.getByText('Answer two', { exact: true }).waitFor()

  // Rows in reading order; signature-only reasoning renders no row of its own.
  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-variant="think"], [data-chat-call-id]')]
    .filter(row => row.getBoundingClientRect().height > 0)
    .map((row) => {
      const { top, bottom } = row.getBoundingClientRect()
      const name = row.matches('[data-variant="think"]')
        ? /Thinking (\w+)/.exec(row.textContent ?? '')?.[1]
        : row.getAttribute('data-chat-call-id')?.replace('call_', '')
      return { name: name ?? '?', top, bottom }
    })
    .sort((left, right) => left.top - right.top))
  expect(rows.map(row => row.name)).toEqual(['a', 'b', 'k1', 'c', 'k2', 'd', 'k3', 'e', 'k4'])
  const gaps = Object.fromEntries(rows.slice(1).map((row, index) =>
    [`${rows[index]!.name}→${row.name}`, Math.round(row.top - rows[index]!.bottom)]))
  expect(gaps).toMatchObject({ 'a→b': 4, 'b→k1': 4, 'c→k2': 4, 'k2→d': 4, 'd→k3': 4, 'k3→e': 4, 'e→k4': 4 })
  expect(console.pageErrors).toEqual([])
})
