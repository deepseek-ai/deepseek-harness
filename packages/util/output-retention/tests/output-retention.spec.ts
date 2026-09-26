import { describe, expect, it } from 'vitest'
import {
  describeOmitted,
  formatRetentionNotice,
  ItemRetainer,
  type Omitted,
  type RetentionNotice,
  TextRetainer,
  truncateWithoutSplittingSurrogatePair,
} from '@deepseek-ai/dsh-output-retention'

/** Decode a RetainedText via a round-trip helper for readable UTF-8 assertions. */
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('ItemRetainer — head retention', () => {
  it('keeps the first maxItems while callers keep draining for an exact omitted count', () => {
    const r = new ItemRetainer<string>({ kind: 'head', maxItems: 2 })
    expect(r.push('a')).toEqual({ kept: true, truncated: false })
    expect(r.push('b')).toEqual({ kept: true, truncated: false })
    expect(r.push('c')).toEqual({ kept: false, truncated: true })

    const result = r.finish()
    expect(result.items).toEqual(['a', 'b'])
    expect(result.kept).toBe(2)
    expect(result.seen).toBe(3)
    expect(result.truncated).toBe(true)
    expect(result.omitted).toEqual<Omitted>({ kind: 'exact', count: 1 })
  })

  it('reports none when everything fits', () => {
    const r = new ItemRetainer<number>({ kind: 'head', maxItems: 3 })
    r.push(1)
    r.push(2)
    const result = r.finish()
    expect(result.items).toEqual([1, 2])
    expect(result.truncated).toBe(false)
    expect(result.omitted).toEqual<Omitted>({ kind: 'none' })
  })
  it('keeps draining past the cap and reports an exact omitted count', () => {
    const r = new ItemRetainer<string>({ kind: 'head', maxItems: 1 })
    expect(r.push('a')).toEqual({ kept: true, truncated: false })
    expect(r.push('b')).toEqual({ kept: false, truncated: true })
    expect(r.push('c')).toEqual({ kept: false, truncated: true })

    const result = r.finish()
    expect(result.items).toEqual(['a'])
    expect(result.seen).toBe(3)
    expect(result.omitted).toEqual<Omitted>({ kind: 'exact', count: 2 })
  })
})

describe('ItemRetainer — zero budget', () => {
  it('keeps nothing and counts every pushed item as omitted', () => {
    const r = new ItemRetainer<string>({ kind: 'head', maxItems: 0 })
    expect(r.push('a')).toEqual({ kept: false, truncated: true })
    const result = r.finish()
    expect(result.items).toEqual([])
    expect(result.kept).toBe(0)
    expect(result.omitted).toEqual<Omitted>({ kind: 'exact', count: 1 })
  })

  it('rejects a non-integer / negative maxItems', () => {
    expect(() => new ItemRetainer({ kind: 'head', maxItems: -1 }))
      .toThrow(/maxItems must be a non-negative integer/)
    expect(() => new ItemRetainer({ kind: 'head', maxItems: 1.5 }))
      .toThrow(/maxItems must be a non-negative integer/)
  })
})

describe('TextRetainer — head (exact omission, reads to end)', () => {
  it('keeps the prefix and counts omitted bytes exactly', () => {
    const r = new TextRetainer({ kind: 'head', maxBytes: 5 })
    expect(r.push('abc')).toEqual({ kept: true, truncated: false })
    // 'de' fills the cap exactly (5 bytes) — still fully kept.
    expect(r.push('de')).toEqual({ kept: true, truncated: false })
    expect(r.push('fgh')).toEqual({ kept: false, truncated: true })

    const result = r.finish()
    expect(result.text).toBe('abcde')
    expect(result.truncated).toBe(true)
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'exact', count: 3 })
  })

  it('flags a partially-dropped chunk as not fully kept', () => {
    const r = new TextRetainer({ kind: 'head', maxBytes: 4 })
    r.push('ab')
    // 'cde' straddles the cap: 'c','d' fit, 'e' drops → kept:false.
    expect(r.push('cde')).toEqual({ kept: false, truncated: true })
    expect(r.finish().text).toBe('abcd')
  })

  it('keeps draining past the cap', () => {
    const r = new TextRetainer({ kind: 'head', maxBytes: 3 })
    r.push('abc')
    expect(r.push('defg')).toEqual({ kept: false, truncated: true })
    const result = r.finish()
    expect(result.text).toBe('abc')
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'exact', count: 4 })
  })
})

describe('TextRetainer — tail (exact omission, reads to end)', () => {
  it('keeps the final maxBytes and reports exact omission', () => {
    const r = new TextRetainer({ kind: 'tail', maxBytes: 4 })
    expect(r.push('hello')).toEqual({ kept: false, truncated: true })
    r.push('world')
    const result = r.finish()
    expect(result.text).toBe('orld') // last 4 bytes of 'helloworld'
    expect(result.truncated).toBe(true)
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'exact', count: 6 })
  })

  it('keeps everything when the stream is under the cap', () => {
    const r = new TextRetainer({ kind: 'tail', maxBytes: 100 })
    r.push('short')
    const result = r.finish()
    expect(result.text).toBe('short')
    expect(result.truncated).toBe(false)
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'none' })
  })

  it('drops old chunks as they slide out of the tail window', () => {
    const r = new TextRetainer({ kind: 'tail', maxBytes: 3 })
    for (const c of ['11', '22', '33', '44']) r.push(c)
    // Only the final 3 bytes survive; earlier whole chunks are dropped.
    expect(r.finish().text).toBe('344')
  })
})

describe('TextRetainer — headTail (prefix + suffix, omit the middle)', () => {
  it('keeps a stable head and tail, omitting the middle exactly', () => {
    const r = new TextRetainer({ kind: 'headTail', headBytes: 3, tailBytes: 3 })
    r.push('abcdefghij') // 10 bytes: head 'abc', tail 'hij', middle 'defg' omitted
    const result = r.finish()
    expect(result.text).toBe('abchij')
    expect(result.truncated).toBe(true)
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'exact', count: 4 })
  })

  it('does not double-count when head+tail cover the whole stream', () => {
    const r = new TextRetainer({ kind: 'headTail', headBytes: 3, tailBytes: 3 })
    r.push('abcdef') // exactly head(3) + tail(3), nothing omitted
    const result = r.finish()
    expect(result.text).toBe('abcdef')
    expect(result.truncated).toBe(false)
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'none' })
  })

  it('does not drop a codepoint that spans the head|tail split when nothing is omitted', () => {
    // Regression: with head+tail covering the whole stream, the split is
    // artificial — a multibyte codepoint may straddle it. 'éab' is C3 A9 61 62
    // (4 bytes); headBytes 1 + tailBytes 3 covers all 4 with omitted === 0, but
    // the split falls INSIDE 'é'. The bytes are contiguous, so the full 'éab'
    // must survive — not be trimmed to 'ab'.
    const r = new TextRetainer({ kind: 'headTail', headBytes: 1, tailBytes: 3 })
    r.push('éab')
    const result = r.finish()
    expect(result.text).toBe('éab')
    expect(result.truncated).toBe(false)
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'none' })
  })

  it('still trims boundary partials once a real middle is omitted', () => {
    // With a genuine gap the two sides ARE true cuts: '€' (3 bytes) split across
    // the omitted middle must not resurface as a replacement char on either side.
    const r = new TextRetainer({ kind: 'headTail', headBytes: 2, tailBytes: 2 })
    r.push('a€€b') // 8 bytes; head 'a'+partial, tail partial+'b', middle omitted
    const result = r.finish()
    expect(result.truncated).toBe(true)
    expect(result.text).not.toContain('�')
    expect(result.text.startsWith('a')).toBe(true)
    expect(result.text.endsWith('b')).toBe(true)
  })
})

describe('TextRetainer — zero budgets', () => {
  it('head maxBytes 0 keeps nothing and counts every byte exactly', () => {
    const r = new TextRetainer({ kind: 'head', maxBytes: 0 })
    expect(r.push('x')).toEqual({ kept: false, truncated: true })
    const result = r.finish()
    expect(result.text).toBe('')
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'exact', count: 1 })
  })

  it('an empty stream omits nothing', () => {
    const r = new TextRetainer({ kind: 'headTail', headBytes: 2, tailBytes: 2 })
    const result = r.finish()
    expect(result.text).toBe('')
    expect(result.truncated).toBe(false)
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'none' })
  })

  it('rejects non-integer / negative byte budgets', () => {
    expect(() => new TextRetainer({ kind: 'head', maxBytes: -1 }))
      .toThrow(/maxBytes must be a non-negative integer/)
    expect(() => new TextRetainer({ kind: 'tail', maxBytes: 2.5 }))
      .toThrow(/maxBytes must be a non-negative integer/)
    expect(() => new TextRetainer({ kind: 'headTail', headBytes: -1, tailBytes: 2 }))
      .toThrow(/headBytes must be a non-negative integer/)
    expect(() => new TextRetainer({ kind: 'headTail', headBytes: 2, tailBytes: 1.1 }))
      .toThrow(/tailBytes must be a non-negative integer/)
  })
})

describe('TextRetainer — UTF-8 boundary handling', () => {
  it('trims a partial codepoint at the head cut instead of emitting U+FFFD', () => {
    // '€' is 3 bytes (E2 82 AC). A 2-byte head cap keeps 'a' (61) + the first
    // byte of '€' (E2); that partial lead byte must be trimmed, not decoded to
    // a replacement char.
    const r = new TextRetainer({ kind: 'head', maxBytes: 2 })
    r.push('a€b') // bytes: 61 E2 82 AC 62
    const result = r.finish()
    expect(result.text).toBe('a') // partial '€' dropped, no U+FFFD
    expect(result.text).not.toContain('�')
    // Omission counts bytes ACTUALLY absent from the returned text, including
    // the partial 'E2' the boundary trim dropped: 5 total − 1 retained = 4
    // (not the pre-trim budget of 3, which would overstate what was kept).
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'exact', count: 4 })
  })

  it('trims a leading partial codepoint at the tail cut', () => {
    // Tail cap 2 over 'a€b' (5 bytes) keeps AC 62 — AC is a continuation byte
    // (the middle of '€'); the leading continuation byte is dropped so the tail
    // begins on a boundary.
    const r = new TextRetainer({ kind: 'tail', maxBytes: 2 })
    r.push('a€b')
    const result = r.finish()
    expect(result.text).toBe('b') // partial '€' at the front dropped
    expect(result.text).not.toContain('�')
    // Honest count: 5 total − 1 retained ('b') = 4, including the trimmed AC.
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'exact', count: 4 })
  })

  it('omitted count matches the bytes actually absent, across a headTail boundary trim', () => {
    // Regression: the exact count must equal total − retained (post-trim), never
    // the pre-trim budget. 'a€€b' is 8 bytes (61 E2828C… ×2 61? no: 61 E2 82 AC
    // E2 82 AC 62). headBytes 2 keeps 'a'+partial-E2 → trims to 'a' (1 byte);
    // tailBytes 2 keeps partial-AC+'b' → trims to 'b' (1 byte). Retained text is
    // 2 bytes, so omitted must be 8 − 2 = 6 — not the budget's 8 − 2 − 2 = 4.
    const r = new TextRetainer({ kind: 'headTail', headBytes: 2, tailBytes: 2 })
    r.push('a€€b')
    const result = r.finish()
    const retainedBytes = new TextEncoder().encode(result.text).length
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'exact', count: 8 - retainedBytes })
  })

  it('preserves a whole multibyte codepoint that fits exactly', () => {
    const r = new TextRetainer({ kind: 'head', maxBytes: 3 })
    r.push('€x') // '€' is exactly 3 bytes
    expect(r.finish().text).toBe('€')
  })

  it('does not reconstruct a codepoint across the omitted middle', () => {
    // headBytes ends mid-'€' and tailBytes starts mid-another '€'; neither cut
    // may glue a valid codepoint across the gap.
    const r = new TextRetainer({ kind: 'headTail', headBytes: 2, tailBytes: 2 })
    r.push('€€€') // 9 bytes
    const result = r.finish()
    expect(result.text).not.toContain('�')
    expect(result.truncated).toBe(true)
  })

  it('accepts a raw Uint8Array chunk', () => {
    const r = new TextRetainer({ kind: 'head', maxBytes: 2 })
    r.push(utf8('xy'))
    r.push(utf8('z'))
    expect(r.finish().text).toBe('xy')
  })

  it('trims a partial 2-byte codepoint at the head cut', () => {
    // 'é' is 2 bytes (C3 A9). A 2-byte head cap over 'aé' keeps 'a' (61) + the
    // lead byte of 'é' (C3) — an incomplete 2-byte sequence to trim.
    const r = new TextRetainer({ kind: 'head', maxBytes: 2 })
    r.push('aé') // bytes: 61 C3 A9
    const result = r.finish()
    expect(result.text).toBe('a')
    expect(result.text).not.toContain('�')
  })

  it('trims a partial 4-byte codepoint (emoji) at the head cut', () => {
    // '😀' is 4 bytes (F0 9F 98 80). A 3-byte head cap keeps 'a' + the first two
    // bytes of the emoji — an incomplete 4-byte sequence that must be trimmed.
    const r = new TextRetainer({ kind: 'head', maxBytes: 3 })
    r.push('a😀') // bytes: 61 F0 9F 98 80
    const result = r.finish()
    expect(result.text).toBe('a')
    expect(result.text).not.toContain('�')
  })

  it('keeps a whole 4-byte codepoint that fits exactly', () => {
    const r = new TextRetainer({ kind: 'head', maxBytes: 4 })
    r.push('😀x')
    expect(r.finish().text).toBe('😀')
  })

  it('leaves a head cut ending on a stray continuation run untouched', () => {
    // A cut whose trailing bytes are ALL continuation bytes with no lead in
    // reach is not a trimmable incomplete sequence — the trimmer bails (no lead
    // byte found) and leaves them for the non-fatal decoder to replace.
    const r = new TextRetainer({ kind: 'head', maxBytes: 2 })
    // 0x80 0x80 are bare continuation bytes; 'z' follows so the head keeps just
    // the two continuation bytes and the cut lands right after them.
    r.push(new Uint8Array([0x80, 0x80, 0x7a]))
    const result = r.finish()
    // The trimmer did not throw and did not eat the bytes as a partial sequence;
    // only the trailing 'z' is omitted by the 2-byte cap.
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'exact', count: 1 })
  })

  it('leaves a head cut ending on an invalid lead byte untouched', () => {
    // 0xF8 is not a valid UTF-8 lead byte (only 0x00–0xF7 lead). The trimmer
    // recognizes it as "not a lead" (expected length 0) and leaves the byte in
    // place rather than trimming a phantom partial sequence.
    const r = new TextRetainer({ kind: 'head', maxBytes: 1 })
    r.push(new Uint8Array([0xf8, 0x61])) // 0xF8 kept, 'a' dropped by the 1-byte cap
    const result = r.finish()
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'exact', count: 1 })
  })
})

describe('describeOmitted — false precision safety', () => {
  it('prints an exact count for exact omission', () => {
    expect(describeOmitted({ kind: 'exact', count: 3 }, 'items')).toBe('Omitted 3 items.')
    expect(describeOmitted({ kind: 'exact', count: 12 }, 'bytes')).toBe('Omitted 12 bytes.')
  })

  it('prints NO count for unknown omission', () => {
    expect(describeOmitted({ kind: 'unknown' }, 'lines')).toBe('More lines were omitted.')
  })

  it('returns empty string when nothing was omitted', () => {
    expect(describeOmitted({ kind: 'none' }, 'chars')).toBe('')
  })
})

describe('formatRetentionNotice', () => {
  const notice = (omitted: Omitted): RetentionNotice => ({
    scope: 'grep',
    strategy: 'head',
    unit: 'items',
    limit: 100,
    kept: 100,
    omitted,
  })

  it('joins the standardized omission clause with the tool recovery guidance', () => {
    const out = formatRetentionNotice(
      notice({ kind: 'exact', count: 25 }),
      ({ kept }) => `Results capped at ${kept}. Narrow the pattern, path, or include to see more.`,
    )
    expect(out).toBe('Omitted 25 items. Results capped at 100. Narrow the pattern, path, or include to see more.')
  })

  it('omits the empty half when nothing was omitted', () => {
    const out = formatRetentionNotice(notice({ kind: 'none' }), () => 'Recovery text.')
    expect(out).toBe('Recovery text.')
  })

  it('omits the empty half when the tool supplies no recovery text', () => {
    const out = formatRetentionNotice(notice({ kind: 'exact', count: 2 }), () => '')
    expect(out).toBe('Omitted 2 items.')
  })

  it('passes the full notice to the recovery builder (limit as a head/tail pair)', () => {
    const headTail: RetentionNotice = {
      scope: 'bash stdout',
      strategy: 'headTail',
      unit: 'bytes',
      limit: { head: 2_000, tail: 2_000 },
      kept: 4_000,
      omitted: { kind: 'exact', count: 500 },
    }
    const out = formatRetentionNotice(headTail, n =>
      typeof n.limit === 'object' ? `Kept ${n.limit.head}B head + ${n.limit.tail}B tail.` : '')
    expect(out).toBe('Omitted 500 bytes. Kept 2000B head + 2000B tail.')
  })
})

describe('truncateWithoutSplittingSurrogatePair', () => {
  it('caps at maxChars UTF-16 code units', () => {
    expect(truncateWithoutSplittingSurrogatePair('abcdef', 3)).toBe('abc')
    expect(truncateWithoutSplittingSurrogatePair('abcdef', 0)).toBe('')
    expect(truncateWithoutSplittingSurrogatePair('abcdef', 1)).toBe('a')
  })

  it('returns text within the cap unchanged', () => {
    expect(truncateWithoutSplittingSurrogatePair('abc', 3)).toBe('abc')
    expect(truncateWithoutSplittingSurrogatePair('abc', 9)).toBe('abc')
    expect(truncateWithoutSplittingSurrogatePair('', 0)).toBe('')
  })

  it('drops the unpaired half when the cap lands inside a surrogate pair', () => {
    // '😀' is two code units, so these caps would otherwise keep its high surrogate alone.
    expect(truncateWithoutSplittingSurrogatePair('ab😀cd', 3)).toBe('ab')
    expect(truncateWithoutSplittingSurrogatePair('ab😀cd', 4)).toBe('ab😀')
    expect(truncateWithoutSplittingSurrogatePair('😀😀', 1)).toBe('')
    expect(truncateWithoutSplittingSurrogatePair('😀😀', 3)).toBe('😀')
  })

  it('never ends in a lone high surrogate at any cap', () => {
    const text = 'a😀b😀c'
    for (let maxChars = 0; maxChars <= text.length; maxChars++) {
      const capped = truncateWithoutSplittingSurrogatePair(text, maxChars)
      expect(capped.length).toBeLessThanOrEqual(maxChars)
      expect(capped).not.toMatch(/[\uD800-\uDBFF]$/)
      expect(capped).toBe(text.slice(0, capped.length))
    }
  })
})
