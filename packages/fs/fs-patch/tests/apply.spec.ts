/**
 * Text fixtures adapted from OpenAI Codex rust-v0.158.0 seek_sequence.rs,
 * file_update_tests.rs, and lib.rs (Apache-2.0; see ../LICENSE).
 */

import { describe, expect, it } from 'vitest'
import { applyHunks, parsePatch } from '../src/index.ts'
import type { HunkApplyFailure, PatchHunk } from '../src/index.ts'

function update(...body: string[]): PatchHunk[] {
  const [operation] = parsePatch(['*** Begin Patch', '*** Update File: a', ...body, '*** End Patch'].join('\n'))
  if (operation?.kind !== 'update') throw new Error('Expected one parsed update')
  return operation.hunks
}

describe('applyHunks', () => {
  it.each([
    // Upstream: test_multiple_update_chunks_apply_to_single_file; test_unified_diff.
    { name: 'multiple hunks search the original text', before: 'foo\nbar\nbaz\nqux\n', body: ['@@', ' foo', '-bar', '+BAR', '@@', ' baz', '-qux', '+QUX'], after: 'foo\nBAR\nbaz\nQUX\n' },
    // Upstream: test_update_file_hunk_interleaved_changes.
    { name: 'interleaved replacements and an EOF addition', before: 'a\nb\nc\nd\ne\nf\n', body: ['@@', ' a', '-b', '+B', '@@', ' c', ' d', '-e', '+E', '@@', ' f', '+g', '*** End of File'], after: 'a\nB\nc\nd\nE\nf\ng\n' },
    // Upstream: test_pure_addition_chunk_followed_by_removal.
    { name: 'an append precedes a removal in patch order', before: 'line1\nline2\nline3\n', body: ['@@', '+after-context', '+second-line', '@@', ' line1', '-line2', '-line3', '+line2-replacement'], after: 'line1\nline2-replacement\nafter-context\nsecond-line\n' },
    // Upstream: test_update_line_with_unicode_dash.
    { name: 'ASCII patch matches Unicode dashes', before: 'import asyncio  # local import – avoids top‑level dep\n', body: ['-import asyncio  # local import - avoids top-level dep', '+import asyncio  # HELLO'], after: 'import asyncio  # HELLO\n' },
    // Upstream: test_unified_diff_first_line_replacement.
    { name: 'first line replacement', before: 'foo\nbar\nbaz\n', body: ['-foo', '+FOO', ' bar'], after: 'FOO\nbar\nbaz\n' },
    // Upstream: test_unified_diff_last_line_replacement.
    { name: 'last line replacement', before: 'foo\nbar\nbaz\n', body: [' foo', ' bar', '-baz', '+BAZ'], after: 'foo\nbar\nBAZ\n' },
    // Upstream: test_unified_diff_insert_at_eof.
    { name: 'pure insertion with an EOF marker', before: 'foo\nbar\nbaz\n', body: ['+quux', '*** End of File'], after: 'foo\nbar\nbaz\nquux\n' },
    // Upstream: test_exact_match_finds_sequence.
    { name: 'exact sequence', before: 'foo\nbar\nbaz\n', body: ['-bar', '-baz', '+done'], after: 'foo\ndone\n' },
    // Upstream: test_rstrip_match_ignores_trailing_whitespace.
    { name: 'trailing whitespace is ignored on both sides', before: 'foo   \nbar\t\t\n', body: ['-foo\t', '-bar ', '+done'], after: 'done\n' },
    // Upstream: test_trim_match_ignores_leading_and_trailing_whitespace.
    { name: 'leading and trailing whitespace is ignored', before: '    foo   \n   bar\t\n', body: ['- foo', '-bar', '+done'], after: 'done\n' },
    { name: 'exact match wins over an earlier trimmed match', before: 'x \nx\n', body: ['-x', '+X'], after: 'x \nX\n' },
    { name: 'trailing-only match wins over an earlier fully trimmed match', before: ' x\nx \n', body: ['-x', '+X'], after: ' x\nX\n' },
    { name: 'trimmed match wins over an earlier punctuation match', before: 'x–y\n x-y \n', body: ['-x-y', '+X'], after: 'x–y\nX\n' },
    { name: 'each hunk takes the first remaining repeated sequence', before: 'x\nx\nx\n', body: ['-x', '+first', '@@', '-x', '+second'], after: 'first\nsecond\nx\n' },
    { name: 'anchors advance beyond the matching line', before: 'fn a\nx\nfn b\nx\n', body: ['@@ fn b', '-x', '+X'], after: 'fn a\nx\nfn b\nX\n' },
    { name: 'repeated anchors use the advancing cursor', before: 'fn\nx\nfn\nx\n', body: ['@@ fn', '-x', '+first', '@@ fn', '-x', '+second'], after: 'fn\nfirst\nfn\nsecond\n' },
    { name: 'anchors also use punctuation tolerance', before: 'fn “a”\nx\n', body: ['@@ fn "a"', '-x', '+X'], after: 'fn “a”\nX\n' },
    { name: 'empty-file insertion', before: '', body: ['+hello'], after: 'hello\n' },
    { name: 'insertion after an unterminated final line', before: 'hello', body: ['+world'], after: 'hello\nworld\n' },
    { name: 'insertion before the final empty source line', before: 'hello\n\n', body: ['+world'], after: 'hello\nworld\n' },
    { name: 'insertion into a one-newline file', before: '\n', body: ['+hello'], after: 'hello\n' },
    { name: 'anchored pure insertion still appends at EOF', before: 'fn\nx\ny\n', body: ['@@ fn', '+last'], after: 'fn\nx\ny\nlast\n' },
    { name: 'multiple pure insertions retain patch order', before: 'x\n', body: ['+first', '@@', '+second'], after: 'x\nfirst\nsecond\n' },
    { name: 'pure deletion retains surrounding lines', before: 'a\nb\nc\n', body: ['-b'], after: 'a\nc\n' },
    { name: 'deletion to empty text', before: 'a\n', body: ['-a'], after: '' },
    { name: 'replacement adds a missing final newline', before: 'a', body: ['-a', '+b'], after: 'b\n' },
    { name: 'EOF prefers the tail over an earlier exact match', before: 'x\nx \n', body: ['-x', '+X', '*** End of File'], after: 'x\nX\n' },
    { name: 'EOF may search before the sequential cursor', before: 'x\n', body: ['@@ x', '-x', '+X', '*** End of File'], after: 'X\n' },
    { name: 'overlapping EOF hunks retain upstream replacement order', before: 'x\n', body: ['-x', '+first', '@@', '-x', '+second', '*** End of File'], after: 'first\n' },
    { name: 'trailing empty context retries without both sentinels', before: 'a\n', body: ['-a', '+b', ''], after: 'b\n' },
    { name: 'trailing empty old line can retry without trimming the insertion', before: 'a\n', body: ['-a', '-', '+b'], after: 'b\n' },
    { name: 'empty retry pattern matches the cursor', before: '', body: ['-', '+b'], after: 'b\n' },
    { name: 'empty retry after an anchor matches its cursor', before: 'a\n', body: ['@@ a', '-', '+b'], after: 'a\nb\n' },
    { name: 'explicit context is replaced from patch text in NormalizeToLf', before: '  context\r\nold\n', body: [' context', '-old', '+new'], after: 'context\nnew\n' },
    { name: 'CRLF input retains CR on untouched lines', before: 'a\r\nb\r\n', body: ['-a', '+A'], after: 'A\nb\r\n' },
    { name: 'appending does not normalize existing CRLF', before: 'a\r\n', body: ['+b'], after: 'a\r\nb\n' },
    { name: 'lone CR remains an ordinary character', before: 'a\rb\n', body: ['-a\rb', '+c'], after: 'c\n' },
    { name: 'non-ASCII content survives unchanged', before: '你好🙂\n', body: [' 你好🙂', '+é'], after: '你好🙂\né\n' },
    { name: 'long interior whitespace survives all failed earlier candidates', before: `${' '.repeat(32_000)}x–y\n`, body: ['-x-y', '+done'], after: 'done\n' },
  ])('$name', ({ before, body, after }) => {
    const hunks = update(...body)
    const originalHunks = JSON.stringify(hunks)
    const result = applyHunks(before, hunks)
    expect(result).toEqual({ ok: true, after })
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
    expect(JSON.stringify(hunks)).toBe(originalHunks)
  })

  it.each([
    ...'‐‑‒–—―−'.split('').map(character => ({ character, ascii: '-' })),
    ...'‘’‚‛'.split('').map(character => ({ character, ascii: "'" })),
    ...'“”„‟'.split('').map(character => ({ character, ascii: '"' })),
    ...'\u00A0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000'.split('').map(character => ({ character, ascii: ' ' })),
  ])('normalizes interior punctuation $character on either side', ({ character, ascii }) => {
    expect(applyHunks(`a${character}b\n`, update(`-a${ascii}b`, '+done'))).toEqual({ ok: true, after: 'done\n' })
    expect(applyHunks(`a${ascii}b\n`, update(`-a${character}b`, '+done'))).toEqual({ ok: true, after: 'done\n' })
  })

  it.each(['\u0085', '\u00A0', '\u2003', '\u3000'])('trims Rust White_Space %j', (space) => {
    expect(applyHunks(`${space}x${space}\n`, update('-x', '+done'))).toEqual({ ok: true, after: 'done\n' })
  })

  it.each<{ name: string; before: string; body: string[]; failure: HunkApplyFailure }>([
    // Upstream: test_pattern_longer_than_input_returns_none.
    { name: 'pattern longer than the file', before: 'one\n', body: ['-too', '-many', '-lines'], failure: { hunkLineNumber: 3, stage: 'oldLines', searchStart: 0, pattern: ['too', 'many', 'lines'] } },
    { name: 'anchor not found', before: 'a\n', body: ['@@ missing', '-a', '+b'], failure: { hunkLineNumber: 3, stage: 'context', searchStart: 0, pattern: ['missing'] } },
    { name: 'old content not found after an anchor', before: 'fn\na\n', body: ['@@ fn', '-missing', '+b'], failure: { hunkLineNumber: 3, stage: 'oldLines', searchStart: 1, pattern: ['missing'] } },
    { name: 'later context exists only before the previous hunk', before: 'fn\na\n', body: ['-a', '+b', '@@ fn', '+c'], failure: { hunkLineNumber: 5, stage: 'context', searchStart: 2, pattern: ['fn'] } },
    { name: 'later old lines exist only before the previous hunk', before: 'a\nb\n', body: ['-b', '+B', '@@', '-a', '+A'], failure: { hunkLineNumber: 5, stage: 'oldLines', searchStart: 2, pattern: ['a'] } },
    { name: 'inserted text is not a later search candidate', before: 'a\n', body: ['-a', '+b', '@@', '-b', '+c'], failure: { hunkLineNumber: 5, stage: 'oldLines', searchStart: 1, pattern: ['b'] } },
    { name: 'EOF does not fall back to an earlier match', before: 'x\ny\n', body: ['-x', '+X', '*** End of File'], failure: { hunkLineNumber: 3, stage: 'oldLines', searchStart: 0, pattern: ['x'] } },
    { name: 'failed sentinel retry reports the original pattern', before: 'a\n', body: ['-missing', '-', '+b', '+'], failure: { hunkLineNumber: 3, stage: 'oldLines', searchStart: 0, pattern: ['missing', ''] } },
    { name: 'BOM is not Rust whitespace', before: '\uFEFFa\n', body: ['-a', '+b'], failure: { hunkLineNumber: 3, stage: 'oldLines', searchStart: 0, pattern: ['a'] } },
    { name: 'combining marks are not Unicode-normalized', before: 'é\n', body: ['-é', '+b'], failure: { hunkLineNumber: 3, stage: 'oldLines', searchStart: 0, pattern: ['é'] } },
    { name: 'interior EN QUAD is outside the punctuation mapping', before: 'a\u2000b\n', body: ['-a b', '+b'], failure: { hunkLineNumber: 3, stage: 'oldLines', searchStart: 0, pattern: ['a b'] } },
    { name: 'lone CR does not split source lines', before: 'a\rb', body: ['-a', '-b', '+c'], failure: { hunkLineNumber: 3, stage: 'oldLines', searchStart: 0, pattern: ['a', 'b'] } },
  ])('$name', ({ before, body, failure }) => {
    const hunks = update(...body)
    const originalHunks = JSON.stringify(hunks)
    const result = applyHunks(before, hunks)
    expect(result).toEqual({ ok: false, failure })
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
    expect(JSON.stringify(hunks)).toBe(originalHunks)
  })

  it.each([
    ['', ''], ['a', 'a\n'], ['a\n', 'a\n'], ['a\n\n', 'a\n'],
  ])('empty hunk list applies NormalizeToLf reconstruction to %j', (before, after) => {
    const operations = parsePatch('*** Begin Patch\n*** End Patch')
    const hunks = operations.flatMap(operation => operation.kind === 'update' ? operation.hunks : [])
    expect(applyHunks(before, hunks)).toEqual({ ok: true, after })
  })
})

it('returns failure patterns independent of the parsed hunk arrays', () => {
  const hunks = update('-missing', '+replacement')
  const result = applyHunks('other\n', hunks)
  expect(result).toEqual({ ok: false, failure: { hunkLineNumber: 3, stage: 'oldLines', searchStart: 0, pattern: ['missing'] } })
  if (result.ok) throw new Error('Expected failure')
  result.failure.pattern.push('caller annotation')
  expect(hunks[0]?.oldLines).toEqual(['missing'])
})
