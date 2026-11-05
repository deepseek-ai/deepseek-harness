// @vitest-environment jsdom
/** Text selections preserve one diff side and partial endpoints despite interleaved DOM rows. */
import { afterEach, expect, it, vi } from 'vitest'
import { codeSideAt, readCodeSelection } from '../src/client/code-selection.ts'

const roots: HTMLElement[] = []
afterEach(() => {
  vi.restoreAllMocks()
  document.getSelection()?.removeAllRanges()
  for (const root of roots.splice(0)) root.remove()
})

it('ignores missing selections and nodes outside displayed code', () => {
  const { root } = fixture()
  expect(codeSideAt(root, null)).toBeUndefined()
  expect(codeSideAt(root, root)).toBeUndefined()
  vi.spyOn(document, 'getSelection').mockReturnValue(null)
  expect(readCodeSelection(root, 'L')).toBeUndefined()
})

it('preserves blank code lines and excludes an empty endpoint from the selected range', () => {
  const { root, nodes } = fixture()
  nodes[2]!.textContent = ''
  const selection = document.getSelection()!
  selection.setBaseAndExtent(nodes[0]!, 0, nodes[3]!, 0)
  expect(readCodeSelection(root, 'L')).toEqual({ side: 'L', from: 2, to: 3, text: 'old first\n' })
  selection.setBaseAndExtent(nodes[1]!.firstChild!, 3, nodes[3]!.firstChild!, 0)
  expect(readCodeSelection(root, 'R')).toEqual({ side: 'R', from: 2, to: 2, text: ' first' })
  selection.setBaseAndExtent(nodes[1]!.firstChild!, 1, nodes[1]!.firstChild!, 3)
  expect(readCodeSelection(root, 'L')).toBeUndefined()
})

function fixture() {
  const root = document.createElement('div')
  document.body.append(root)
  roots.push(root)
  const nodes = [
    { side: 'old', line: 2, text: 'old first' }, { side: 'new', line: 2, text: 'new first' },
    { side: 'old', line: 3, text: 'old last' }, { side: 'new', line: 3, text: 'new last' },
  ].map(({ side, line, text }) => {
    const code = document.createElement('span')
    code.setAttribute('data-review-code', '')
    code.setAttribute(`data-${side}-line`, String(line))
    code.textContent = text
    root.append(code)
    return code
  })
  return { root, nodes }
}

it('copies only right-side fragments and keeps the actual first and last line numbers', () => {
  const { root, nodes } = fixture()
  const start = nodes[1]!.firstChild!
  const end = nodes[3]!.firstChild!
  const selection = document.getSelection()!
  selection.setBaseAndExtent(start, 4, end, 3)
  expect(codeSideAt(root, start)).toBe('R')
  expect(readCodeSelection(root, 'R')).toEqual({ side: 'R', from: 2, to: 3, text: 'first\nnew' })
  selection.setBaseAndExtent(end, 3, start, 4)
  expect(readCodeSelection(root, 'R')?.text).toBe('first\nnew')
})

it('keeps left-side selection independent and ignores a collapsed or cross-file selection', () => {
  const { root, nodes } = fixture()
  const selection = document.getSelection()!
  selection.setBaseAndExtent(nodes[0]!.firstChild!, 0, nodes[2]!.firstChild!, 8)
  expect(codeSideAt(root, nodes[0]!)).toBe('L')
  expect(readCodeSelection(root, 'L')).toEqual({ side: 'L', from: 2, to: 3, text: 'old first\nold last' })
  selection.collapseToStart()
  expect(readCodeSelection(root, 'L')).toBeUndefined()
  const other = fixture()
  selection.setBaseAndExtent(nodes[0]!.firstChild!, 0, other.nodes[2]!.firstChild!, 8)
  expect(readCodeSelection(root, 'L')).toBeUndefined()
  expect(codeSideAt(root, other.nodes[0]!)).toBeUndefined()
})
