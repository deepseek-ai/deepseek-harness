/** Program palette retention and XParseColor reset semantics across application themes. */
import { expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { TerminalTheme } from '../src/client/terminal-theme.ts'

function harness() {
  const handlers = new Map<number, (data: string) => boolean>()
  const dispose = vi.fn()
  const options: Terminal['options'] = {}
  const terminal = {
    options,
    parser: { registerOscHandler: (code: number, handler: (data: string) => boolean) => {
      handlers.set(code, handler)
      return { dispose }
    } },
  } as unknown as Terminal
  const theme = new TerminalTheme(terminal)
  const send = (code: number, data = '') => { expect(handlers.get(code)!(data)).toBe(false) }
  theme.update('#ffffff', '#0f1115')
  return { theme, options, send, dispose }
}

it('preserves indexed, extended and default application colors while updating DSH selection colors', () => {
  const h = harness()
  h.send(4, '1;#00ff00;16;rgb:f/0/0;255;#123456')
  h.send(10, '#abcdef;#123456;#aa0000;#999999')
  expect(h.theme.cursor).toBe('#aa0000')
  h.theme.update('#151517', '#f9fafb')
  expect(h.options.theme).toMatchObject({
    red: '#00ff00', foreground: '#abcdef', background: '#123456', cursor: '#aa0000',
    selectionBackground: '#f9fafb', selectionForeground: '#151517',
  })
  expect(h.options.theme?.extendedAnsi?.[0]).toBe('#ff0000')
  expect(h.options.theme?.extendedAnsi?.[239]).toBe('#123456')
  const previous = h.options.theme
  h.theme.update('#151517', '#f9fafb')
  expect(h.options.theme).toBe(previous)
  h.theme.dispose()
  expect(h.dispose).toHaveBeenCalledTimes(8)
})

it('restores selected entries, all indexed colors and special colors to the current DSH defaults', () => {
  const h = harness()
  h.send(4, '1;#00ff00;2;#ff0000;255;#fedcba')
  h.send(11, '#111111;#222222')
  h.send(10, '#333333')
  h.theme.update('#151517', '#f9fafb')
  h.send(104, '1;255;bad;-1;256')
  expect(h.options.theme).not.toHaveProperty('red')
  expect(h.options.theme).not.toHaveProperty('extendedAnsi')
  expect(h.options.theme?.green).toBe('#ff0000')
  h.send(104)
  expect(h.options.theme).not.toHaveProperty('green')
  for (const code of [110, 111, 112]) h.send(code)
  expect(h.theme.cursor).toBe('#f9fafb')
  expect(h.options.theme).toMatchObject({ background: '#151517', foreground: '#f9fafb', cursor: '#f9fafb' })
})

it.each([
  ['#f00', '#f00000'], ['#123456', '#123456'], ['#123456789', '#124578'], ['#123456789abc', '#12569a'],
  ['rgb:f/0/0', '#ff0000'], ['RGB:FF/00/00', '#ff0000'], ['rgb:abc/def/123', '#abde12'],
  ['rgb:ffff/0000/8080', '#ff0080'],
])('retains the xterm interpretation of %s', (source, expected) => {
  const h = harness()
  h.send(12, source)
  h.theme.update('#000000', '#ffffff')
  expect(h.options.theme?.cursor).toBe(expected)
})

it.each(['?', 'red', '#12', '#zzzzzz', '#12345g', 'rgb:f/00/000', 'rgb:fffff/00000/00000', '', 'rgba:ff/00/00'])('leaves unsupported or query color %s to xterm', (color) => {
  const h = harness()
  h.send(4, `1;#00ff00;1;${color};dangling`)
  h.send(10, color)
  h.theme.update('#000000', '#ffffff')
  expect(h.options.theme?.red).toBe('#00ff00')
  expect(h.options.theme?.foreground).toBe('#ffffff')
})

it('ignores invalid palette indices without losing valid pairs in the same command', () => {
  const h = harness()
  h.send(4, '-1;#ffffff;256;#ffffff;x;#ffffff;1.5;#ffffff;;#ffffff;01;#010203')
  h.theme.update('#000000', '#ffffff')
  expect(h.options.theme?.red).toBe('#010203')
  expect(Object.keys(h.options.theme!)).toHaveLength(8)
})
