/** Rendered screen text and newest-relative pages over a real headless emulator. */
import { Terminal } from '@xterm/headless'
import { afterEach, describe, expect, it } from 'vitest'
import { cursorLineStart, lastContentRow, pageLines, renderLines } from '../src/screen.ts'

const terminals: Terminal[] = []
afterEach(() => { for (const terminal of terminals.splice(0)) terminal.dispose() })

async function screen(data: string, cols = 20, rows = 6): Promise<Terminal> {
  const terminal = new Terminal({ cols, rows, scrollback: 100, allowProposedApi: true })
  terminals.push(terminal)
  await new Promise<void>((resolve) => { terminal.write(data, resolve) })
  return terminal
}

function rendered(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active
  return renderLines(buffer, 0, lastContentRow(buffer) + 1)
}

describe('renderLines', () => {
  it('applies carriage-return rewrites, joins wrapped rows and keeps wide characters', async () => {
    const terminal = await screen('$ make\r\nprogress 10%\rprogress 100%\r\n0123456789012345678901234\r\n终端输出\r\n$ ', 20)
    expect(rendered(terminal)).toEqual(['$ make', 'progress 100%', '0123456789012345678901234', '终端输出', '$'])
  })

  it('renders the alternate screen without the normal scrollback', async () => {
    const terminal = await screen('history\r\n\x1b[?1049h\x1b[Hfull screen app')
    expect(terminal.buffer.active.type).toBe('alternate')
    expect(rendered(terminal)).toEqual(['full screen app'])
  })

  it('starts a range inside a wrapped line at that row', async () => {
    const terminal = await screen('0123456789abcdefghij0123\r\n', 10)
    expect(renderLines(terminal.buffer.active, 1, 3)).toEqual(['abcdefghij0123'])
  })

  it('renders an empty range as no lines', async () => {
    const terminal = await screen('one')
    expect(renderLines(terminal.buffer.active, 3, 3)).toEqual([])
  })

  it('finds the first row of the wrapped line holding the cursor', async () => {
    const wrapped = await screen('done\r\n$ 0123456789abcdefghij', 10)
    expect(wrapped.buffer.active.cursorY).toBe(3)
    expect(cursorLineStart(wrapped.buffer.active)).toBe(1)
    const top = await screen('0123456789abcdefghij', 10)
    expect(cursorLineStart(top.buffer.active)).toBe(0)
  })

  it('keeps the cursor row when trailing rows are blank', async () => {
    const terminal = await screen('one\r\n\r\n')
    expect(rendered(terminal)).toEqual(['one', '', ''])
    expect(lastContentRow(terminal.buffer.active)).toBe(2)
  })
})

describe('pageLines', () => {
  const lines = ['first', 'second', 'third', 'fourth']

  it('selects newest-relative pages', () => {
    expect(pageLines(lines, { offset: 0, count: 2, maxBytes: 1000 })).toEqual({ text: 'third\nfourth', totalLines: 4, lineBegin: 0, lineEnd: 2, truncated: false })
    expect(pageLines(lines, { offset: 2, count: 5, maxBytes: 1000 })).toEqual({ text: 'first\nsecond', totalLines: 4, lineBegin: 2, lineEnd: 4, truncated: false })
    expect(pageLines(lines, { offset: 9, count: 2, maxBytes: 1000 })).toEqual({ text: '', totalLines: 4, lineBegin: 9, lineEnd: 9, truncated: false })
  })

  it('drops the oldest whole lines to fit the byte bound', () => {
    expect(pageLines(lines, { offset: 0, count: 4, maxBytes: 12 })).toEqual({ text: 'third\nfourth', totalLines: 4, lineBegin: 0, lineEnd: 2, truncated: true })
  })

  it('cuts one oversized line at a code point boundary from its start', () => {
    expect(pageLines(['前缀终端'], { offset: 0, count: 1, maxBytes: 7 })).toEqual({ text: '终端', totalLines: 1, lineBegin: 0, lineEnd: 1, truncated: true })
  })
})
