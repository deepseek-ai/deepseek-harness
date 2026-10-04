/**
 * Lazily scanned view of one JSON object's top-level fields, built from text
 * that may still be streaming or from an already parsed object. Nothing is
 * scanned until a reader asks; the view remembers every question it answered
 * and reports changed answers when the owner refreshes for publication.
 * Used for model tool-call arguments: a row reads the fields it
 * cares about at whatever granularity it displays, at every stage of the call.
 * @module @deepseek-ai/dsh-util-values/src/partial-json
 */
import { assertNever, type JsonValue } from './index.ts'

/** Granularity of a length read; a change is reported only when the rounded-up step moves. */
export interface LengthReadOptions {
  /** Characters per step; defaults to 1 (every character counts). */
  readonly step?: number
  /** Completed characters included in the displayed total; affects change detection only. */
  readonly offset?: number
}

/** Scanner position inside the object text. */
type Mode =
  | 'root' | 'key-or-end' | 'key-only' | 'key' | 'colon' | 'value'
  | 'string' | 'scalar' | 'nested' | 'comma-or-end' | 'closed' | 'invalid'

/** A content reader advances independently of the boundary scanner. */
interface StringRead {
  at: number
  length: number
  text: string
}

/** Raw ranges exclude string quotes and include a non-string value's own brackets. */
type Entry =
  | {
    readonly kind: 'string'
    readonly start: number
    end: number
    needsDecoding: boolean
    invalidAt: number | undefined
    length: StringRead | undefined
    text: StringRead | undefined
    prefixes: Map<number, StringRead> | undefined
  }
  | { readonly kind: 'value'; readonly start: number; end: number; parsed: JsonValue | undefined; invalid: boolean }

type ReadKind = 'closed' | 'keys' | 'has' | 'complete' | 'text' | 'value'
  | `length:${number}:${number}` | `prefix:${number}` | `exceeds:${number}`

/** One answered question, kept to detect whether later text changes the answer. */
interface Read {
  readonly completion: boolean
  readonly answer: () => unknown
  last: unknown
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
}

const CONTENT_ESCAPE = /[\\\u0000-\u001f]/u

function isWhitespace(c: string): boolean {
  return c === ' ' || c === '\n' || c === '\r' || c === '\t'
}

function isHex(c: string): boolean {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

/**
 * The view. A streaming instance grows through {@link PartialArguments.append};
 * {@link PartialArguments.fromText} and {@link PartialArguments.fromObject} build
 * sealed instances over a finished call. Every reader is total: an absent or
 * differently typed field answers `undefined` (or `false`), never throws.
 */
export class PartialArguments {
  /** The view of a call with no arguments available. */
  static readonly EMPTY: PartialArguments = PartialArguments.fromObject({})

  /**
   * View finished argument text without scanning it until a reader asks.
   * @param text - the complete argument JSON text.
   * @returns a sealed view.
   */
  static fromText(text: string): PartialArguments {
    const view = new PartialArguments()
    view.append(text)
    view.sealed = true
    return view
  }

  /**
   * View an already parsed argument payload, such as a PTC dispatch object.
   * @param value - the parsed argument value.
   * @returns a sealed view; a non-object payload has no fields.
   */
  static fromObject(value: unknown): PartialArguments {
    const view = new PartialArguments()
    view.object = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Readonly<Record<string, JsonValue>>
      : {}
    view.sealed = true
    return view
  }

  /**
   * The source: text so far or a parsed object, plus whether it can still grow.
   * These are the only enumerable fields, so two views over the same source
   * compare equal structurally however far each has been read.
   */
  private chunks: string[] = []
  private object: Readonly<Record<string, JsonValue>> | undefined
  private sealed = false
  // Scan progress, located fields, and remembered reads are caches over the source.
  #ends: number[] = []
  #size = 0
  #consumed = 0
  #mode: Mode = 'root'
  #escape = false
  #keyStart = 0
  #keyEscaped = false
  #key = ''
  #current: Entry | null = null
  #nestedEnds: string[] = []
  #nestedInString = false
  #invalidAt: number | undefined
  #invalidValue = false
  readonly #entries = new Map<string, Entry>()
  readonly #order: string[] = []
  readonly #reads = new Map<string, Read>()

  /** Whether this view rejects further appends; does not scan text or register reads. */
  get isSealed(): boolean {
    return this.sealed
  }

  /** Whether indexing or a content read found invalid JSON; unread value contents are not validated. */
  get invalid(): boolean {
    this.scan()
    return this.#mode === 'invalid' || this.#invalidValue
  }

  /**
   * Retain streamed argument text without scanning or comparing observed answers.
   * @param fragment - the text following every fragment appended before.
   */
  append(fragment: string): void {
    if (this.sealed) throw new Error('PartialArguments: cannot append to a sealed view')
    if (fragment.length === 0) return
    this.chunks.push(fragment)
    this.#size += fragment.length
    this.#ends.push(this.#size)
  }

  /**
   * Reconcile a streamed prefix with authoritative complete text without joining the fragments.
   * @param text - the final argument text, which replaces missing or conflicting deltas.
   * @returns this view sealed with its caches retained when every character matches; otherwise a new sealed view.
   */
  settle(text: string): PartialArguments {
    if (this.object !== undefined || text.length !== this.#size) return PartialArguments.fromText(text)
    let offset = 0
    for (const chunk of this.chunks) {
      if (!text.startsWith(chunk, offset)) return PartialArguments.fromText(text)
      offset += chunk.length
    }
    this.chunks = text.length === 0 ? [] : [text]
    this.#ends = text.length === 0 ? [] : [text.length]
    this.sealed = true
    return this
  }

  /**
   * Compare observed answers and advance their publication baseline. Unread views remain unscanned.
   * @returns whether any observed answer changed since its first read or the preceding refresh.
   */
  refresh(): boolean {
    if (this.#reads.size === 0) return false
    this.scan()
    let changed = false
    let completions = false
    for (const read of this.#reads.values()) {
      if (read.completion) {
        completions = true
        continue
      }
      changed = this.refreshRead(read) || changed
    }
    // Content reads can discover errors that change a field's completion answer.
    if (completions) {
      for (const read of this.#reads.values()) if (read.completion) changed = this.refreshRead(read) || changed
    }
    if (this.sealed) this.#reads.clear()
    return changed
  }

  private refreshRead(read: Read): boolean {
    const now = read.answer()
    if (Object.is(now, read.last)) return false
    read.last = now
    return true
  }

  /**
   * Check whether no further fields can arrive.
   * @returns whether the outer object closed, indexing failed, or the view is sealed; unread values are not validated.
   */
  closed(): boolean {
    return this.remember('closed', '', () => this.closedNow())
  }

  /**
   * List discovered fields in first-appearance order.
   * @returns top-level keys seen so far, in first-appearance order.
   */
  keys(): readonly string[] {
    return this.remember('keys', '', () => this.keysNow(), keys => keys.length)
  }

  /**
   * Check whether a top-level field has appeared.
   * @param key - argument name.
   * @returns whether the field has appeared (a string opened or another value began).
   */
  has(key: string): boolean {
    return this.remember('has', key, () => this.hasNow(key))
  }

  /**
   * Check whether a field's closing delimiter has arrived, without validating its contents.
   * @param key - argument name.
   * @returns whether its delimiter arrived and no content reader has reported an error for this value.
   */
  complete(key: string): boolean {
    return this.remember('complete', key, () => this.completeNow(key))
  }

  /**
   * Read string length without materializing its text.
   * @param key - argument name.
   * @param options - change granularity for a streaming string.
   * @returns decoded UTF-16 length of the string field so far; undefined when absent or not a string.
   */
  stringLength(key: string, options?: LengthReadOptions): number | undefined {
    const step = Math.max(1, Math.floor(options?.step ?? 1))
    const offset = options?.offset ?? 0
    return this.remember(`length:${step}:${offset}`, key, () => this.lengthNow(key),
      length => length === undefined ? undefined : Math.ceil((length + offset) / step))
  }

  /**
   * Check a string against a decoded UTF-16 length limit without materializing it.
   * @param key - argument name.
   * @param maxLength - decoded UTF-16 limit, floored to at least zero.
   * @returns whether the string is longer than the limit; false when absent or not a string.
   */
  stringExceeds(key: string, maxLength: number): boolean {
    const limit = Math.max(0, Math.floor(maxLength))
    return this.remember(`exceeds:${limit}`, key,
      () => (this.lengthNow(key, limit + 1) ?? 0) > limit)
  }

  /**
   * Read a decoded string, including a streaming prefix.
   * @param key - argument name.
   * @returns the string field's decoded text so far; undefined when absent or not a string.
   */
  text(key: string): string | undefined {
    return this.remember('text', key, () => this.textNow(key))
  }

  /**
   * Read at most the first decoded UTF-16 units of a string.
   * @param key - argument name.
   * @param maxLength - maximum decoded UTF-16 length, floored to at least one.
   * @returns the bounded string prefix; undefined when absent or not a string.
   */
  textPrefix(key: string, maxLength: number): string | undefined {
    const limit = Math.max(1, Math.floor(maxLength))
    return this.remember(`prefix:${limit}`, key,
      () => this.textPrefixNow(key, limit))
  }

  /**
   * Read a completed non-string argument.
   * @param key - argument name.
   * @returns the parsed non-string value once it closed; undefined while open, absent, or a string.
   */
  value(key: string): JsonValue | undefined {
    return this.remember('value', key, () => this.valueNow(key))
  }

  /** Answer a question and, on a streaming view, remember it for change detection. */
  private remember<T>(
    kind: ReadKind,
    key: string,
    read: () => T,
    comparison?: (value: T) => unknown,
  ): T {
    this.scan()
    const result = read()
    if (!this.sealed) {
      const id = `${kind}/${key}`
      if (!this.#reads.has(id)) {
        this.#reads.set(id, {
          completion: kind === 'complete',
          answer: comparison === undefined ? read : () => comparison(read()),
          last: comparison === undefined ? result : comparison(result),
        })
      }
    }
    return result
  }

  private closedNow(): boolean {
    return this.sealed || this.#mode === 'closed' || this.#mode === 'invalid'
  }

  private keysNow(): readonly string[] {
    return this.object === undefined ? this.#order : Object.keys(this.object)
  }

  private hasNow(key: string): boolean {
    return this.object === undefined ? this.#entries.has(key) : Object.hasOwn(this.object, key)
  }

  private completeNow(key: string): boolean {
    if (this.object !== undefined) return Object.hasOwn(this.object, key)
    const entry = this.#entries.get(key)
    return entry !== undefined && entry.end >= 0
      && (entry.kind === 'string' ? entry.invalidAt === undefined : !entry.invalid)
  }

  private lengthNow(key: string, limit = Number.POSITIVE_INFINITY): number | undefined {
    if (this.object !== undefined) {
      const field = Object.hasOwn(this.object, key) ? this.object[key] : undefined
      return typeof field === 'string' ? field.length : undefined
    }
    const entry = this.#entries.get(key)
    if (entry?.kind !== 'string') return undefined
    if (entry.text !== undefined && entry.text.at === entry.end) return entry.text.length
    const read = entry.length ??= { at: entry.start, length: 0, text: '' }
    this.readString(entry, read, limit, false)
    return read.length
  }

  private textNow(key: string): string | undefined {
    if (this.object !== undefined) {
      const field = Object.hasOwn(this.object, key) ? this.object[key] : undefined
      return typeof field === 'string' ? field : undefined
    }
    const entry = this.#entries.get(key)
    if (entry?.kind !== 'string') return undefined
    if (entry.text === undefined && entry.end >= 0 && entry.needsDecoding && entry.invalidAt === undefined) {
      let text: string | undefined
      try {
        text = JSON.parse(`"${this.slice(entry.start, entry.end)}"`) as string
      } catch (_error) {
        // The incremental reader retains the valid prefix when complete text contains an invalid escape.
      }
      if (text !== undefined) entry.text = { at: entry.end, length: text.length, text }
    }
    const read = entry.text ??= { at: entry.start, length: 0, text: '' }
    this.readString(entry, read, Number.POSITIVE_INFINITY, true)
    return read.text
  }

  private textPrefixNow(key: string, maxLength: number): string | undefined {
    if (this.object !== undefined) {
      const field = Object.hasOwn(this.object, key) ? this.object[key] : undefined
      return typeof field === 'string' ? field.slice(0, maxLength) : undefined
    }
    const entry = this.#entries.get(key)
    if (entry?.kind !== 'string') return undefined
    const prefixes = entry.prefixes ??= new Map<number, StringRead>()
    let read = prefixes.get(maxLength)
    if (read === undefined) {
      read = { at: entry.start, length: 0, text: '' }
      prefixes.set(maxLength, read)
    }
    this.readString(entry, read, maxLength, true)
    return read.text
  }

  private valueNow(key: string): JsonValue | undefined {
    if (this.object !== undefined) {
      if (!Object.hasOwn(this.object, key)) return undefined
      const field = this.object[key]
      return typeof field === 'string' ? undefined : field
    }
    const entry = this.#entries.get(key)
    if (entry?.kind !== 'value' || entry.end < 0 || entry.invalid) return undefined
    if (entry.parsed === undefined) {
      try {
        entry.parsed = JSON.parse(this.slice(entry.start, entry.end)) as JsonValue
      } catch (_error) {
        // Unread values retain only their ranges; a requested malformed value has no parsed result.
        entry.invalid = true
        this.#invalidValue = true
      }
    }
    return entry.parsed
  }

  private chunkAt(at: number): number {
    let low = 0
    let high = this.#ends.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if ((this.#ends[mid] as number) <= at) low = mid + 1
      else high = mid
    }
    return low
  }

  /** Materialize only a requested range, never the cumulative source. */
  private slice(start: number, end: number): string {
    if (start >= end) return ''
    const first = this.chunkAt(start)
    const last = this.chunkAt(end - 1)
    const base = first === 0 ? 0 : this.#ends[first - 1] as number
    if (first === last) return (this.chunks[first] as string).slice(start - base, end - base)
    const parts = [(this.chunks[first] as string).slice(start - base)]
    for (let i = first + 1; i < last; i++) parts.push(this.chunks[i] as string)
    parts.push((this.chunks[last] as string).slice(0, end - (this.#ends[last - 1] as number)))
    return parts.join('')
  }

  private readString(
    entry: Extract<Entry, { kind: 'string' }>,
    read: StringRead,
    limit: number,
    materialize: boolean,
  ): void {
    const end = Math.min(entry.end < 0 ? this.#consumed : entry.end,
      entry.invalidAt ?? Number.POSITIVE_INFINITY, this.#invalidAt ?? Number.POSITIVE_INFINITY)
    if (!entry.needsDecoding) {
      const length = Math.min(end - read.at, limit - read.length)
      if (length <= 0) return
      if (materialize) read.text += this.slice(read.at, read.at + length)
      read.at += length
      read.length += length
      return
    }
    let chunkIndex = this.chunkAt(read.at)
    while (read.at < end && read.length < limit) {
      const base = chunkIndex === 0 ? 0 : this.#ends[chunkIndex - 1] as number
      const chunk = this.chunks[chunkIndex] as string
      const remaining = chunk.slice(read.at - base, Math.min(chunk.length, end - base))
      const boundary = remaining.search(CONTENT_ESCAPE)
      const length = Math.min(boundary < 0 ? remaining.length : boundary, limit - read.length)
      if (length > 0) {
        if (materialize) read.text += remaining.slice(0, length)
        read.at += length
        read.length += length
        if (read.at === base + chunk.length) chunkIndex++
        continue
      }
      const type = remaining.length > 1 ? remaining[1]
        : read.at + 1 < end ? (this.chunks[chunkIndex + 1] as string)[0] : undefined
      let decoded: string | undefined
      let width = 2
      if (remaining[0] === '\\' && type === undefined && entry.end < 0) return
      if (remaining[0] === '\\' && type === 'u') {
        const hex = this.slice(read.at + 2, Math.min(end, read.at + 6))
        let valid = true
        for (let i = 0; i < hex.length; i++) if (!isHex(hex[i] as string)) valid = false
        if (valid) {
          if (hex.length < 4 && entry.end < 0) return
          if (hex.length === 4) decoded = String.fromCharCode(Number.parseInt(hex, 16))
        }
        width = 6
      } else if (remaining[0] === '\\' && type !== undefined) {
        decoded = SIMPLE_ESCAPES[type]
      }
      if (decoded === undefined) {
        entry.invalidAt = read.at
        this.#invalidValue = true
        return
      }
      if (materialize) read.text += decoded
      read.length++
      read.at += width
      while (chunkIndex < this.chunks.length && read.at >= (this.#ends[chunkIndex] as number)) chunkIndex++
    }
  }

  /** Locate new field ranges without decoding or parsing their contents. */
  private scan(): void {
    if (this.object !== undefined || this.#consumed === this.#size) return
    for (let i = this.chunkAt(this.#consumed); i < this.chunks.length && this.#invalidAt === undefined; i++) {
      const pending = this.chunks[i] as string
      const base = i === 0 ? 0 : this.#ends[i - 1] as number
      for (let index = this.#consumed - base; index < pending.length && this.#mode !== 'invalid'; index++) {
        if (this.#mode === 'string' || (this.#mode === 'nested' && this.#nestedInString)) {
          const end = this.stringBoundary(pending, index)
          this.#consumed += end - index
          index = end
          if (index === pending.length) break
        }
        this.step(pending[index] as string, this.#consumed)
        this.#consumed++
      }
    }
  }

  /** Only raw quotes and their preceding backslash runs can terminate a string. */
  private stringBoundary(fragment: string, start: number): number {
    let at = start
    while (true) {
      const quote = fragment.indexOf('"', at)
      const end = quote < 0 ? fragment.length : quote
      if (this.#mode === 'string') {
        const entry = this.#current as Extract<Entry, { kind: 'string' }>
        if (!entry.needsDecoding && CONTENT_ESCAPE.test(fragment.slice(at, end))) entry.needsDecoding = true
      }
      let slashStart = end
      while (slashStart > at && fragment[slashStart - 1] === '\\') slashStart--
      const escaped = ((end - slashStart) % 2 === 1) !== (slashStart === at && this.#escape)
      this.#escape = quote < 0 && escaped
      if (quote < 0 || !escaped) return end
      at = quote + 1
    }
  }

  private step(c: string, at: number): void {
    switch (this.#mode) {
      case 'root':
        if (isWhitespace(c)) return
        if (c === '{') { this.#mode = 'key-or-end'; return }
        this.fail(); return
      case 'key-or-end':
        if (isWhitespace(c)) return
        if (c === '}') { this.#mode = 'closed'; return }
        if (c === '"') { this.beginKey(at); return }
        this.fail(); return
      case 'key-only':
        if (isWhitespace(c)) return
        if (c === '"') { this.beginKey(at); return }
        this.fail(); return
      case 'key':
        this.stepKey(c, at); return
      case 'colon':
        if (isWhitespace(c)) return
        if (c === ':') { this.#mode = 'value'; return }
        this.fail(); return
      case 'value':
        this.beginValue(c, at); return
      case 'string': {
        const entry = this.#current as Extract<Entry, { kind: 'string' }>
        entry.end = at
        this.#current = null
        this.#mode = 'comma-or-end'
        return
      }
      case 'scalar':
        this.stepScalar(c, at); return
      case 'nested':
        this.stepNested(c, at); return
      case 'comma-or-end':
        if (isWhitespace(c)) return
        if (c === ',') { this.#mode = 'key-only'; return }
        if (c === '}') { this.#mode = 'closed'; return }
        this.fail(); return
      case 'closed':
        if (isWhitespace(c)) return
        this.fail(); return
      /* v8 ignore next 2 -- scan() stops stepping once the view is invalid. */
      case 'invalid':
        return
      /* v8 ignore next 2 -- Every scanner mode has a handler above. */
      default:
        assertNever(this.#mode)
    }
  }

  private fail(): void {
    this.#invalidAt = this.#consumed
    this.#mode = 'invalid'
    this.#current = null
  }

  private beginKey(at: number): void {
    this.#mode = 'key'
    this.#keyStart = at + 1
    this.#keyEscaped = false
    this.#escape = false
  }

  private stepKey(c: string, at: number): void {
    if (c < ' ') { this.fail(); return }
    if (this.#escape) { this.#escape = false; return }
    if (c === '\\') { this.#escape = true; this.#keyEscaped = true; return }
    if (c !== '"') return
    const raw = this.slice(this.#keyStart, at)
    if (this.#keyEscaped) {
      try {
        this.#key = JSON.parse(`"${raw}"`) as string
      } catch (_error) {
        // Invalid key escapes prevent identifying subsequent fields.
        this.fail()
        return
      }
    } else {
      this.#key = raw
    }
    this.#mode = 'colon'
  }

  private open(entry: Entry): void {
    if (!this.#entries.has(this.#key)) this.#order.push(this.#key)
    this.#entries.set(this.#key, entry)
    this.#current = entry
  }

  private beginValue(c: string, at: number): void {
    if (isWhitespace(c)) return
    if (c === '"') {
      this.open({
        kind: 'string', start: at + 1, end: -1, needsDecoding: false, invalidAt: undefined,
        length: undefined, text: undefined, prefixes: undefined,
      })
      this.#escape = false
      this.#mode = 'string'
      return
    }
    if (c === '}' || c === ',' || c === ':' || c === ']') { this.fail(); return }
    this.open({ kind: 'value', start: at, end: -1, parsed: undefined, invalid: false })
    if (c === '{' || c === '[') {
      this.#mode = 'nested'
      this.#nestedEnds = [c === '{' ? '}' : ']']
      this.#nestedInString = false
      this.#escape = false
      return
    }
    this.#mode = 'scalar'
  }

  private stepScalar(c: string, at: number): void {
    if (c !== ',' && c !== '}' && !isWhitespace(c)) return
    this.closeValue(at)
    this.#mode = c === ',' ? 'key-only' : c === '}' ? 'closed' : 'comma-or-end'
  }

  private stepNested(c: string, at: number): void {
    if (this.#nestedInString) {
      this.#nestedInString = false
      return
    }
    if (c === '"') { this.#nestedInString = true; return }
    if (c === '{' || c === '[') { this.#nestedEnds.push(c === '{' ? '}' : ']'); return }
    if (c === '}' || c === ']') {
      if (this.#nestedEnds.pop() !== c) { this.fail(); return }
      if (this.#nestedEnds.length === 0) {
        this.closeValue(at + 1)
        this.#mode = 'comma-or-end'
      }
    }
  }

  private closeValue(end: number): void {
    const entry = this.#current as Extract<Entry, { kind: 'value' }>
    entry.end = end
    this.#current = null
  }
}
