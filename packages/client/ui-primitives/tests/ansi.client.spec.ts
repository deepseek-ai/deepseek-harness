import { describe, expect, it } from 'vitest'
import { parseAnsiLines } from '../src/ansi.ts'

const ESC = '\u001b'
const BS = '\u0008'
/** A combining acute accent: zero-width, so it takes no terminal column. */
const ACCENT = '\u0301'

function sgr(codes: string, text: string): string {
  return `${ESC}[${codes}m${text}${ESC}[0m`
}

function onlySpan(text: string) {
  const lines = parseAnsiLines(text)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toHaveLength(1)
  return lines[0]![0]!
}

describe('parseAnsiLines: text without SGR state', () => {
  it('leaves plain text as one unstyled span', () => {
    expect(parseAnsiLines('hello')).toEqual([[{ text: 'hello', style: undefined }]])
  })

  it('returns exactly one empty line for empty input', () => {
    expect(parseAnsiLines('')).toEqual([[]])
  })

  it('splits a multi-line run and drops the empty line between two blocks', () => {
    expect(parseAnsiLines('a\n\nb')).toEqual([
      [{ text: 'a', style: undefined }],
      [],
      [{ text: 'b', style: undefined }],
    ])
  })

  it('keeps tabs, which the terminal surface needs for column layout', () => {
    expect(onlySpan('a\tb')).toEqual({ text: 'a\tb', style: undefined })
  })
})

describe('parseAnsiLines: basic colors mapped onto theme tokens', () => {
  it.each<[string, string, string]>([
    ['30', 'black', 'var(--dsw-alias-label-primary)'],
    ['37', 'white', 'var(--dsw-alias-label-primary)'],
    ['90', 'bright black', 'var(--dsw-alias-label-tertiary)'],
    ['31', 'red', 'var(--dsw-alias-state-error-primary)'],
    ['91', 'bright red', 'var(--dsw-alias-state-error-secondary)'],
    ['32', 'green', 'var(--dsw-alias-state-success-primary)'],
    ['92', 'bright green', 'var(--dsw-alias-state-success-secondary)'],
    ['33', 'yellow', 'var(--dsw-alias-state-warn-primary)'],
    ['93', 'bright yellow', 'var(--dsw-alias-state-warn-secondary)'],
    ['34', 'blue', 'var(--dsw-alias-state-business-primary)'],
    ['94', 'bright blue', 'var(--dsw-static-blue-400)'],
    ['36', 'cyan', 'var(--dsw-static-blue-600)'],
    ['96', 'bright cyan', 'var(--dsw-static-blue-500)'],
  ])('SGR %s (%s) resolves to %s', (code, _name, token) => {
    expect(onlySpan(sgr(code, 'x'))).toEqual({ text: 'x', style: { color: token } })
  })
})

describe('parseAnsiLines: colors with no token equivalent', () => {
  it.each<[string, string, string]>([
    ['35', 'magenta', 'rgb(187, 0, 187)'],
    ['38;5;208', '256-palette orange', 'rgb(255, 135, 0)'],
    ['38;2;10;20;30', 'truecolor', 'rgb(10, 20, 30)'],
  ])('SGR %s (%s) falls through to %s', (code, _name, literal) => {
    expect(onlySpan(sgr(code, 'x')).style).toEqual({ color: literal })
  })
})

describe('parseAnsiLines: backgrounds', () => {
  it('sets backgroundColor for a background-only run', () => {
    expect(onlySpan(sgr('44', 'x')).style).toEqual({ backgroundColor: 'rgb(0, 0, 187)' })
  })

  it('keeps the literal foreground when the run paints its own background', () => {
    expect(onlySpan(sgr('41;37', 'x')).style).toEqual({
      backgroundColor: 'rgb(187, 0, 0)',
      color: 'rgb(255,255,255)',
    })
  })

  it('renders reverse video as the swapped pair anser reports', () => {
    expect(onlySpan(sgr('31;7', 'x')).style).toEqual({
      backgroundColor: 'rgb(187, 0, 0)',
      color: 'rgb(0, 0, 0)',
    })
  })
})

describe('parseAnsiLines: decorations', () => {
  it.each<[string, string, Record<string, unknown>]>([
    ['1', 'bold', { fontWeight: 700 }],
    ['2', 'dim', { opacity: 0.7 }],
    ['3', 'italic', { fontStyle: 'italic' }],
    ['4', 'underline', { textDecoration: 'underline' }],
    ['9', 'strikethrough', { textDecoration: 'line-through' }],
    ['8', 'hidden', { visibility: 'hidden' }],
  ])('SGR %s (%s) resolves to %o', (code, _name, style) => {
    expect(onlySpan(sgr(code, 'x')).style).toEqual(style)
  })

  it('lets the later textDecoration win when a run declares underline and strikethrough', () => {
    expect(onlySpan(sgr('4;9', 'x')).style).toEqual({ textDecoration: 'line-through' })
    expect(onlySpan(sgr('9;4', 'x')).style).toEqual({ textDecoration: 'underline' })
  })

  it('combines a color with several decorations in one style', () => {
    expect(onlySpan(sgr('1;3;31', 'x')).style).toEqual({
      color: 'var(--dsw-alias-state-error-primary)',
      fontWeight: 700,
      fontStyle: 'italic',
    })
  })

  it('reproduces no animation for blink, leaving the run unstyled', () => {
    expect(onlySpan(sgr('5', 'x'))).toEqual({ text: 'x', style: undefined })
  })
})

describe('parseAnsiLines: sequences that carry no color', () => {
  it('removes an OSC string with its BEL terminator', () => {
    expect(onlySpan(`a${ESC}]0;window title\u0007b`)).toEqual({ text: 'ab', style: undefined })
  })

  it('removes an OSC string terminated by ST', () => {
    expect(onlySpan(`a${ESC}]8;;https://example.com${ESC}\\b`)).toEqual({ text: 'ab', style: undefined })
  })

  it('removes non-CSI escapes such as charset selection and reset', () => {
    expect(onlySpan(`x${ESC}(By${ESC}cz`)).toEqual({ text: 'xyz', style: undefined })
  })

  it('removes inert C0 controls', () => {
    expect(onlySpan('\u0000ab\u001fc\u007f')).toEqual({ text: 'abc', style: undefined })
  })

  it('keeps CSI sequences that only move the cursor out of the text', () => {
    expect(onlySpan(`${ESC}[2K${ESC}[1Adone`)).toEqual({ text: 'done', style: undefined })
  })
})

describe('parseAnsiLines: carriage returns', () => {
  it('keeps only the last redraw of a line', () => {
    expect(onlySpan('10%\r55%\r100%')).toEqual({ text: '100%', style: undefined })
  })

  it('leaves the tail of a longer frame standing under a shorter redraw', () => {
    // Verified against a real terminal: `100%\rOK` paints `OK0%`. A carriage
    // return only moves the cursor, so the two columns the redraw never reaches
    // still hold the frame beneath — truncating to the last `\r` would lose them.
    expect(onlySpan('100%\rOK')).toEqual({ text: 'OK0%', style: undefined })
    expect(onlySpan('abcdef\rXY')).toEqual({ text: 'XYcdef', style: undefined })
  })

  it('clamps a backspace run at the line start rather than going negative', () => {
    // More backspaces than characters: the cursor stops at column 0, so the
    // following write simply overwrites from there.
    expect(onlySpan(`ab${BS}${BS}${BS}${BS}xyz`)).toEqual({ text: 'xyz', style: undefined })
  })

  it('keeps SGR state in force across a redraw, as a terminal does', () => {
    // Verified against a real terminal: `\x1b[31mgone\rkept` paints `kept` RED.
    // A carriage return moves the cursor; it does not reset the graphic state,
    // so the redraw inherits the color the discarded frame was written with.
    expect(onlySpan(`${ESC}[31mgone\rkept`))
      .toEqual({ text: 'kept', style: { color: 'var(--dsw-alias-state-error-primary)' } })
  })

  it('preserves both lines of a CRLF pair instead of treating it as a redraw', () => {
    expect(parseAnsiLines('a\r\r\nb\r\n')).toEqual([
      [{ text: 'a', style: undefined }],
      [{ text: 'b', style: undefined }],
      [],
    ])
  })

  it('applies the redraw per line, not across the whole text', () => {
    expect(parseAnsiLines('one\rtwo\nthree')).toEqual([
      [{ text: 'two', style: undefined }],
      [{ text: 'three', style: undefined }],
    ])
  })
})

describe('parseAnsiLines: backspaces', () => {
  it('applies a backspace as the overwrite a terminal draws', () => {
    // `abc` then two backspaces then `XY` shows as `aXY`, not `abcXY`.
    expect(onlySpan(`abc${BS}${BS}XY`)).toEqual({ text: 'aXY', style: undefined })
  })

  it('stops at the line start instead of eating the newline before it', () => {
    expect(parseAnsiLines(`ab\n${BS}${BS}${BS}cd`)).toEqual([
      [{ text: 'ab', style: undefined }],
      [{ text: 'cd', style: undefined }],
    ])
  })

  it('treats a trailing backspace as a cursor move, not a delete', () => {
    // Verified against a real terminal: `abc\b` still shows `abc`. Only a later
    // write overwrites; a backspace with nothing after it erases nothing.
    expect(onlySpan(`abc${BS}`)).toEqual({ text: 'abc', style: undefined })
    // Same at a line boundary: the newline ends the line before any overwrite.
    expect(parseAnsiLines(`abc${BS}\ndef`)).toEqual([
      [{ text: 'abc', style: undefined }],
      [{ text: 'def', style: undefined }],
    ])
  })

  it('steps over an SGR sequence instead of erasing its bytes', () => {
    // `abc` reset then two backspaces then `XY`: erasing the reset's bytes would
    // corrupt it and repaint the rest of the line with whatever the remainder
    // parses as. The visible result is `aXY`, still red, with the reset intact.
    expect(parseAnsiLines(`${sgr('31', 'abc')}${BS}${BS}XY`)).toEqual([[
      { text: 'a', style: { color: 'var(--dsw-alias-state-error-primary)' } },
      { text: 'XY', style: undefined },
    ]])
  })

  it('erases across a style boundary without dropping the styles between', () => {
    // The backspace reaches back past the reset to the last printed character.
    expect(parseAnsiLines(`${sgr('32', 'ok')}${ESC}[31m${BS}bad`)).toEqual([[
      { text: 'o', style: { color: 'var(--dsw-alias-state-success-primary)' } },
      { text: 'bad', style: { color: 'var(--dsw-alias-state-error-primary)' } },
    ]])
  })

  it('replays a redraw and a trailing backspace as pure cursor moves', () => {
    // Verified against a real terminal: `old\rnew\b` shows `new`. The redraw
    // repaints all three columns and the trailing backspace only moves the
    // cursor left — nothing overwrites the `w`, so nothing is lost.
    expect(onlySpan(`old\rnew${BS}`)).toEqual({ text: 'new', style: undefined })
  })

  it('overwrites only the columns the later write reaches, keeping the rest styled', () => {
    // Verified against a real terminal: red `bad`, three backspaces, then `ok`
    // shows `okd` — the cursor returned to column 0 and `ok` overwrote two of
    // the three columns, so the untouched `d` keeps the run's red.
    expect(parseAnsiLines(`${sgr('31', 'bad')}${BS}${BS}${BS}ok`)).toEqual([[
      { text: 'ok', style: undefined },
      { text: 'd', style: { color: 'var(--dsw-alias-state-error-primary)' } },
    ]])
  })
})

describe('parseAnsiLines: erase and column arithmetic', () => {
  it('erases the rest of the line, the fixed companion of a redraw', () => {
    // Verified in a real terminal: `100%\r\x1b[KOK` shows `OK`. Every spinner and
    // progress bar writes `\r\x1b[K`; without the erase the previous frame's tail
    // stands and the card shows text the terminal never displayed.
    expect(onlySpan(`100%\r${ESC}[KOK`)).toEqual({ text: 'OK', style: undefined })
    // The parameterless form and `0` are the same erase.
    expect(onlySpan(`100%\r${ESC}[0KOK`)).toEqual({ text: 'OK', style: undefined })
  })

  it('erases the whole line for the 2K form and to the cursor for 1K', () => {
    expect(onlySpan(`ab\r${ESC}[2Kxy`)).toEqual({ text: 'xy', style: undefined })
    // 1K clears left of the cursor without moving it, so those columns read as
    // blanks — verified in a real terminal, which shows `    |` for this input.
    expect(onlySpan(`abcd${ESC}[1K|`)).toEqual({ text: '    |', style: undefined })
  })

  it('paints columns a 2K dropped as blanks when a later write lands past them', () => {
    // 2K clears the line but leaves the cursor where it was, so writing there
    // leaves the columns before it unwritten — blanks, as a terminal shows.
    expect(onlySpan(`abcd${ESC}[2Kx`)).toEqual({ text: '    x', style: undefined })
  })

  it('advances a redraw cursor by tab stops, leaving a tabbed column standing', () => {
    // Verified in a real terminal: `a\tb\rXY` shows `XY      b` — the `b` sits at
    // column 8, which a two-character redraw cannot reach. Counting the tab as
    // one column would have produced `XYb` and destroyed the alignment.
    expect(onlySpan('a\tb\rXY')).toEqual({ text: 'XY      b', style: undefined })
  })

  it('counts a wide character as the two columns a terminal advances', () => {
    // `中` occupies two cells, so a two-character redraw covers exactly it.
    expect(onlySpan('中x\rab')).toEqual({ text: 'abx', style: undefined })
  })

  it('does not accumulate a cursor or erase sequence into a cell style', () => {
    // Only SGR carries graphic state. An erase folded into the style string
    // would grow it per redraw and emit boundaries anser has to discard.
    expect(parseAnsiLines(`${ESC}[31ma\r${ESC}[Kb`)).toEqual([[
      { text: 'b', style: { color: 'var(--dsw-alias-state-error-primary)' } },
    ]])
  })
})

describe('parseAnsiLines: line-end state and column widths', () => {
  it('closes a run whose reset lands after the last written cell', () => {
    // Verified in a real terminal: `\x1b[32mdone\rok\x1b[0m` then `plain` shows
    // `okne` GREEN and `plain` in the DEFAULT color. The reset changes no cell,
    // so returning the last cell's state leaked green onto every later line —
    // and this exact shape (`\r\x1b[K\x1b[32m✓ built\x1b[0m`) is what every
    // build tool writes.
    expect(parseAnsiLines(`${ESC}[32mdone\rok${ESC}[0m\nplain`)).toEqual([
      [{ text: 'okne', style: { color: 'var(--dsw-alias-state-success-primary)' } }],
      [{ text: 'plain', style: undefined }],
    ])
  })

  it('erases through the cursor column for 1K, not up to it', () => {
    // Verified in a real terminal: `abcd\b\x1b[1K|` shows `   |` — the `d` under
    // the cursor is erased too, which the CSI spec calls inclusive.
    expect(onlySpan(`abcd${BS}${ESC}[1K|`)).toEqual({ text: '   |', style: undefined })
  })

  it('gives a combining mark no column of its own', () => {
    // Verified in a real terminal: `é` (e + U+0301) then `x`, redrawn with `YZ`,
    // shows `YZ`. Counting the mark as a column left the `x` standing.
    expect(onlySpan('e\u0301x\rYZ')).toEqual({ text: 'YZ', style: undefined })
  })

  it('drops a combining mark left with no cell to attach to by a redraw', () => {
    // Verified in a real terminal: `ab` then CR then U+0301 then `x` shows `xb`.
    // The redraw puts the cursor at column 0, so the mark has no preceding cell
    // and the terminal shows nothing for it rather than a lone accent.
    expect(onlySpan(`ab\r${ACCENT}x`)).toEqual({ text: 'xb', style: undefined })
    // A mark with no movement on its line never reaches the replay at all: it
    // is width business, not a cursor move, so it stays as authored.
    expect(onlySpan(`${ACCENT}abc`)).toEqual({ text: `${ACCENT}abc`, style: undefined })
  })

  it('carries a colour opened after the last write onto the next line', () => {
    // The mirror of the reset case, verified in a real terminal: `ab` CR `X` then
    // `\x1b[31m` with nothing after it shows `Xb` UNSTYLED and the next line red.
    // The scan ends styled while the last cell is not, so the convergence has to
    // open the run at the line end for it to reach the following line.
    expect(parseAnsiLines(`ab\rX${ESC}[31m\nnext`)).toEqual([
      [{ text: 'Xb', style: undefined }],
      [{ text: 'next', style: { color: 'var(--dsw-alias-state-error-primary)' } }],
    ])
  })

  it('blanks a wide character\'s spacer once its lead cell is overwritten', () => {
    // Verified in a real terminal: `中x` redrawn with `A` shows `A x` — the wide
    // glyph's second cell becomes a blank rather than closing the gap, so the
    // `x` keeps column 3.
    expect(onlySpan('中x\rA')).toEqual({ text: 'A x', style: undefined })
    // Covering both of its columns leaves no spacer behind.
    expect(onlySpan('中x\rab')).toEqual({ text: 'abx', style: undefined })
  })

  it('replays an erase whose parameters carry a semicolon', () => {
    // The replay guard has to match the same CSI shape the parser accepts, or a
    // form like `\x1b[1;2K` skips the replay and its erase never happens.
    expect(onlySpan(`abcd${ESC}[1;2K|`)).toEqual({ text: '    |', style: undefined })
  })
})

describe('parseAnsiLines: bounded state and true widths', () => {
  it('emits one canonical sequence per boundary however the state was reached', () => {
    // Colors that never fully reset would, under a raw per-cell sequence
    // history, re-emit the whole chain at every boundary: 3200 such cells
    // produce 25 MB and eventually a RangeError. Normalized state keeps
    // the emitted text linear in the number of cells.
    let input = ''
    for (let index = 0; index < 2000; index += 1) input += `${ESC}[3${index % 6 + 1}mx`
    const emitted = parseAnsiLines(`${input}\rz`)[0] ?? []
    expect(emitted.reduce((total, span) => total + span.text.length, 0)).toBe(2000)
  })

  it('closes an attribute with its closer instead of appending to the state', () => {
    // `1` then `22` is bold then not-bold, which every chalk-based tool writes;
    // appending both left the cell bold and grew the chain.
    // Verified in a real terminal: the `22` closes the bold, so the `x` written
    // after the redraw is PLAIN. Appending both left it bold and grew the chain.
    expect(parseAnsiLines(`${ESC}[1mbold${ESC}[22mplain\r${ESC}[Kx`)).toEqual([[
      { text: 'x', style: undefined },
    ]])
    expect(parseAnsiLines(`${ESC}[1mA${ESC}[22mB`)).toEqual([[
      { text: 'A', style: { fontWeight: 700 } },
      { text: 'B', style: undefined },
    ]])
  })

  it('folds extended colors, backgrounds and every attribute closer', () => {
    // The 256-palette and truecolor forms consume their own arguments, so the
    // fold has to take them whole rather than as separate codes.
    expect(parseAnsiLines(`${ESC}[38;5;208mA\r${ESC}[KB`)).toEqual([[
      { text: 'B', style: { color: 'rgb(255, 135, 0)' } },
    ]])
    expect(parseAnsiLines(`${ESC}[38;2;10;20;30mA\r${ESC}[KB`)).toEqual([[
      { text: 'B', style: { color: 'rgb(10, 20, 30)' } },
    ]])
    // A background survives the same way, and `49` closes it.
    expect(parseAnsiLines(`${ESC}[41mA${ESC}[49mB\r${ESC}[KC`)).toEqual([[
      { text: 'C', style: undefined },
    ]])
    // Each closer drops only its own attribute: `4` underline closed by `24`
    // while the italic opened before it stays in force.
    expect(parseAnsiLines(`${ESC}[3;4mA${ESC}[24mB\r${ESC}[KC`)).toEqual([[
      { text: 'C', style: { fontStyle: 'italic' } },
    ]])
    // `39` closes a foreground without touching the background.
    expect(parseAnsiLines(`${ESC}[31;42mA${ESC}[39mB\r${ESC}[KC`)).toEqual([[
      { text: 'C', style: { backgroundColor: 'rgb(0, 187, 0)' } },
    ]])
  })

  it('folds the remaining SGR shapes the model has to carry', () => {
    // A 48-background in extended form, so the `48` arm and the `2`-span both run.
    expect(parseAnsiLines(`${ESC}[48;2;1;2;3mA\r${ESC}[KB`)).toEqual([[
      { text: 'B', style: { backgroundColor: 'rgb(1, 2, 3)' } },
    ]])
    // A bright foreground and a bright background, the 90-97 / 100-107 arms.
    expect(parseAnsiLines(`${ESC}[91mA\r${ESC}[KB`)).toEqual([[
      { text: 'B', style: { color: 'var(--dsw-alias-state-error-secondary)' } },
    ]])
    expect(parseAnsiLines(`${ESC}[101mA\r${ESC}[KB`)).toEqual([[
      { text: 'B', style: { backgroundColor: 'rgb(255, 85, 85)' } },
    ]])
    // An extended form with no recognized kind byte consumes nothing extra.
    expect(parseAnsiLines(`${ESC}[38mA\r${ESC}[KB`)).toEqual([[{ text: 'B', style: undefined }]])
    // Re-opening an attribute already in force does not duplicate it, and a bare
    // `\x1b[m` resets exactly as `\x1b[0m` does.
    expect(parseAnsiLines(`${ESC}[1m${ESC}[1mA${ESC}[mB\r${ESC}[KC`)).toEqual([[
      { text: 'C', style: undefined },
    ]])
  })

  it('treats a text-presentation symbol as one column', () => {
    // Verified in a real terminal: `A✓B` redrawn with `XY` shows `XYB`, so the
    // check mark is ONE column. Taking the whole U+2600-U+27BF block as wide
    // misaligned exactly the progress output this card exists to show.
    expect(onlySpan('A\u2713B\rXY')).toEqual({ text: 'XYB', style: undefined })
    // An emoji-presentation character is two, so the same redraw leaves a blank.
    expect(onlySpan('A\u{1f600}B\rXY')).toEqual({ text: 'XY B', style: undefined })
  })

  it('clears a wide pair from either side, including through an erase', () => {
    // Verified in a real terminal (`A x`): the redraw puts the cursor at column
    // 0, the backspace clamps there, and writing `A` over the wide lead blanks
    // its spacer rather than letting the `x` slide left.
    expect(onlySpan(`\u4e2dx\r${BS}A`)).toEqual({ text: 'A x', style: undefined })
    // An erase reaching the lead blanks its spacer through the same helper.
    // Verified in a real terminal (`   |`): 1K blanks through the cursor column,
    // so the wide glyph's two cells and the `x` all become blanks.
    expect(onlySpan(`\u4e2dx${ESC}[1K|`)).toEqual({ text: '   |', style: undefined })
  })

  it('clears the lead when the write lands on the spacer itself', () => {
    // Two backspaces from after `中x` stop ON the wide glyph's second cell;
    // writing there blanks the lead through the spacer side of the pair clear,
    // so the glyph cannot survive as half a character.
    expect(onlySpan(`中x${BS}${BS}A`)).toEqual({ text: ' Ax', style: undefined })
  })

  it('keeps a surviving spacer as a blank when its lead was replaced by a spacer', () => {
    // `好` written over the first glyph's spacer puts its own spacer on the
    // second glyph's lead cell — a write that goes down without a pair clear.
    // The second glyph's spacer survives with a dead lead and must emit a
    // blank, or everything after it shifts one column left.
    expect(onlySpan(`中中${BS}${BS}${BS}好`)).toEqual({ text: ' 好 ', style: undefined })
  })

  it('blanks both halves of a wide pair when either is overwritten', () => {
    // A terminal cannot leave one cell of a two-cell glyph standing, so writing
    // over the spacer clears the lead as well.
    // Verified in a real terminal: two wide chars, CR, then `A` shows `A ` and
    // the second glyph — writing the lead cell blanks its spacer, so the column
    // stays occupied rather than collapsing.
    expect(onlySpan('\u4e2d\u4e2d\rA')).toEqual({ text: 'A \u4e2d', style: undefined })
  })
})

describe('parseAnsiLines: SGR across lines', () => {
  it('carries active state past a newline, as a terminal does', () => {
    // Verified in a real terminal: `\x1b[31mabc\rX\nnext` paints BOTH lines red.
    // A newline does not reset the graphic state, so a replayed line must hand
    // its state to the next one instead of closing it off.
    expect(parseAnsiLines(`${ESC}[31mabc\rX\nnext`)).toEqual([
      [{ text: 'Xbc', style: { color: 'var(--dsw-alias-state-error-primary)' } }],
      [{ text: 'next', style: { color: 'var(--dsw-alias-state-error-primary)' } }],
    ])
  })

  it('tracks state through a line that needs no replay', () => {
    // The middle line has no movement, so it is not replayed — but its own SGR
    // still has to reach the line after it.
    expect(parseAnsiLines(`a\r${ESC}[32mb\nplain\nc`)).toEqual([
      [{ text: 'b', style: { color: 'var(--dsw-alias-state-success-primary)' } }],
      [{ text: 'plain', style: { color: 'var(--dsw-alias-state-success-primary)' } }],
      [{ text: 'c', style: { color: 'var(--dsw-alias-state-success-primary)' } }],
    ])
  })
})

describe('parseAnsiLines: runs spanning lines', () => {
  it('carries one run\'s style onto every line it covers', () => {
    expect(parseAnsiLines(sgr('32', 'first\nsecond'))).toEqual([
      [{ text: 'first', style: { color: 'var(--dsw-alias-state-success-primary)' } }],
      [{ text: 'second', style: { color: 'var(--dsw-alias-state-success-primary)' } }],
    ])
  })

  it('keeps several runs of one line in order', () => {
    expect(parseAnsiLines(`plain${sgr('31', 'red')}tail`)).toEqual([[
      { text: 'plain', style: undefined },
      { text: 'red', style: { color: 'var(--dsw-alias-state-error-primary)' } },
      { text: 'tail', style: undefined },
    ]])
  })
})
