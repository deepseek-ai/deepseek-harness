/**
 * Incremental block-level markdown parsing for an append-only text stream.
 *
 * Re-parsing the whole accumulated document on every streaming chunk is
 * quadratic in the final reply length. CommonMark block parsing is line-based
 * and appended text can only reshape the parse frontier — the last top-level
 * block (a paragraph becoming a setext heading or a table, or a list
 * continuing after a blank line) — so earlier blocks are final. This parser
 * therefore freezes all but the trailing {@link UNSTABLE_TAIL_BLOCKS} blocks
 * and re-parses only the source tail behind them. A final unclosed top-level
 * fence cannot freeze as a block, so its completed content lines use a second
 * frontier: only the last completed line and current partial line return
 * through the caller's grammar. Each source region is therefore parsed a
 * bounded number of times over the stream instead of once per chunk.
 *
 * The block freeze boundary comes from the parser's own `position` offsets.
 * The cut sits at the *end offset* of the last frozen block (not the next
 * block's start): a following block's start offset excludes up to three spaces
 * of insignificant leading indentation, which is harmless to drop, but
 * cutting at the previous end also keeps the inter-block blank lines in the
 * tail so the sliced source stays verbatim. Fence scanning only recognizes a
 * parser-confirmed code node and closing delimiter; ambiguous input returns to
 * the normal tail parse.
 *
 * Known deviation, shared with any prefix-freeze scheme: micromark resolves
 * reference-style links and footnotes document-wide at parse time, so a
 * reference whose definition lands on the other side of the freeze boundary
 * renders literally until the settled full parse self-heals it.
 */

import type { Code, Root, RootContent } from 'mdast'

/**
 * Trailing blocks kept unstable. Appended text reshapes at most the last
 * block; the second-to-last is retained as safety margin so a freeze decision
 * never has to reason about the parse frontier.
 */
const UNSTABLE_TAIL_BLOCKS = 2

/** A top-level mdast block plus a render key that is stable across chunks. */
export interface PositionedBlock {
  /** The parsed block. Positions inside it are relative to its parse slice. */
  readonly node: RootContent
  /**
   * The block's start offset in the full source text. Stable from the frame
   * a block first appears through freezing, so React reconciles rather than
   * remounts when a block crosses the freeze boundary.
   */
  readonly key: number
}

/** One {@link IncrementalMarkdownParser.update} result. */
export interface IncrementalBlocks {
  /** Blocks that can no longer change; grows monotonically per generation. */
  readonly frozen: readonly PositionedBlock[]
  /** The re-parsed unstable tail (at most {@link UNSTABLE_TAIL_BLOCKS} blocks plus growth). */
  readonly tail: readonly PositionedBlock[]
  /** Bumped whenever non-append input discards the frozen prefix; callers drop caches keyed on it. */
  readonly generation: number
}

/**
 * A block's render key: its absolute source start offset. A position-less
 * node (a grammar is free to omit positions) falls back to a negative
 * list-index key — unique within one update's tail, which is the only place
 * the fallback can occur: freezing requires the cut block's position, so a
 * position-less parse keeps every block in the tail (real grammars always
 * stamp positions and never take this path).
 */
function blockKey(node: RootContent, base: number, index: number): number {
  const offset = node.position?.start.offset
  return offset === undefined ? -(index + 1) : base + offset
}

interface OpenFenceState {
  readonly marker: '`' | '~'
  readonly markerLength: number
  readonly syntheticPrefix: string
  readonly codeIndex: number
  readonly frozen: readonly PositionedBlock[]
  readonly tail: readonly PositionedBlock[]
  readonly pendingStart: number
  readonly valuePrefix: string
  readonly end: { readonly line: number; readonly column: number; readonly offset: number }
  readonly endedWithCarriageReturn: boolean
}

/** Return the first line terminator at or after `start`, including a CRLF pair. */
function lineTerminatorEnd(text: string, start: number): number | undefined {
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\n') return index + 1
    if (char === '\r') return text[index + 1] === '\n' ? index + 2 : index + 1
  }
  return undefined
}

/**
 * Source prefix before the last completed line. Keeping that line beside the
 * current partial line lets the grammar retain its trailing-newline semantics.
 */
function committableLinePrefixLength(text: string): number {
  let previousEnd = 0
  let end = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\n') {
      previousEnd = end
      end = index + 1
      continue
    }
    if (char !== '\r' || index + 1 >= text.length) continue
    if (text[index + 1] === '\n') index += 1
    previousEnd = end
    end = index + 1
  }
  return previousEnd
}

/** Exact source terminator ending a non-empty committable prefix. */
function trailingLineTerminator(text: string): '\n' | '\r' | '\r\n' {
  return text.endsWith('\r\n') ? '\r\n' : text.endsWith('\r') ? '\r' : '\n'
}

/** Whether `text` contains a CommonMark closing fence on one of its logical lines. */
function containsClosingFence(text: string, marker: '`' | '~', markerLength: number): boolean {
  let start = 0
  while (start <= text.length) {
    let end = start
    while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end += 1
    const line = text.slice(start, end)
    let indent = 0
    while (indent < 3 && line[indent] === ' ') indent += 1
    let run = indent
    while (line[run] === marker) run += 1
    if (run - indent >= markerLength && /^[ \t]*$/.test(line.slice(run))) return true
    if (end === text.length) return false
    start = text[end] === '\r' && text[end + 1] === '\n' ? end + 2 : end + 1
  }
  /* v8 ignore next -- each loop iteration returns at EOF or advances past a line terminator. */
  return false
}

/** Advance an mdast point across one append while treating a split CRLF as one line ending. */
function advancePoint(
  point: OpenFenceState['end'],
  appended: string,
  precededByCarriageReturn: boolean,
): OpenFenceState['end'] {
  let line = point.line
  let column = point.column
  let afterCarriageReturn = precededByCarriageReturn
  for (const char of appended) {
    if (char === '\n') {
      if (!afterCarriageReturn) line += 1
      column = 1
      afterCarriageReturn = false
      continue
    }
    if (char === '\r') {
      line += 1
      column = 1
      afterCarriageReturn = true
      continue
    }
    column += 1
    afterCarriageReturn = false
  }
  return { line, column, offset: point.offset + appended.length }
}

/**
 * Append-only incremental parser over a caller-supplied grammar. One instance
 * accumulates one streaming document; non-append input resets it.
 */
export class IncrementalMarkdownParser {
  private prevText = ''
  private tailStart = 0
  private frozen: PositionedBlock[] = []
  private generation = 0
  private cached: IncrementalBlocks | null = null
  private openFence: OpenFenceState | null = null

  /** @param parse - Grammar shared with whatever renders the blocks, so boundaries agree. */
  constructor(private readonly parse: (text: string) => Root) {}

  /** Parse one unclosed-fence content slice through the caller's grammar. */
  private fenceValue(state: Pick<OpenFenceState, 'syntheticPrefix'>, text: string): string | undefined {
    const root = this.parse(`${state.syntheticPrefix}${text}`)
    if (root.children.length !== 1) return undefined
    const node = root.children[0] as RootContent
    return node.type === 'code' ? node.value : undefined
  }

  /** Recognize the parsed tail's final unclosed fence and prepare its incremental content frontier. */
  private openFenceState(
    text: string,
    base: number,
    tail: readonly PositionedBlock[],
    frozen: readonly PositionedBlock[],
  ): OpenFenceState | null {
    const codeIndex = tail.length - 1
    const block = tail[codeIndex]
    if (block?.node.type !== 'code') return null
    const node = block.node
    const startOffset = node.position?.start.offset
    const end = node.position?.end
    if (startOffset === undefined || end?.offset === undefined) return null
    /* v8 ignore next -- the caller's parse slice ends at text.length, so its final node ends there. */
    if (base + end.offset !== text.length) return null
    const source = text.slice(base)
    const previousLf = source.lastIndexOf('\n', startOffset - 1)
    const previousCr = source.lastIndexOf('\r', startOffset - 1)
    const lineStart = Math.max(previousLf, previousCr) + 1
    const terminatorEnd = lineTerminatorEnd(source, startOffset)
    /* v8 ignore next -- a parser-confirmed fenced code node requires its opening line terminator. */
    if (terminatorEnd === undefined) return null
    if (terminatorEnd === source.length && source.endsWith('\r')) return null
    const openingLine = source.slice(lineStart, terminatorEnd).replace(/[\r\n]+$/, '')
    const opening = /^( {0,3})(`{3,}|~{3,})/.exec(openingLine)
    if (opening === null) return null
    const indent = opening[1] as string
    const run = opening[2] as string
    /* v8 ignore next -- mdast positions a fenced code node at the matched delimiter after indentation. */
    if (lineStart + indent.length !== startOffset) return null
    const marker = run[0] as '`' | '~'
    const contentStart = base + terminatorEnd
    const content = text.slice(contentStart)
    if (containsClosingFence(content, marker, run.length)) return null
    const syntheticPrefix = `${indent}${run}\n`
    const stableLength = committableLinePrefixLength(content)
    const stableValue = stableLength === 0
      ? ''
      : this.fenceValue({ syntheticPrefix }, content.slice(0, stableLength))
    if (stableValue === undefined) return null
    const pendingStart = contentStart + stableLength
    const stableSource = content.slice(0, stableLength)
    const valuePrefix = stableLength === 0 ? '' : `${stableValue}${trailingLineTerminator(stableSource)}`
    const pendingValue = this.fenceValue({ syntheticPrefix }, text.slice(pendingStart))
    if (pendingValue === undefined || `${valuePrefix}${pendingValue}` !== node.value) return null
    return {
      marker,
      markerLength: run.length,
      syntheticPrefix,
      codeIndex,
      frozen,
      tail,
      pendingStart,
      valuePrefix,
      end: { line: end.line, column: end.column, offset: end.offset },
      endedWithCarriageReturn: text.endsWith('\r'),
    }
  }

  /** Extend a recognized unclosed fence without parsing its completed content prefix again. */
  private updateOpenFence(
    state: OpenFenceState,
    text: string,
    previousText: string,
  ): IncrementalBlocks | undefined {
    const pending = text.slice(state.pendingStart)
    if (containsClosingFence(pending, state.marker, state.markerLength)) return undefined
    const pendingValue = this.fenceValue(state, pending)
    if (pendingValue === undefined) return undefined
    const stableLength = committableLinePrefixLength(pending)
    const stableValue = stableLength === 0
      ? ''
      : this.fenceValue(state, pending.slice(0, stableLength))
    if (stableValue === undefined) return undefined
    // OpenFenceState is private and is installed only from this exact retained
    // code entry; updates replace that entry with another positioned Code.
    const block = state.tail[state.codeIndex] as PositionedBlock
    const previousNode = block.node as Code & { position: NonNullable<Code['position']> }
    const end = advancePoint(
      state.end,
      text.slice(previousText.length),
      state.endedWithCarriageReturn,
    )
    const node: Code = {
      ...previousNode,
      value: `${state.valuePrefix}${pendingValue}`,
      position: { start: previousNode.position.start, end },
    }
    const tail = state.tail.map((entry, index) => index === state.codeIndex ? { ...entry, node } : entry)
    const cached = {
      frozen: state.frozen,
      tail,
      generation: this.generation,
    }
    this.openFence = {
      ...state,
      tail,
      pendingStart: state.pendingStart + stableLength,
      valuePrefix: stableLength === 0
        ? state.valuePrefix
        : `${state.valuePrefix}${stableValue}${trailingLineTerminator(pending.slice(0, stableLength))}`,
      end,
      endedWithCarriageReturn: text.endsWith('\r'),
    }
    return cached
  }

  /**
   * Fold the current accumulated text and return the frozen/tail split.
   * Idempotent for identical input (the previous result is returned as-is),
   * so callers may invoke it from render paths that re-execute.
   * @param text - The full accumulated markdown source.
   * @returns Frozen and tail blocks with stream-stable render keys.
   */
  update(text: string): IncrementalBlocks {
    if (this.cached !== null && text === this.prevText) return this.cached
    // Deliberate O(prefix) memcmp per update: sound divergence detection has
    // to verify the whole retained prefix, and startsWith compares bytes two
    // orders of magnitude faster than parsing them — the cost this class
    // exists to remove. Passing append/reset deltas instead would push
    // append bookkeeping across the session-projection update boundary for a check
    // that stays sub-millisecond at realistic reply sizes.
    if (!text.startsWith(this.prevText)) {
      this.prevText = ''
      this.tailStart = 0
      this.frozen = []
      this.openFence = null
      this.generation += 1
    }
    const previousText = this.prevText
    if (previousText !== '' && this.openFence !== null) {
      const incremental = this.updateOpenFence(this.openFence, text, previousText)
      if (incremental !== undefined) {
        this.prevText = text
        this.cached = incremental
        return incremental
      }
      this.openFence = null
    }
    this.prevText = text
    const base = this.tailStart
    const blocks = this.parse(text.slice(base)).children
    let firstUnstable = Math.max(0, blocks.length - UNSTABLE_TAIL_BLOCKS)
    if (firstUnstable > 0) {
      const cutEnd = blocks[firstUnstable - 1]?.position?.end.offset
      if (cutEnd === undefined) {
        // A grammar that omits positions leaves nothing to cut at; keep the
        // whole parse in the tail rather than guessing a boundary.
        firstUnstable = 0
      } else {
        for (const node of blocks.slice(0, firstUnstable)) {
          this.frozen.push({ node, key: blockKey(node, base, this.frozen.length) })
        }
        this.tailStart = base + cutEnd
      }
    }
    const tail = blocks.slice(firstUnstable).map((node, index) => ({
      node,
      key: blockKey(node, base, index),
    }))
    this.cached = { frozen: [...this.frozen], tail, generation: this.generation }
    this.openFence = this.openFenceState(text, base, tail, this.cached.frozen)
    return this.cached
  }
}
