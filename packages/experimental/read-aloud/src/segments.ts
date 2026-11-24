/**
 * Spoken-length estimate and segmentation of read-aloud text. Each segment is synthesized by one request, so a reading
 * that stops early never submits the segments after it.
 * [Rationale](../../../../.agents/notes/implemented/feature/2026-11-23-read-aloud-segment-pacing.md).
 */

/** Marks that end a sentence; a line break counts as one. */
const STRONG_MARKS = '。！？；.!?;\n'
/** Marks that end a clause. */
const WEAK_MARKS = '，,'
/** Longest run, in UTF-16 code units, kept as one unit when it holds no pausing mark. */
const UNIT_CAP = 100
const READABLE = /[\p{L}\p{N}]/u

/** A half-open range of UTF-16 code units in the read-aloud text. */
export interface TextRange {
  readonly start: number
  readonly end: number
}

/** How long segments are and how much text one request may carry. */
export interface SegmentRule {
  /** Estimated spoken length, in milliseconds, at which a segment closes at the next sentence end. */
  readonly targetMs: number
  /** Longest segment in UTF-16 code units. */
  readonly maxCharacters: number
}

interface Unit extends TextRange {
  readonly ms: number
  /** `strong` after a sentence end, `weak` after a clause mark or a space, `hard` for a cut inside a run. */
  readonly tail: 'strong' | 'weak' | 'hard'
  readonly readable: boolean
}

/** Ideographs, kana, Hangul syllables, and the CJK blocks around them: one such character is one spoken syllable. */
const IDEOGRAPHIC = /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\u{20000}-\u{3FFFF}]/u

/** A mark pauses unless it is an ASCII mark directly followed by an ASCII letter or digit, as in `3.14` or `a,b`. */
function pauses(mark: string, next: string | undefined): boolean {
  if (!STRONG_MARKS.includes(mark) && !WEAK_MARKS.includes(mark)) return false
  return mark === '\n' || mark.charCodeAt(0) > 0x7F || next === undefined || !/[A-Za-z0-9]/.test(next)
}

function weight(char: string, next: string | undefined): number {
  if (READABLE.test(char)) return IDEOGRAPHIC.test(char) || /\p{N}/u.test(char) ? 200 : 70
  if (char === '、' || char === '：') return 150
  if (!pauses(char, next)) return 0
  return STRONG_MARKS.includes(char) ? 300 : 150
}

/**
 * Estimate how long a voice takes to read a text: 200 ms for an ideograph, kana, Hangul syllable or digit, 70 ms for
 * any other letter, 300 ms for a sentence end, and 150 ms for a clause mark.
 * @param text - read-aloud text.
 * @returns estimated milliseconds.
 */
export function speechEstimateMs(text: string): number {
  const chars = Array.from(text)
  return chars.reduce((total, char, index) => total + weight(char, chars[index + 1]), 0)
}

/** Ranges that each end right after a pausing mark, or at the end of the text. */
function clauses(text: string): TextRange[] {
  const out: TextRange[] = []
  const chars = Array.from(text)
  let start = 0, offset = 0
  for (const [index, char] of chars.entries()) {
    offset += char.length
    if (!pauses(char, chars[index + 1])) continue
    out.push({ start, end: offset })
    start = offset
  }
  if (start < text.length) out.push({ start, end: text.length })
  return out
}

/** Cut a clause longer than `cap` after its last space inside each window, or at the window end when it has none. */
function capped(text: string, clause: TextRange, cap: number): TextRange[] {
  const out: TextRange[] = []
  let start = clause.start
  while (clause.end - start > cap) {
    let end = start + cap
    const space = text.lastIndexOf(' ', end - 1)
    if (space > start) end = space + 1
    // A cut between the halves of a surrogate pair moves before the pair.
    else if (end - 1 > start && (text.charCodeAt(end) & 0xFC00) === 0xDC00) end -= 1
    out.push({ start, end })
    start = end
  }
  out.push({ start, end: clause.end })
  return out
}

function unit(text: string, range: TextRange): Unit {
  const slice = text.slice(range.start, range.end), last = slice.slice(-1)
  const tail = STRONG_MARKS.includes(last) ? 'strong' : WEAK_MARKS.includes(last) || last === ' ' ? 'weak' : 'hard'
  return { ...range, ms: speechEstimateMs(slice), tail, readable: READABLE.test(slice) }
}

/**
 * Split read-aloud text into the segments that are synthesized one request each. A segment closes at a sentence end
 * once its estimate reaches the target, at a clause mark or space from 1.5 times the target, and anywhere from twice
 * the target. A remainder estimated at half the target or less stays in the segment before it. Every segment starts at
 * a letter or digit's unit and holds at most `maxCharacters` code units; text without a letter or digit before, between
 * or after segments is in no segment.
 * @param text - read-aloud text.
 * @param rule - target length and the provider's text limit.
 * @returns ranges in reading order; empty when the text holds no letter or digit.
 */
export function segmentSpeech(text: string, rule: SegmentRule): TextRange[] {
  const cap = Math.min(UNIT_CAP, rule.maxCharacters)
  const units = clauses(text).flatMap(clause => capped(text, clause, cap)).map(range => unit(text, range))
  const total = units.reduce((sum, piece) => sum + piece.ms, 0)
  // readableAfter[i]: whether a unit after i holds a letter or digit.
  let later = false
  const readableAfter = units.toReversed().map((piece) => {
    const after = later
    later ||= piece.readable
    return after
  }).reverse()
  const segments: TextRange[] = []
  let start = 0, end = 0, ms = 0, spent = 0, readable = false
  for (const [index, piece] of units.entries()) {
    spent += piece.ms
    if (!readable && !piece.readable) { start = piece.end; continue }
    readable = true
    ms += piece.ms
    if (piece.readable) end = piece.end
    const next = units[index + 1]
    // The last segment ends at the last readable unit, so a segment closes only while readable text follows it.
    if (next === undefined || !readableAfter[index]) continue
    const full = next.end - start > rule.maxCharacters
    const due = ms >= rule.targetMs && total - spent > rule.targetMs / 2
      && (piece.tail === 'strong' || ms >= rule.targetMs * (piece.tail === 'weak' ? 1.5 : 2))
    if (!full && !due) continue
    segments.push({ start, end: piece.end })
    start = piece.end; ms = 0; readable = false
  }
  if (readable) segments.push({ start, end })
  return segments
}
