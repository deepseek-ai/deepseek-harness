/**
 * Prefix-pruned, linear credential scanning that allocates nothing until it
 * returns a node. A literal-only alternation finds each place a format can
 * begin and resumes inside a literal that can overlap the next one. Format
 * checks are bounded character comparisons and sticky `[class]*` runs, which
 * end at the first character outside the class and leave nothing to backtrack
 * into. Run ends, the next digit, and the next key-block `END` line are
 * memoized per text across queries, so each is measured once per text.
 */
import type { UserTextNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  ADDRESS, ALNUM, ALNUM_DASH, BOUNDED, GOOGLE, KEY_BLOCK, LABEL, LOWER, PREFIXED, RUN, SCHEME, SK, UPPER_ALNUM, USER, WORD,
} from './credential-formats.ts'
import { CredentialMasks } from './credential-masks.ts'
import type { FormatTables } from './format-tables.ts'

// Memo layout: [start, end] pairs. A lookup at `offset` hits when start <= offset <= end; -1 pairs hold nothing.
const KEY_SLOTS = 0 // four pairs: a JSON Web Token measures three runs
const KEY_NEXT = 8
const ALNUM_SLOT = 9
const WORD_SLOT = 11
const ALNUM_DASH_SLOT = 13
const UPPER_ALNUM_SLOT = 15
const USER_SLOT = 17
const PASSWORD_SLOT = 19
const DIGIT_FROM = 21
const DIGIT_AT = 22
const BLOCK_FROM = 23
const BLOCK_END_START = 24
const BLOCK_END = 25
/** Start of the password that the last address check accepted. */
const CANDIDATE_START = 26
const MEMO_SIZE = 27

/** `\s` above ASCII. */
function isWideSpace(code: number): boolean {
  return code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029
    || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff
}

/** Offset after the run that sticky `pattern` matches at `start`. */
function runEnd(pattern: RegExp, text: string, start: number): number {
  pattern.lastIndex = start
  pattern.test(text)
  return pattern.lastIndex
}

/**
 * One matcher's scanning state: the tables, its own patterns, and a memo of the
 * last queried text, which it keeps until a query for another text. Queries are
 * synchronous and never re-enter, so the patterns' cursors are never shared.
 */
export class CredentialScanner {
  private readonly classes: Uint16Array
  private readonly literals: readonly string[]
  private readonly literalLength: Uint8Array
  private readonly literalKind: Uint8Array
  private readonly literalShape: Uint8Array
  private readonly literalMin: Int32Array
  private readonly literalMax: Int32Array
  private readonly literalOverlap: Uint8Array
  private readonly ending: Int8Array
  private readonly sharedEndings: readonly (readonly number[] | undefined)[]
  /** Memo slot of each prefixed format's run class; 0 for `[A-Za-z0-9_-]`, which has four. */
  private readonly literalSlot: Uint8Array
  private readonly literalPattern: readonly RegExp[]
  private readonly prefixes: RegExp
  // Sticky run patterns: nothing follows the starred class, so nothing backtracks, and `test` allocates nothing.
  private readonly keyRun = /[A-Za-z0-9_-]*/y
  private readonly userRun = /[^\s/:@?#]*/y
  private readonly passwordRun = /[^\s/@?#]*/y
  private readonly nonDigits = /\D*/y
  private readonly masks = new CredentialMasks()
  private readonly memo = new Int32Array(MEMO_SIZE).fill(-1)
  private text = ''

  constructor(tables: FormatTables) {
    this.classes = tables.classes
    this.literals = tables.literals
    this.literalLength = tables.literalLength
    this.literalKind = tables.literalKind
    this.literalShape = tables.literalShape
    this.literalMin = tables.literalMin
    this.literalMax = tables.literalMax
    this.literalOverlap = tables.literalOverlap
    this.ending = tables.ending
    this.sharedEndings = tables.sharedEndings
    this.prefixes = new RegExp(tables.prefixSource, 'g')
    const patterns = new Map<number, readonly [slot: number, pattern: RegExp]>([
      [ALNUM, [ALNUM_SLOT, /[A-Za-z0-9]*/y]],
      [WORD, [WORD_SLOT, /\w*/y]],
      [ALNUM_DASH, [ALNUM_DASH_SLOT, /[A-Za-z0-9-]*/y]],
      [UPPER_ALNUM, [UPPER_ALNUM_SLOT, /[A-Z0-9]*/y]],
    ])
    this.literalSlot = Uint8Array.from(tables.literalRun, run => patterns.get(run)?.[0] ?? 0)
    this.literalPattern = Array.from(tables.literalRun, run => patterns.get(run)?.[1] ?? this.keyRun)
  }

  /**
   * The nearest credential at or after `from`. Overlapping candidates of any format join the earliest
   * one and take its mask, so no credential is drawn half masked. Candidates arrive in start order;
   * an address password waits until the scan passes its start, and no other `://` can occur before
   * then, because a user name and a password exclude `/`. A password that starts inside a range also
   * ends inside it: the range holds the `:` before the password, so it is a key block, whose `END`
   * line has spaces, or one that runs to the end of the text.
   * @param text - the complete original text.
   * @param from - the query offset.
   * @returns the `secret` node, or undefined when no credential starts at or after `from`.
   */
  match(text: string, from: number): UserTextNode<'secret'> | undefined {
    if (text !== this.text) {
      this.memo.fill(-1)
      this.text = text
    }
    const prefixes = this.prefixes
    const length = text.length
    let start = -1
    let end = -1
    let kind = PREFIXED
    let plain = true
    let deferredEnd = this.addressBefore(from)
    let deferredStart = deferredEnd < 0 ? -1 : this.slot(CANDIDATE_START)
    prefixes.lastIndex = from
    while (prefixes.test(text)) {
      const literalEnd = prefixes.lastIndex
      const literal = this.literalEndingAt(literalEnd)
      const at = literalEnd - (this.literalLength[literal] as number)
      prefixes.lastIndex = literalEnd - (this.literalOverlap[literal] as number)
      if (deferredStart >= 0 && deferredStart <= at) {
        if (start < 0) {
          start = deferredStart
          end = deferredEnd
          kind = ADDRESS
        } else if (deferredStart >= end) {
          break
        }
        deferredStart = -1
      }
      // A candidate starts at or after its literal, so none past the range reaches it; nothing extends a range to the end.
      if (start >= 0 && (at >= end || end === length)) break
      const literalKind = this.literalKind[literal] as number
      if (literalKind === ADDRESS) {
        deferredEnd = this.addressPassword(at)
        deferredStart = deferredEnd < 0 ? -1 : this.slot(CANDIDATE_START)
        continue
      }
      const candidateEnd = literalKind === KEY_BLOCK ? this.keyBlockEnd(at) : this.prefixedEnd(literal, at)
      if (candidateEnd < 0) continue
      if (start < 0) {
        start = at
        end = candidateEnd
        kind = literalKind
        plain = literalKind === PREFIXED
      } else if (candidateEnd > end) {
        end = candidateEnd
        if (literalKind !== PREFIXED) plain = false
      }
    }
    if (start < 0 && deferredStart >= 0) {
      start = deferredStart
      end = deferredEnd
      kind = ADDRESS
    }
    if (start < 0) return undefined
    return { id: 'secret', start, end, data: { masked: this.masks.masked(text, kind, plain, start, end) } }
  }

  /** Memo entry at `index`; the layout keeps every index inside the array. */
  private slot(index: number): number {
    return this.memo[index] as number
  }

  /** `\w` at `index`; out of range is not a word character. */
  private isWordAt(index: number): boolean {
    const code = this.text.charCodeAt(index)
    return code < 128 && ((this.classes[code] as number) & WORD) !== 0
  }

  /** `[^\s/:@?#]` for one UTF-16 code unit; NaN, read out of range, is not one. */
  private isUserCode(code: number): boolean {
    return code < 128 ? ((this.classes[code] as number) & USER) !== 0 : code === code && !isWideSpace(code)
  }

  /** Index of the literal the prefix scan matched ending at `end`; one literal sharing the ending matches, so the last needs no check. */
  private literalEndingAt(end: number): number {
    const text = this.text
    const key = text.charCodeAt(end - 2) * 128 + text.charCodeAt(end - 1)
    const literal = this.ending[key] as number
    if (literal > 0) return literal - 1
    const shared = this.sharedEndings[key] as readonly number[]
    let index = 0
    for (; index < shared.length - 1; index++) {
      const candidate = shared[index] as number
      if (text.startsWith(this.literals[candidate] as string, end - (this.literalLength[candidate] as number))) break
    }
    return shared[index] as number
  }

  /** End of the `[A-Za-z0-9_-]*` run at `start`, through four memo pairs replaced in turn. */
  private keyRunEnd(start: number): number {
    for (let slot = KEY_SLOTS; slot < KEY_NEXT; slot += 2) {
      if (this.slot(slot) <= start && start <= this.slot(slot + 1)) return this.slot(slot + 1)
    }
    const end = runEnd(this.keyRun, this.text, start)
    const next = (this.slot(KEY_NEXT) + 1) & 3
    this.memo[KEY_NEXT] = next
    this.memo[KEY_SLOTS + 2 * next] = start
    this.memo[KEY_SLOTS + 2 * next + 1] = end
    return end
  }

  /** End of the run `pattern` matches at `start`, through the memo pair at `slot`. */
  private memoRunEnd(pattern: RegExp, start: number, slot: number): number {
    if (this.slot(slot) <= start && start <= this.slot(slot + 1)) return this.slot(slot + 1)
    const end = runEnd(pattern, this.text, start)
    this.memo[slot] = start
    this.memo[slot + 1] = end
    return end
  }

  /** Offset of the first digit at or after `start`, or the text length. */
  private nextDigit(start: number): number {
    if (this.slot(DIGIT_FROM) <= start && start <= this.slot(DIGIT_AT)) return this.slot(DIGIT_AT)
    this.memo[DIGIT_FROM] = start
    this.memo[DIGIT_AT] = runEnd(this.nonDigits, this.text, start)
    return this.slot(DIGIT_AT)
  }

  /** Offset after `[A-Z0-9 ]{0,40}PRIVATE KEY-----` at `start`, or -1; reads at most 52 characters. */
  private labelEnd(start: number): number {
    const text = this.text
    const limit = Math.min(text.length, start + 52)
    let index = start
    while (index < limit) {
      const code = text.charCodeAt(index)
      if (code > 127 || ((this.classes[code] as number) & LABEL) === 0) break
      index++
    }
    // "PRIVATE KEY" is label characters and the `-` after it is not, so the run ends right after it.
    const tail = index - 'PRIVATE KEY'.length
    return index < start + 52 && tail >= start && text.startsWith('PRIVATE KEY-----', tail) ? tail + 'PRIVATE KEY-----'.length : -1
  }

  /**
   * End of the `-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----` block at `at`: after its first complete
   * `END` line, or the end of the text; -1 for an invalid header.
   */
  private keyBlockEnd(at: number): number {
    const header = this.labelEnd(at + '-----BEGIN '.length)
    if (header < 0) return -1
    if (this.slot(BLOCK_FROM) <= header && header <= this.slot(BLOCK_END_START)) return this.slot(BLOCK_END)
    const text = this.text
    this.memo[BLOCK_FROM] = header
    this.memo[BLOCK_END_START] = text.length
    this.memo[BLOCK_END] = text.length
    for (let line = text.indexOf('-----END ', header); line >= 0; line = text.indexOf('-----END ', line + 1)) {
      const end = this.labelEnd(line + '-----END '.length)
      if (end < 0) continue
      this.memo[BLOCK_END_START] = line
      this.memo[BLOCK_END] = end
      break
    }
    return this.slot(BLOCK_END)
  }

  /** Whether `\b[a-z][a-z0-9+.-]{1,15}` ends at `at`; reads at most 17 characters back. */
  private schemeBefore(at: number): boolean {
    const text = this.text
    for (let start = at - 1; start >= 0 && start >= at - 16; start--) {
      const code = text.charCodeAt(start)
      const bits = code < 128 ? (this.classes[code] as number) : 0
      if ((bits & SCHEME) === 0) return false
      if ((bits & LOWER) !== 0 && at - start >= 2 && !this.isWordAt(start - 1)) return true
    }
    return false
  }

  /**
   * The password in `\b[a-z][a-z0-9+.-]{1,15}://[^\s/:@?#]{0,256}:[^\s/@?#]+@` for the `://` at
   * `at`; neither part crosses `?` or `#`, where the authority ends. Callers pass a `://` at or after
   * the query offset, or one whose user name reaches it, so the password never starts before it.
   * @returns the password end with its start in the memo, or -1.
   */
  private addressPassword(at: number): number {
    if (!this.schemeBefore(at)) return -1
    const text = this.text
    const userStart = at + '://'.length
    const userEnd = this.memoRunEnd(this.userRun, userStart, USER_SLOT)
    if (userEnd - userStart > 256 || text.charCodeAt(userEnd) !== 58) return -1
    const start = userEnd + 1
    const end = this.memoRunEnd(this.passwordRun, start, PASSWORD_SLOT)
    if (end === start || text.charCodeAt(end) !== 64) return -1
    this.memo[CANDIDATE_START] = start
    return end
  }

  /**
   * The address password at or after `from` whose `://` starts before `from`, as `addressPassword`
   * returns it. The walk back over the user name runs only when a `:`, a password, and `@` follow.
   */
  private addressBefore(from: number): number {
    const text = this.text
    if (from < 3) return -1
    // `from` inside the `://`.
    if (text.startsWith('://', from - 1)) return this.addressPassword(from - 1)
    if (text.startsWith('://', from - 2)) return this.addressPassword(from - 2)
    let index = from - 1
    const before = text.charCodeAt(index)
    let passwordStart: number
    if (before === 58) {
      // The password starts at `from`, right after the user name's `:`.
      passwordStart = from
      index--
    } else if (this.isUserCode(before)) {
      const userEnd = this.memoRunEnd(this.userRun, from, USER_SLOT)
      if (text.charCodeAt(userEnd) !== 58) return -1
      passwordStart = userEnd + 1
    } else {
      return text.startsWith('://', from - 3) ? this.addressPassword(from - 3) : -1
    }
    const passwordEnd = this.memoRunEnd(this.passwordRun, passwordStart, PASSWORD_SLOT)
    if (passwordEnd === passwordStart || text.charCodeAt(passwordEnd) !== 64) return -1
    // A user name is at most 256 characters, followed by `:`.
    const lowest = Math.max(0, passwordStart - 258)
    while (index >= lowest && this.isUserCode(text.charCodeAt(index))) index--
    return index >= 2 && text.startsWith('://', index - 2) ? this.addressPassword(index - 2) : -1
  }

  /** End of the prefixed credential whose literal starts at `at`, or -1. */
  private prefixedEnd(literal: number, at: number): number {
    if (this.isWordAt(at - 1)) return -1
    const text = this.text
    const start = at + (this.literalLength[literal] as number)
    const shape = this.literalShape[literal] as number
    const min = this.literalMin[literal] as number
    if (shape === SK) {
      // `(?=[A-Za-z0-9_-]{0,255}\d)[A-Za-z0-9_-]{20,}`: the memoized next digit rejects a digit-free `sk-` before any run is measured.
      const digit = this.nextDigit(start)
      if (digit - start > 255) return -1
      const end = this.keyRunEnd(start)
      return end - start >= min && digit < end ? end : -1
    }
    const slot = this.literalSlot[literal] as number
    const end = slot === 0 ? this.keyRunEnd(start) : this.memoRunEnd(this.literalPattern[literal] as RegExp, start, slot)
    const length = end - start
    if (length < min) return -1
    if (shape === RUN) return end
    if (shape === GOOGLE) return start + min
    if (shape === BOUNDED) return length <= (this.literalMax[literal] as number) && !this.isWordAt(end) ? end : -1
    // `[A-Za-z0-9_-]{8,2048}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}` after `eyJ`.
    if (length > (this.literalMax[literal] as number) || !text.startsWith('.eyJ', end)) return -1
    const payloadStart = end + '.eyJ'.length
    const payloadEnd = this.keyRunEnd(payloadStart)
    if (payloadEnd - payloadStart < min || text.charCodeAt(payloadEnd) !== 46) return -1
    const signatureEnd = this.keyRunEnd(payloadEnd + 1)
    return signatureEnd - (payloadEnd + 1) >= min ? signatureEnd : -1
  }
}
