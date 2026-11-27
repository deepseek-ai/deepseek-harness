/**
 * Highlighting of drawn rows with the lines before them. A run of rows drawn after collapsed unchanged lines is
 * highlighted again with up to {@link HIGHLIGHT_CONTEXT_LINES} lines of the file before it, so a code block, comment,
 * or string that opens in the collapsed lines colors the run as it does in the whole file. Constructs that open further
 * back keep the colors of the run alone.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { CodeHighlighter, HighlightSpan } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { ForgeDiffHunk } from '../types.ts'
import type { DiffRow } from './diff-rows.ts'

/** Lines before a run that its highlighting reads; one call stays within an idle period for the slower grammars. */
export const HIGHLIGHT_CONTEXT_LINES = 120

/** Tokens of one side's lines by line number. */
export type LineSpans = ReadonlyMap<number, readonly HighlightSpan[]>

/** One side of one run of rows: its first and last line numbers and their texts. */
export interface SideRun {
  readonly side: 'old' | 'new'
  readonly first: number
  readonly last: number
  readonly texts: readonly string[]
}

/** A line as drawn: without the carriage return of a CRLF line ending. */
function drawn(text: string): string {
  return text.endsWith('\r') ? text.slice(0, -1) : text
}

/**
 * Rebuild the old side of a file from its new side and the hunks of its diff.
 * @param lines - the new side, which the hunks describe.
 * @param hunks - the hunks, in file order.
 * @returns the old side's lines.
 */
export function oldSideLines(lines: readonly string[], hunks: readonly ForgeDiffHunk[]): string[] {
  const old: string[] = []
  // Lines are appended one at a time: spreading a long run of unchanged lines into push would exceed the argument limit.
  const copy = (from: number, to?: number): void => {
    for (const line of lines.slice(from - 1, to)) old.push(line)
  }
  let at = 1
  for (const hunk of hunks) {
    copy(at, hunk.newStart - 1)
    at = Math.max(at, hunk.newStart)
    for (const line of hunk.lines) {
      const sign = line.charAt(0)
      if (sign === ' ' || sign === '-') old.push(line.slice(1))
      if (sign === ' ' || sign === '+') at++
    }
  }
  copy(at)
  return old
}

/**
 * One side of a run of rows, which numbers its lines consecutively.
 * @param rows - the run.
 * @param side - the side.
 * @returns the side's lines, or undefined when the run has none on that side.
 */
export function sideRun(rows: readonly DiffRow[], side: 'old' | 'new'): SideRun | undefined {
  const numbers: number[] = []
  const texts: string[] = []
  for (const row of rows) {
    const no = row[side]
    if (no === null) continue
    numbers.push(no)
    texts.push(row.text)
  }
  const first = numbers[0]
  const last = numbers.at(-1)
  return first === undefined || last === undefined ? undefined : { side, first, last, texts }
}

/**
 * Highlight one side of a run after the lines of the file before it.
 * @param run - the side of the run.
 * @param file - the whole side the run belongs to.
 * @param highlighter - the file's highlighter.
 * @returns the run's tokens by line number, null when nothing precedes the run, or undefined while the grammar is
 * unavailable.
 */
export function contextSpans(run: SideRun, file: readonly string[], highlighter: CodeHighlighter): LineSpans | null | undefined {
  const start = Math.max(1, run.first - HIGHLIGHT_CONTEXT_LINES)
  if (start === run.first) return null
  const context = file.slice(start - 1, run.first - 1).map(drawn)
  const highlighted = highlighter([...context, ...run.texts].join('\n'))
  if (highlighted === undefined) return undefined
  // Shiki omits a final empty token row, so a final empty line gets no tokens.
  return new Map(run.texts.map((_text, index) => [run.first + index, highlighted[context.length + index] ?? []]))
}

/** Whole sides of a file: the new side as read, and the old side rebuilt from it. */
export interface FileSides {
  readonly old: readonly string[]
  readonly new: readonly string[]
}

/**
 * Key of one side of a run in one change of a file, which its tokens are kept under. Tokens carry the text of their
 * lines, so the key names the change: the same lines of another change of the file never take these tokens.
 * @param change - the digest of the file's change.
 * @param run - the side of the run.
 * @returns the key.
 */
export function runKey(change: string, run: SideRun): string {
  return `${change}:${run.side}:${String(run.first)}:${String(run.last)}`
}

const NO_SPANS: ReadonlyMap<string, LineSpans> = new Map()

/** Schedule work for an idle period, or soon where the browser offers none. */
function whenIdle(work: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(work, { timeout: 2000 })
    return () => { cancelIdleCallback(handle) }
  }
  const handle = setTimeout(work, 16)
  return () => { clearTimeout(handle) }
}

/** Whether the reader holds a text selection inside an element. */
function selectsIn(element: HTMLElement | null): boolean {
  const selection = window.getSelection()
  return element !== null && selection !== null && !selection.isCollapsed && element.contains(selection.anchorNode)
}

/**
 * Highlight each side of each run again with the lines before it, one side of one run per idle period, once the whole
 * file is known. The tokens apply in one update when every run is done and only while the reader selects nothing
 * inside `root`, since redrawn tokens would drop the selection; a selection or drag defers them until it ends. Tokens
 * are kept under the change they were computed for, so another change of the file finds none of them, even before its
 * text is read; a new reading of the text starts the work over.
 * @param runs - the sides of the drawn runs.
 * @param sides - the whole file, or undefined while it is unknown.
 * @param change - the digest of the file's change, which every key names.
 * @param highlighter - the file's highlighter; a grammar that loads later resumes the work.
 * @param root - the element whose selection defers the update.
 * @param selecting - whether the reader is dragging a selection.
 * @returns the corrected tokens by {@link runKey}.
 */
export function useContextHighlight(
  runs: readonly SideRun[], sides: FileSides | undefined, change: string, highlighter: CodeHighlighter,
  root: RefObject<HTMLElement | null>, selecting: boolean,
): ReadonlyMap<string, LineSpans> {
  const [applied, setApplied] = useState(NO_SPANS)
  const shown = useRef(applied)
  shown.current = applied
  const cache = useRef<{ sides: FileSides | undefined; spans: Map<string, LineSpans | null> }>({ sides: undefined, spans: new Map() })
  const pending = useRef<ReadonlyMap<string, LineSpans> | null>(null)
  const held = useRef(selecting)
  held.current = selecting
  // Applies the pending tokens unless the reader is selecting, else tries again at each selection change until they apply.
  const attempt = (): void => {
    if (pending.current === null) return
    if (held.current || selectsIn(root.current)) {
      document.addEventListener('selectionchange', retry)
      return
    }
    document.removeEventListener('selectionchange', retry)
    setApplied(pending.current)
    pending.current = null
  }
  const latest = useRef(attempt)
  latest.current = attempt
  const retry = useCallback((): void => { latest.current() }, [])
  useEffect(() => () => { document.removeEventListener('selectionchange', retry) }, [retry])
  useEffect(() => { if (!selecting) retry() }, [selecting, retry])
  useEffect(() => {
    if (sides === undefined) return
    if (cache.current.sides !== sides) {
      cache.current = { sides, spans: new Map() }
      pending.current = null
      setApplied(NO_SPANS)
    }
    const spans = cache.current.spans
    const waiting = runs.filter(run => !spans.has(runKey(change, run)))
    let cancel = (): void => {}
    const finish = (): void => {
      const done = new Map<string, LineSpans>()
      for (const run of runs) {
        const key = runKey(change, run)
        const value = spans.get(key)
        if (value !== undefined && value !== null) done.set(key, value)
      }
      // Tokens the view already shows need no update, which would redraw every row of the file.
      const current = shown.current
      if (done.size === current.size && [...done].every(([key, value]) => current.get(key) === value)) return
      pending.current = done
      retry()
    }
    const next = (at: number): void => {
      const run = waiting[at]
      if (run === undefined) {
        finish()
        return
      }
      cancel = whenIdle(() => {
        const value = contextSpans(run, sides[run.side], highlighter)
        // A grammar still loading leaves the rest to the highlighter that arrives with it.
        if (value === undefined) return
        spans.set(runKey(change, run), value)
        next(at + 1)
      })
    }
    next(0)
    return () => { cancel() }
  }, [runs, sides, change, highlighter, retry])
  return applied
}
