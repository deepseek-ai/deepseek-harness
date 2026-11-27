// @vitest-environment jsdom
/** Highlighting of drawn rows with the lines before them: the old side rebuilt, runs, context tokens, and idle updates. */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodeHighlighter } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { ForgeDiffHunk } from '../src/types.ts'
import { hunkRows } from '../src/client/diff-rows.ts'
import {
  contextSpans, HIGHLIGHT_CONTEXT_LINES, oldSideLines, runKey, sideRun, useContextHighlight, type FileSides, type SideRun,
} from '../src/client/highlight-context.ts'

/** New side of a file whose hunks change lines 3–5 and delete one line after line 10. */
const NEW_SIDE = ['a1', 'a2', 'a3', 'y', 'z', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 't12', 't13']
const HUNKS: readonly ForgeDiffHunk[] = [
  { oldStart: 3, oldLines: 3, newStart: 3, newLines: 4, lines: [' a3', '-x', '+y', '+z', ' a5'] },
  { oldStart: 10, oldLines: 2, newStart: 11, newLines: 1, lines: [' a10', '-w'] },
]

/** A highlighter that colors each line by its index in the fragment and records the fragments it reads. */
function recorder(): CodeHighlighter & { readonly calls: string[] } {
  const calls: string[] = []
  const highlight = (code: string) => {
    calls.push(code)
    return code.split('\n').map((text, index) => [{ text, style: { color: `c${String(index)}` } }])
  }
  return Object.assign(highlight, { calls })
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('oldSideLines', () => {
  it('rebuilds the old side from the new side and the hunks, deletions and trailing lines included', () => {
    expect(oldSideLines(NEW_SIDE, HUNKS)).toEqual(['a1', 'a2', 'a3', 'x', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'w', 't12', 't13'])
    const deletion: ForgeDiffHunk = { oldStart: 2, oldLines: 1, newStart: 2, newLines: 0, lines: ['-gone', '\\ No newline at end of file'] }
    expect(oldSideLines(['a', 'b'], [deletion])).toEqual(['a', 'gone', 'b'])
    expect(oldSideLines(['a', 'b', 'c'], [{ oldStart: 3, oldLines: 0, newStart: 3, newLines: 1, lines: ['+c'] }])).toEqual(['a', 'b'])
  })

  it('rebuilds a file whose unchanged lines outnumber the arguments one call takes', () => {
    const lines = Array.from({ length: 200_000 }, (_, at) => `l${String(at + 1)}`)
    const old = oldSideLines(lines, [{ oldStart: 150_000, oldLines: 1, newStart: 150_000, newLines: 1, lines: ['-was', '+l150000'] }])
    expect([old.length, old[149_998], old[149_999], old[150_000], old.at(-1)]).toEqual([200_000, 'l149999', 'was', 'l150001', 'l200000'])
  })
})

describe('sideRun', () => {
  it('numbers a side of a run consecutively and has none for a side without lines', () => {
    expect(sideRun(hunkRows(HUNKS[0]!), 'old')).toEqual({ side: 'old', first: 3, last: 5, texts: ['a3', 'x', 'a5'] })
    expect(sideRun(hunkRows(HUNKS[0]!), 'new')).toEqual({ side: 'new', first: 3, last: 6, texts: ['a3', 'y', 'z', 'a5'] })
    expect(sideRun(hunkRows({ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+n'] }), 'old')).toBeUndefined()
    expect(runKey('c1', { side: 'new', first: 3, last: 6, texts: [] })).toBe('c1:new:3:6')
  })
})

describe('contextSpans', () => {
  const run: SideRun = { side: 'new', first: 11, last: 12, texts: ['a10', 't12'] }

  it('highlights a run after the lines before it, without their carriage returns, and keeps only the run\'s tokens', () => {
    const highlighter = recorder()
    const spans = contextSpans(run, NEW_SIDE.map(line => `${line}\r`), highlighter)
    expect(highlighter.calls).toEqual([[...NEW_SIDE.slice(0, 10), 'a10', 't12'].join('\n')])
    expect(spans).toEqual(new Map([[11, [{ text: 'a10', style: { color: 'c10' } }]], [12, [{ text: 't12', style: { color: 'c11' } }]]]))
  })

  it(`reads at most ${String(HIGHLIGHT_CONTEXT_LINES)} lines before a run`, () => {
    const file = Array.from({ length: 400 }, (_, at) => `l${String(at + 1)}`)
    const highlighter = recorder()
    contextSpans({ side: 'old', first: 300, last: 300, texts: ['l300'] }, file, highlighter)
    expect(highlighter.calls[0]?.split('\n')).toEqual([...file.slice(300 - HIGHLIGHT_CONTEXT_LINES - 1, 299), 'l300'])
  })

  it('has nothing to do for a run on the first line, waits for a grammar, and gives a final empty line no tokens', () => {
    expect(contextSpans({ ...run, first: 1, last: 2 }, NEW_SIDE, recorder())).toBeNull()
    expect(contextSpans(run, NEW_SIDE, () => undefined)).toBeUndefined()
    expect(contextSpans({ side: 'new', first: 2, last: 3, texts: ['a2', ''] }, NEW_SIDE, code => code.split('\n').slice(0, -1).map(text => [{ text, style: {} }])))
      .toEqual(new Map([[2, [{ text: 'a2', style: {} }]], [3, []]]))
  })
})

describe('useContextHighlight', () => {
  const SIDES: FileSides = { new: NEW_SIDE, old: oldSideLines(NEW_SIDE, HUNKS) }
  const RUNS: readonly SideRun[] = [
    { side: 'new', first: 1, last: 6, texts: NEW_SIDE.slice(0, 6) },
    { side: 'old', first: 10, last: 11, texts: ['a10', 'w'] },
  ]
  let root: HTMLDivElement

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestIdleCallback', undefined)
    root = document.createElement('div')
    root.textContent = 'code'
    document.body.append(root)
  })

  afterEach(() => {
    root.remove()
    window.getSelection()?.removeAllRanges()
  })

  interface HookProps {
    readonly runs: readonly SideRun[]
    readonly sides: FileSides | undefined
    readonly change: string
    readonly highlighter: CodeHighlighter
    readonly selecting: boolean
  }

  function hook(initial: Partial<HookProps> = {}) {
    const initialProps: HookProps = { runs: RUNS, sides: SIDES, change: 'c1', highlighter: recorder(), selecting: false, ...initial }
    const use = (props: HookProps) =>
      useContextHighlight(props.runs, props.sides, props.change, props.highlighter, { current: root }, props.selecting)
    return renderHook(use, { initialProps })
  }

  it('applies the tokens of the runs after other lines once each has had an idle turn', () => {
    const { result } = hook()
    expect(result.current.size).toBe(0)
    act(() => { vi.advanceTimersByTime(16) })
    expect(result.current.size).toBe(0)
    act(() => { vi.advanceTimersByTime(16) })
    expect([...result.current.keys()]).toEqual(['c1:old:10:11'])
    expect(result.current.get('c1:old:10:11')?.get(11)).toEqual([{ text: 'w', style: { color: 'c10' } }])
  })

  it('keeps the tokens under their change, so another change of the file finds none before or after its text is read', () => {
    const { result, rerender } = hook()
    act(() => { vi.runAllTimers() })
    expect(result.current.has(runKey('c1', RUNS[1]!))).toBe(true)
    // The same lines of the next change: in the very render that names it, its key finds no tokens of the last change.
    rerender({ runs: RUNS, sides: undefined, change: 'c2', highlighter: recorder(), selecting: false })
    expect(result.current.get(runKey('c2', RUNS[1]!))).toBeUndefined()
    rerender({ runs: RUNS, sides: { new: NEW_SIDE, old: ['x', ...SIDES.old] }, change: 'c2', highlighter: recorder(), selecting: false })
    expect(result.current.size).toBe(0)
    act(() => { vi.runAllTimers() })
    expect([...result.current.keys()]).toEqual(['c2:old:10:11'])
    expect(result.current.get('c2:old:10:11')?.get(10)).toEqual([{ text: 'a10', style: { color: 'c9' } }])
  })

  it('waits for the whole file and for a grammar, and starts over for another file', () => {
    const { result, rerender } = hook({ sides: undefined })
    act(() => { vi.runAllTimers() })
    expect(result.current.size).toBe(0)
    rerender({ runs: RUNS, sides: SIDES, change: 'c1', highlighter: () => undefined, selecting: false })
    act(() => { vi.runAllTimers() })
    expect(result.current.size).toBe(0)
    const highlighter = recorder()
    rerender({ runs: RUNS, sides: SIDES, change: 'c1', highlighter, selecting: false })
    act(() => { vi.runAllTimers() })
    expect(result.current.size).toBe(1)
    // The same runs keep their tokens across a new highlighter, without a second read or an update.
    const before = result.current
    rerender({ runs: [...RUNS], sides: SIDES, change: 'c1', highlighter: recorder(), selecting: false })
    act(() => { vi.runAllTimers() })
    expect(result.current).toBe(before)
    expect(highlighter.calls).toHaveLength(1)
    rerender({ runs: RUNS, sides: { ...SIDES }, change: 'c1', highlighter, selecting: false })
    expect(result.current.size).toBe(0)
    act(() => { vi.runAllTimers() })
    expect(result.current.size).toBe(1)
  })

  it('defers the update while the reader drags or selects text inside the file', () => {
    const { result, rerender } = hook({ selecting: true })
    act(() => { vi.runAllTimers() })
    expect(result.current.size).toBe(0)
    const range = document.createRange()
    range.selectNodeContents(root)
    window.getSelection()?.addRange(range)
    rerender({ runs: RUNS, sides: SIDES, change: 'c1', highlighter: recorder(), selecting: false })
    expect(result.current.size).toBe(0)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    expect(result.current.size).toBe(0)
    window.getSelection()?.removeAllRanges()
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    expect(result.current.size).toBe(1)
  })

  it('uses idle callbacks where the browser has them and cancels pending work when unmounted', () => {
    const cancel = vi.fn()
    const queued: (() => void)[] = []
    vi.stubGlobal('requestIdleCallback', (work: () => void) => queued.push(work))
    vi.stubGlobal('cancelIdleCallback', cancel)
    const { result, unmount } = hook()
    expect(queued).toHaveLength(1)
    act(() => { queued[0]!() })
    act(() => { queued[1]!() })
    expect(result.current.size).toBe(1)
    const again = hook({ sides: { ...SIDES } })
    again.unmount()
    unmount()
    expect(cancel).toHaveBeenCalled()
  })
})
