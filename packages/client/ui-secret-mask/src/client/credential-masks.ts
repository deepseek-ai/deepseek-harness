/**
 * Display forms of credential ranges. Every mark comes from a slice of a shared
 * string, so a one-line mask is one slice and a multi-line mask one slice per line.
 */
import { ADDRESS, PREFIXED } from './credential-formats.ts'

/** Character that replaces each hidden credential character in `masked`. */
export const MASK = '*'
/** Leading characters of a prefixed key left readable: the provider prefix and little else. */
const VISIBLE_PREFIX = 8
const SHARED_MARKS = 4096

/** Builds masks; owns the shared mark strings and its sticky run pattern. */
export class CredentialMasks {
  private readonly marksOnly = MASK.repeat(SHARED_MARKS)
  private readonly marksLf = `${this.marksOnly}\n`
  private readonly marksCr = `${this.marksOnly}\r`
  /** Code units that `lines` counts without inspection: neither line breaks nor surrogates. Set `lastIndex` before each test. */
  private readonly ordinary = /[^\r\n\ud800-\udfff]*/y

  /**
   * The display form of `text[start, end)`, whose earliest candidate has `kind`.
   * @param text - the queried text.
   * @param kind - the literal kind of the range's earliest candidate.
   * @param plain - the range holds only prefixed-format characters: ASCII without line breaks.
   * @param start - first offset of the range.
   * @param end - offset after the range.
   * @returns the mask; line breaks stay in place, one mark per code point.
   */
  masked(text: string, kind: number, plain: boolean, start: number, end: number): string {
    if (kind === ADDRESS) return this.range(text, start, end)
    if (kind === PREFIXED) {
      const prefix = text.slice(start, start + VISIBLE_PREFIX)
      return prefix + (plain ? this.marks(end - start - VISIBLE_PREFIX) : this.range(text, start + VISIBLE_PREFIX, end))
    }
    return this.keyBlock(text, start, end)
  }

  /** `count` marks: up to the shared string's length, one slice of it. */
  private marks(count: number): string {
    return count <= SHARED_MARKS ? this.marksOnly.slice(0, count) : MASK.repeat(count)
  }

  /** `count` marks and then the line break `code`, 10 or 13: one slice where `marks` would be one. */
  private marksThen(count: number, code: number): string {
    return count <= SHARED_MARKS
      ? (code === 10 ? this.marksLf : this.marksCr).slice(SHARED_MARKS - count)
      : MASK.repeat(count) + (code === 10 ? '\n' : '\r')
  }

  /**
   * Keep the `BEGIN` line, the `END` line when present, and every line break; a block written on
   * one line is masked whole. Both searches stay inside the range, so they cost what the mask costs.
   */
  private keyBlock(text: string, start: number, end: number): string {
    let bodyStart = start
    for (let index = start; index < end; index++) {
      if (text.charCodeAt(index) === 10) {
        bodyStart = index + 1
        break
      }
    }
    let bodyEnd = end
    for (let index = end - '\n-----END'.length; index >= bodyStart; index--) {
      if (text.charCodeAt(index) === 10 && text.startsWith('-----END', index + 1)) {
        bodyEnd = index
        break
      }
    }
    // Native runs stop at a line break or the end of the text, so they stay inside a body that ends at one.
    const bounded = bodyEnd === text.length || text.charCodeAt(bodyEnd) === 10 || text.charCodeAt(bodyEnd) === 13
    const body = bounded ? this.lines(text, bodyStart, bodyEnd) : this.range(text, bodyStart, bodyEnd)
    return text.slice(start, bodyStart) + body + text.slice(bodyEnd, end)
  }

  /**
   * `text[start, end)` with every character except line breaks replaced; a surrogate pair is one
   * character, as `[^\r\n]` with the `u` flag counts it. A character loop: a native run could read far past `end`.
   */
  private range(text: string, start: number, end: number): string {
    let masked = ''
    let count = 0
    for (let index = start; index < end; index++) {
      const code = text.charCodeAt(index)
      if (code === 10 || code === 13) {
        masked += this.marksThen(count, code)
        count = 0
        continue
      }
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < end) {
        const next = text.charCodeAt(index + 1)
        if (next >= 0xdc00 && next <= 0xdfff) index++
      }
      count++
    }
    return masked + this.marks(count)
  }

  /** `range` for a body that ends at a line break or the end of the text, where native runs stop. */
  private lines(text: string, start: number, end: number): string {
    const ordinary = this.ordinary
    let masked = ''
    let count = 0
    let index = start
    while (index < end) {
      ordinary.lastIndex = index
      ordinary.test(text)
      const stop = Math.min(ordinary.lastIndex, end)
      count += stop - index
      if (stop === end) break
      const code = text.charCodeAt(stop)
      index = stop + 1
      if (code === 10 || code === 13) {
        masked += this.marksThen(count, code)
        count = 0
        continue
      }
      // A high surrogate followed by a low one is one character.
      if (code <= 0xdbff && index < end) {
        const next = text.charCodeAt(index)
        if (next >= 0xdc00 && next <= 0xdfff) index++
      }
      count++
    }
    return masked + this.marks(count)
  }
}
