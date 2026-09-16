// Strip control sequences that anser does not consume before resolving SGR
// runs, so they cannot reach the DOM as literal characters.

import Anser from 'anser'
import type { CSSProperties } from 'react'

/**
 * The subset of one anser JSON chunk this module reads. anser's own types
 * declare `fg`/`bg` as `string`, but its parser leaves them `null` for a run
 * that sets no color, so the null is spelled out here.
 */
interface AnsiChunk {
  /** Run text with its SGR codes already removed. */
  content: string
  /** Foreground as an `r, g, b` triple, or null when the run sets none. */
  fg: string | null
  /** Background as an `r, g, b` triple, or null when the run sets none. */
  bg: string | null
  /** SGR attributes in effect for the run, in the order they were declared. */
  decorations: readonly string[]
}

/** One run of terminal text; `style` is undefined for text that carries no SGR state. */
export interface AnsiSpan {
  /** The run's plain text, free of escape sequences and newlines. */
  text: string
  /** Resolved inline style, or undefined when the run needs no wrapper. */
  style: CSSProperties | undefined
}

/** The spans of one output line, in order. */
export type AnsiLine = readonly AnsiSpan[]

/**
 * The 8/16 basic ANSI colors, keyed by the whitespace-free `r,g,b` triple
 * anser emits for them, mapped onto the theme tokens that carry the same
 * semantic. Black and white both resolve to the primary label color so text
 * stays legible under either theme instead of matching the surface it sits
 * on; bright black takes the tertiary label color (the muted-gray role).
 * Cyan and bright cyan take two static blues: the design system has no cyan,
 * and anser's literal bright cyan is unreadable on the light theme's code
 * surface. Magenta has no token equivalent and falls through to anser's
 * literal rgb, as do all 256-palette and truecolor values.
 */
const TOKEN_BY_BASIC_RGB: Record<string, string> = {
  '0,0,0': 'var(--dsw-alias-label-primary)',
  '255,255,255': 'var(--dsw-alias-label-primary)',
  '85,85,85': 'var(--dsw-alias-label-tertiary)',
  '187,0,0': 'var(--dsw-alias-state-error-primary)',
  '255,85,85': 'var(--dsw-alias-state-error-secondary)',
  '0,187,0': 'var(--dsw-alias-state-success-primary)',
  '0,255,0': 'var(--dsw-alias-state-success-secondary)',
  '187,187,0': 'var(--dsw-alias-state-warn-primary)',
  '255,255,85': 'var(--dsw-alias-state-warn-secondary)',
  '0,0,187': 'var(--dsw-alias-state-business-primary)',
  '85,85,255': 'var(--dsw-static-blue-400)',
  '0,187,187': 'var(--dsw-static-blue-600)',
  '85,255,255': 'var(--dsw-static-blue-500)',
}

/**
 * CSS for each SGR attribute anser reports. `blink` is deliberately absent —
 * animated text is not reproduced. `reverse` never arrives here: anser
 * consumes it by swapping the run's foreground and background. Underline and
 * strikethrough share `textDecoration`, so in a run declaring both, the
 * later declaration wins.
 */
const STYLE_BY_DECORATION: Record<string, CSSProperties | undefined> = {
  bold: { fontWeight: 700 },
  dim: { opacity: 0.7 },
  italic: { fontStyle: 'italic' },
  underline: { textDecoration: 'underline' },
  strikethrough: { textDecoration: 'line-through' },
  hidden: { visibility: 'hidden' },
}

/** OSC strings (window title, hyperlinks), with or without their terminator. */
const OSC_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g

/** Escape sequences other than CSI: charset selection, single-shift, reset. */
const NON_CSI_ESCAPE = /\u001b(?!\[)[\u0020-\u002f]*[\u0030-\u007e]?/g

/**
 * C0 controls with no display meaning here. Tab, newline, backspace and ESC
 * survive: the first two for layout, backspace for the cursor replay, ESC
 * for anser's CSI split.
 */
const INERT_CONTROL = /[\u0000-\u0007\u000b-\u001a\u001c-\u001f\u007f]/g

/**
 * Lines whose cursor movements have to be replayed: a carriage return, a
 * backspace, or an erase-in-line. The erase pattern matches the SAME CSI shape
 * `replayLine` parses (parameters may carry `;` and intermediate bytes), so a
 * form like `\x1b[1;2K` cannot slip past this guard and skip its own erase.
 */
const NEEDS_REPLAY = /\r|\u0008|\u001b\[[\u0030-\u003f]*[\u0020-\u002f]*K/

/** SGR sequences alone, for folding state through a line that needs no replay. */
const SGR_SEQUENCE = /\u001b\[([\u0030-\u003f]*)[\u0020-\u002f]*m/g

/** Terminal tab stop width; a tab advances to the next multiple of this. */
const TAB_WIDTH = 8

/**
 * Combining marks and other zero-width code points: a terminal advances no
 * column for them, so `e` + U+0301 occupies one cell and a two-column redraw
 * covers both code points.
 */
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}\u200b-\u200f\u2060]$/u

/**
 * Characters a terminal advances two columns for: CJK scripts, fullwidth forms,
 * CJK punctuation, and characters with emoji presentation. Text-presentation
 * symbols (`\u2713`, `\u26a0` and the rest of U+2600-U+27BF) are ONE column and
 * must stay out of this set.
 */
const WIDE_CHAR = new RegExp(
  '\\p{Script=Han}|\\p{Script=Hiragana}|\\p{Script=Katakana}|\\p{Script=Hangul}'
  // Emoji presentation only: the U+2600-U+27BF symbol block is mostly SINGLE
  // width — `\u2713` (the check every progress line writes, this fixture
  // included) advances one column, verified against a real terminal, so taking
  // the whole block as wide misaligned exactly the output this card exists for.
  + '|\\p{Emoji_Presentation}'
  + '|[\\uff01-\\uff60\\u3000-\\u303e]',
  'u',
)

/**
 * Whether a character occupies two terminal columns (CJK, fullwidth forms,
 * emoji). Covers the ranges a command's output realistically carries; a
 * narrower guess would misalign the columns this card exists to preserve.
 * @param char - one character from the output.
 * @returns true when the terminal advances two columns for it.
 */
function isWide(char: string): boolean {
  const code = char.codePointAt(0)
  if (code === undefined || code < 0x1100) return false
  return WIDE_CHAR.test(char)
}

/**
 * A cell's graphic state, normalized. Held as fields rather than as the raw
 * sequence history because a terminal tracks CURRENT state, not a transcript:
 * accumulating sequences made each state boundary re-emit the whole chain, so
 * output that switches color without a full reset emitted O(n^2) characters
 * (3200 such cells produced 25 MB and eventually a `RangeError`). It also makes
 * the attribute closers every chalk-based tool writes — `39`, `49`, `22`, `23`,
 * `24`, `27`, `29` — actually close their attribute instead of appending to it.
 */
interface SgrState {
  fg: string
  bg: string
  /** Attribute parameters in force, e.g. `1` (bold) or `4` (underline). */
  attrs: readonly string[]
}

/** The default state: no color, no attributes. */
const SGR_NONE: SgrState = { fg: '', bg: '', attrs: [] }

/** Attribute closers, mapped to the opener parameters each one turns off. */
const ATTR_CLOSERS: Record<string, readonly string[]> = {
  22: ['1', '2'], 23: ['3'], 24: ['4'], 25: ['5', '6'], 27: ['7'], 28: ['8'], 29: ['9'],
}

/**
 * Fold one SGR sequence's parameters into the state it produces.
 * @param state - state in force before the sequence.
 * @param params - the sequence's raw parameter string (`31`, `1;4`, `38;5;208`).
 * @returns the state the sequence leaves in force.
 */
function foldSgr(state: SgrState, params: string): SgrState {
  const codes = params === '' ? ['0'] : params.split(';')
  let next = state
  for (let index = 0; index < codes.length; index++) {
    const code = String(codes[index])
    if (code === '' || code === '0') { next = SGR_NONE; continue }
    // Extended color: `38;5;N` / `38;2;R;G;B` and the `48` background pair
    // consume their own arguments, so they are taken whole.
    if (code === '38' || code === '48') {
      const kind = codes[index + 1] ?? ''
      const span = kind === '2' ? 4 : kind === '5' ? 2 : 0
      const value = codes.slice(index, index + span + 1).join(';')
      next = code === '38' ? { ...next, fg: value } : { ...next, bg: value }
      index += span
      continue
    }
    const closes = ATTR_CLOSERS[code]
    if (closes !== undefined) {
      next = { ...next, attrs: next.attrs.filter(attr => !closes.includes(attr)) }
      continue
    }
    const numeric = Number(code)
    if (code === '39') { next = { ...next, fg: '' }; continue }
    if (code === '49') { next = { ...next, bg: '' }; continue }
    if ((numeric >= 30 && numeric <= 37) || (numeric >= 90 && numeric <= 97)) { next = { ...next, fg: code }; continue }
    if ((numeric >= 40 && numeric <= 47) || (numeric >= 100 && numeric <= 107)) { next = { ...next, bg: code }; continue }
    if (!next.attrs.includes(code)) next = { ...next, attrs: [...next.attrs, code] }
  }
  return next
}

/**
 * Render a state as the one canonical sequence that establishes it from the
 * default, so a boundary emits a bounded string no matter how the state was
 * reached.
 * @param state - the state to open.
 * @returns the SGR sequence, or the empty string for the default state.
 */
function openSgr(state: SgrState): string {
  const codes = [...state.attrs]
  if (state.fg !== '') codes.push(state.fg)
  if (state.bg !== '') codes.push(state.bg)
  return codes.length === 0 ? '' : `\u001b[${codes.join(';')}m`
}

/** Whether two states are the same, so a boundary is only emitted on a change. */
function sameSgr(a: SgrState, b: SgrState): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.attrs.length === b.attrs.length
    && a.attrs.every((attr, index) => attr === b.attrs[index])
}

/**
 * Replay one line's cursor movements the way a terminal paints it, into a
 * column buffer. Carriage return and backspace only MOVE the cursor — neither
 * erases anything — so what a reader sees is whatever each column last had
 * written to it. That distinction is the whole point of doing this as a buffer
 * rather than as string surgery: `100%\rOK` shows `OK0%` because the redraw is
 * shorter than the frame beneath it, and a trailing `abc\b` still shows `abc`
 * because nothing ever overwrote the `c`.
 *
 * A CSI sequence occupies no column; it changes the state that the NEXT writes
 * are stamped with, which is how a terminal stores color per cell. `red bad`
 * then three backspaces then `ok` therefore shows `okd` with the `d` still red:
 * `ok` overwrote two cells and the third kept the state it was written with.
 * The columns are re-emitted as runs, so anser sees that same styling.
 * @param line - one output line, still carrying its CSI sequences.
 * @param entrySgr - SGR state in force when the line begins, since a newline
 *   does not reset it.
 * @returns the line as the terminal would have it after every movement, plus the
 *   SGR state at its end for the next line to enter with.
 */
function replayLine(line: string, entrySgr: SgrState): { text: string; sgr: SgrState } {
  // Same shape anser splits on, so a sequence is one unit here as well.
  const csi = /\u001b\[([\u0030-\u003f]*)[\u0020-\u002f]*([\u0040-\u007e])/g
  /** Per column: the state in force when it was written, and its character. */
  const columns: (Cell | undefined)[] = []
  let cursor = 0
  // State is tracked exactly as a terminal tracks it: each cell is stamped with
  // whatever was in force at the moment of the write, so a later redraw cannot
  // restyle the cells it does not reach. It enters carrying the previous line's
  // state, since a newline does not reset it.
  let sgr = entrySgr
  let at = 0

  /** Clear a cell and, for a wide pair, its partner: a terminal erases both. */
  const clear = (index: number, fill: string): void => {
    const cell = columns[index]
    if (cell?.spacer === true && index > 0) columns[index - 1] = { sgr, char: fill }
    else if (cell !== undefined && isWide(cell.char) && columns[index + 1]?.spacer === true) {
      columns[index + 1] = { sgr, char: fill }
    }
    columns[index] = { sgr, char: fill }
  }

  const consume = (chunk: string): void => {
    for (const char of chunk) {
      if (char === '\r') { cursor = 0; continue }
      if (char === '\u0008') { cursor = Math.max(0, cursor - 1); continue }
      if (char === '\t') {
        // A tab advances to the next 8-column stop, leaving the cells it skips
        // as they were — which is how a redraw can leave a tabbed column
        // standing. Column alignment is the whole point of this card.
        const stop = cursor + TAB_WIDTH - (cursor % TAB_WIDTH)
        for (; cursor < stop; cursor++) columns[cursor] ??= { sgr, char: ' ' }
        continue
      }
      if (ZERO_WIDTH.test(char)) {
        // No column of its own: it attaches to the cell already written, so a
        // redraw that covers that cell covers the mark with it. With no cell to
        // attach to (line start, or straight after a redraw to column 0) a
        // terminal shows nothing rather than a lone accent.
        const base = cursor > 0 ? columns[cursor - 1] : undefined
        if (base !== undefined) columns[cursor - 1] = { sgr: base.sgr, char: base.char + char }
        continue
      }
      // Writing over either half of a wide pair blanks the other half, since a
      // terminal cannot leave one cell of a two-cell glyph standing.
      clear(cursor, ' ')
      columns[cursor] = { sgr, char }
      cursor++
      // A wide character occupies two columns; the trailing one is a spacer,
      // marked so that overwriting the lead cell leaves a blank behind instead
      // of closing the gap and shifting everything after it left.
      if (isWide(char)) { columns[cursor] = { sgr, char: '', spacer: true }; cursor++ }
    }
  }

  for (const match of line.matchAll(csi)) {
    consume(line.slice(at, match.index))
    at = match.index + match[0].length
    // Both groups are mandatory in the pattern, so destructuring types them as
    // strings without a fallback that could never run.
    const params = String(match[1])
    const final = String(match[2])
    if (final === 'K') {
      // Erase in line: the fixed companion of `\r` in every spinner and progress
      // bar. Without it a shorter redraw leaves the previous frame's tail
      // standing, which is text the terminal never showed. `1` blanks from the
      // line start THROUGH the cursor column (inclusive, per the CSI spec)
      // rather than dropping those cells, since the cursor does not move and a
      // later write can still land past them. Only the FIRST parameter selects
      // the mode; a terminal ignores the rest (`1;2K` erases exactly as `1K`).
      const mode = String(params.split(';')[0])
      if (mode === '1') for (let index = 0; index <= cursor; index++) clear(index, ' ')
      else columns.length = mode === '2' ? 0 : cursor
      continue
    }
    // Only SGR carries graphic state; every other final byte is a cursor or
    // erase action that must not affect a cell's style.
    if (final !== 'm') continue
    sgr = foldSgr(sgr, params)
  }
  consume(line.slice(at))

  // Re-emit the columns, opening a run only where its state changes, so anser
  // sees the same styling a terminal shows. Each boundary emits ONE canonical
  // sequence for the state it opens, which is what keeps the output linear in
  // the number of cells however the state was reached.
  let out = ''
  let active = entrySgr
  for (let index = 0; index < columns.length; index++) {
    const column = columns[index] ?? { sgr: SGR_NONE, char: ' ' }
    if (!sameSgr(column.sgr, active)) {
      if (!sameSgr(active, SGR_NONE)) out += '\u001b[0m'
      out += openSgr(column.sgr)
      active = column.sgr
    }
    // A spacer still holds its column. While its lead cell survives, the wide
    // glyph spans both and the spacer emits nothing; once a later write replaced
    // that lead, the terminal blanks the spacer instead of closing the gap, so
    // emitting nothing would shift everything after it one column left.
    const leadIntact = index > 0 && isWide(columns[index - 1]?.char ?? '')
    out += column.spacer === true && !leadIntact ? ' ' : column.char
  }
  // Converge to the state the SCAN ended in, not the last written cell's: a
  // sequence after the final write (the `\x1b[0m` closing a colored line) changes
  // no cell yet still ends the run, and it has to reach both the DOM and the
  // next line. Without this a line ending in a reset leaked its color onward.
  if (!sameSgr(active, sgr)) {
    if (!sameSgr(active, SGR_NONE)) out += '\u001b[0m'
    out += openSgr(sgr)
  }
  return { text: out, sgr }
}

/** One replayed column: the state it was written with, and its character. */
interface Cell {
  sgr: SgrState
  char: string
  /** The trailing half of a wide character's two-column pair. */
  spacer?: boolean
}

/**
 * Replay every line's cursor movements. A `\r` that only terminates a CRLF line
 * is dropped first, so those lines keep their text instead of being redrawn onto
 * themselves. SGR state threads across lines: a newline does not reset it, so a
 * run opened before a redraw still colors the lines after it.
 * @param text - output text, already free of OSC and non-CSI escapes.
 * @returns the text with each line painted as the terminal would.
 */
function applyCursorMovements(text: string): string {
  const replayed: string[] = []
  let sgr = SGR_NONE
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r+$/, '')
    if (NEEDS_REPLAY.test(line)) {
      const result = replayLine(line, sgr)
      replayed.push(result.text)
      sgr = result.sgr
      continue
    }
    // No cursor movement: the line needs no column buffer, and painting one
    // would allocate a cell per character of output this card never redraws —
    // an `ls -R` or a 5k-line log. Only its own SGR has to be folded, so a later
    // line that DOES replay enters with the right state.
    replayed.push(line)
    for (const match of line.matchAll(SGR_SEQUENCE)) sgr = foldSgr(sgr, String(match[1]))
  }
  return replayed.join('\n')
}

/**
 * Remove every escape sequence and control character that carries no color,
 * leaving CSI sequences for anser and `\n`/`\t` for layout. Cursor movements
 * (carriage return, backspace) replay first, since their effect on the visible
 * text must land before the characters that expressed them are dropped.
 * @param text - raw command output.
 * @returns text whose only remaining escapes are CSI sequences.
 */
function sanitize(text: string): string {
  const escaped = text.replace(OSC_SEQUENCE, '').replace(NON_CSI_ESCAPE, '')
  return applyCursorMovements(escaped).replace(INERT_CONTROL, '')
}

/**
 * Resolve one run's colors and decorations.
 * @param chunk - the anser chunk to style.
 * @returns the run's inline style, or undefined when it carries no SGR state.
 */
function resolveStyle(chunk: AnsiChunk): CSSProperties | undefined {
  const style: CSSProperties = {}
  const background = chunk.bg === null ? undefined : `rgb(${chunk.bg})`
  if (background !== undefined) style.backgroundColor = background
  if (chunk.fg !== null) {
    const literal = `rgb(${chunk.fg})`
    // A run that paints its own background keeps anser's literal pair so the
    // authored foreground/background contrast survives; a foreground-only run
    // maps onto a theme token, which adapts to light and dark surfaces.
    style.color = background === undefined
      ? TOKEN_BY_BASIC_RGB[chunk.fg.replace(/\s+/g, '')] ?? literal
      : literal
  }
  for (const decoration of chunk.decorations) Object.assign(style, STYLE_BY_DECORATION[decoration])
  return Object.keys(style).length === 0 ? undefined : style
}

/**
 * Parse command output into styled spans grouped by line.
 * @param text - raw output text, which may contain ANSI escape sequences.
 * @returns one entry per output line (always at least one, possibly empty).
 */
export function parseAnsiLines(text: string): AnsiLine[] {
  let current: AnsiSpan[] = []
  const lines: AnsiSpan[][] = [current]
  for (const chunk of Anser.ansiToJson(sanitize(text), { json: true, remove_empty: true })) {
    const style = resolveStyle(chunk)
    for (const [index, part] of chunk.content.split('\n').entries()) {
      if (index > 0) {
        current = []
        lines.push(current)
      }
      if (part !== '') current.push({ text: part, style })
    }
  }
  return lines
}
