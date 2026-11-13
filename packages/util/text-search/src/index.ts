/**
 * Multilingual fuzzy search over an in-memory list.
 *
 * A {@link TextSearchIndex} prepares every key of a list once, then answers
 * any number of queries over that list. `fuzzy` keys (names, titles, labels,
 * readable ids) match as substrings or as fuzzysort subsequences that start at
 * a word start, so `cpt` finds `compact` while `fab` does not match inside
 * `Refactor build`. `substring` keys (descriptions, prompts, paths, opaque
 * ids) match only as a contiguous substring of each query term: a subsequence
 * scattered across a long sentence is noise. Every key may carry several
 * values, such as every language of a localized title. Both key kinds ignore
 * case, width (NFKC), U+0300–U+036F diacritics, and the stroke of letters such
 * as `ł` and `ø`. Matching requires every whitespace-separated query term to
 * match some key of the item.
 *
 * Each term scores by its best tier: a fuzzy-key prefix, then a fuzzy-key
 * substring, then a fuzzy subsequence ordered by fuzzysort score, then a
 * substring-key hit. Equal scores keep the build order, so a term that
 * prefixes every name leaves the list in product order.
 *
 * @module @deepseek-ai/dsh-util-text-search
 */

import fuzzysort from 'fuzzysort'
import type { Prepared } from 'fuzzysort'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'

/** The text one item offers to a search; absent and empty values never match. */
export interface SearchKeys {
  /** Short identifying text matched as substrings or word-start fuzzy subsequences, ranked first: names, titles, labels, readable ids. */
  readonly fuzzy?: readonly (string | undefined)[]
  /** Longer text and opaque ids matched only as contiguous substrings: descriptions, prompts, paths, UUIDs. */
  readonly substring?: readonly (string | undefined)[]
}

/** Tier bases; a fuzzy subsequence hit adds its fuzzysort score in [0, 1) to its base. */
const FUZZY_PREFIX = 4
const FUZZY_SUBSTRING = 3
const FUZZY_SUBSEQUENCE = 2
const SUBSTRING = 1

/**
 * Every language of a localized value.
 * @param text - plain or localized text.
 * @returns the plain string, or every locale's value; none when absent.
 */
export function localizedValues(text: LocalizedText | undefined): readonly string[] {
  if (text === undefined) return []
  return typeof text === 'string' ? [text] : Object.values(text)
}

const WORD_CHAR = /[\p{L}\p{N}]/u
const UPPER = /\p{Lu}/u
const LOWER = /\p{Ll}/u
/** Scripts written without spaces between words; each of their characters starts a word. */
const UNSPACED = /[\p{scx=Han}\p{scx=Hira}\p{scx=Kana}\p{scx=Hang}]/u

/** The code point starting at UTF-16 offset `index`, which callers keep inside `text`. */
function codePointAt(text: string, index: number): string {
  return String.fromCodePoint(text.codePointAt(index) as number)
}

/** The code point ending just before UTF-16 offset `index`. */
function codePointBefore(text: string, index: number): string {
  const low = text.charCodeAt(index - 1)
  const start = low >= 0xdc00 && low <= 0xdfff && index >= 2 ? index - 2 : index - 1
  return codePointAt(text, start)
}

/**
 * Whether the code point at UTF-16 offset `index` of `text` starts a word: after a separator,
 * at a camel-case hump, or in an unspaced script.
 */
function wordStart(text: string, index: number): boolean {
  if (index === 0) return true
  const char = codePointAt(text, index)
  const previous = codePointBefore(text, index)
  return !WORD_CHAR.test(previous) || UNSPACED.test(char) || (UPPER.test(char) && LOWER.test(previous))
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/

/** Combining diacritical marks; other scripts' combining marks, such as kana voicing or Indic vowel signs, change the letter and stay. */
const DIACRITIC = /[\u0300-\u036f]/gu

/** Letters with a built-in stroke that decomposition leaves intact, mapped to their base letter. */
const STROKED: Readonly<Record<string, string>> = {
  'ø': 'o', 'Ø': 'O', 'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D', 'ð': 'd', 'Ð': 'D', 'ı': 'i', 'ħ': 'h', 'Ħ': 'H', 'ŧ': 't', 'Ŧ': 'T',
}
const STROKED_CHAR = /[øØłŁđĐðÐıħĦŧŦ]/gu

/** Width- and diacritic-insensitive form that keeps case, so camel-case humps survive for word starts. */
function strip(value: string): string {
  // Printable ASCII has no width forms or combining marks, and most keys are ASCII.
  if (PRINTABLE_ASCII.test(value)) return value
  return value.normalize('NFKD').replace(DIACRITIC, '').normalize('NFKC').replace(STROKED_CHAR, char => STROKED[char] as string)
}

/** Case-, width-, and diacritic-insensitive form used for substring tests. */
function fold(value: string): string {
  return strip(value).toLowerCase()
}

/** One fuzzy key prepared at build; word starts and fuzzysort targets fill in on first fuzzy attempt. */
interface PreparedName {
  readonly stripped: string
  readonly folded: string
  /** Word-start positions of `stripped`, computed on the first fuzzy attempt. */
  starts: readonly number[] | undefined
  /** fuzzysort targets of `stripped` from one word start onward, prepared on first use. */
  readonly tails: Map<number, Prepared>
}

/** One item's keys prepared at build. */
interface PreparedKeys {
  readonly fuzzy: readonly PreparedName[]
  readonly substring: readonly string[]
}

/** One query term in the two forms the tiers compare. */
interface Term {
  readonly stripped: string
  readonly folded: string
}

/** Prepared key strings of one index, by original string; an update reuses the entries its items still use. */
interface Preparations {
  readonly fuzzy: Map<string, PreparedName>
  readonly substring: Map<string, string>
}

/**
 * Prepare one item's keys, reusing an earlier index's preparation of the same string.
 * @param keys - the item's search text.
 * @param reuse - preparations of the index being updated, if any.
 * @param into - preparations of the index being built; receives every string this item uses.
 */
function prepareKeys(keys: SearchKeys, reuse: Preparations | undefined, into: Preparations): PreparedKeys {
  const fuzzy = (keys.fuzzy ?? []).flatMap((value) => {
    if (value === undefined || value === '') return []
    let name = into.fuzzy.get(value) ?? reuse?.fuzzy.get(value)
    if (name === undefined) {
      const stripped = strip(value)
      name = { stripped, folded: stripped.toLowerCase(), starts: undefined, tails: new Map() }
    }
    into.fuzzy.set(value, name)
    return [name]
  })
  const substring = (keys.substring ?? []).flatMap((value) => {
    if (value === undefined || value === '') return []
    const folded = into.substring.get(value) ?? reuse?.substring.get(value) ?? fold(value)
    into.substring.set(value, folded)
    return [folded]
  })
  return { fuzzy, substring }
}

/** Prepare every item's keys. */
function build<T>(items: readonly T[], keys: (item: T) => SearchKeys, reuse: Preparations | undefined): {
  readonly keys: readonly PreparedKeys[]
  readonly preparations: Preparations
} {
  const preparations: Preparations = { fuzzy: new Map(), substring: new Map() }
  return { keys: items.map(item => prepareKeys(keys(item), reuse, preparations)), preparations }
}

/** Whether every character of `term` occurs in `text` in order; a cheap filter before fuzzysort. */
function inOrder(term: string, text: string): boolean {
  let at = 0
  for (const char of term) {
    at = text.indexOf(char, at)
    if (at === -1) return false
    at += char.length
  }
  return true
}

/**
 * The best fuzzysort score of a term over the subsequences of `name` that start at a word start.
 * fuzzysort reports one alignment per target, so each word start whose character equals the term's
 * first character is tried as its own target.
 */
function fuzzyNameScore(term: Term, name: PreparedName): number | undefined {
  if (!inOrder(term.folded, name.folded)) return undefined
  if (name.starts === undefined) {
    const starts: number[] = []
    let index = 0
    for (const char of name.stripped) {
      if (wordStart(name.stripped, index)) starts.push(index)
      index += char.length
    }
    name.starts = starts
  }
  const first = codePointAt(term.stripped, 0).toLowerCase()
  let best: number | undefined
  for (const start of name.starts) {
    if (codePointAt(name.stripped, start).toLowerCase() !== first) continue
    let tail = name.tails.get(start)
    if (tail === undefined) {
      // An uncached target: fuzzysort's own target cache would grow with every distinct name for the process lifetime.
      tail = fuzzysort.prepare(name.stripped.slice(start))
      name.tails.set(start, tail)
    }
    const result = fuzzysort.single(term.stripped, tail)
    if (result !== null && wordStart(name.stripped, start + (result.indexes[0] as number))) {
      best = best === undefined ? result.score : Math.max(best, result.score)
    }
  }
  return best
}

/** The best score of one term over one item's keys, or undefined when no key matches. */
function termScore(term: Term, keys: PreparedKeys): number | undefined {
  let best: number | undefined
  const take = (score: number): void => { best = best === undefined ? score : Math.max(best, score) }
  for (const name of keys.fuzzy) {
    const at = name.folded.indexOf(term.folded)
    if (at === 0) take(FUZZY_PREFIX)
    else if (at > 0) take(FUZZY_SUBSTRING)
    else {
      const score = fuzzyNameScore(term, name)
      // A fuzzysort score of 1 is reserved for exact matches, which the prefix tier already took.
      if (score !== undefined) take(FUZZY_SUBSEQUENCE + Math.min(score, 0.99))
    }
  }
  for (const text of keys.substring) {
    if (text.includes(term.folded)) take(SUBSTRING)
  }
  return best
}

/**
 * Search index over one list. The constructor prepares every key of every
 * item; {@link TextSearchIndex.search} then answers queries without
 * re-reading the items or their keys. An index holds its list by reference and
 * never changes: callers must not mutate the list or its items, and call
 * {@link TextSearchIndex.update} with a new list when the list or any item's
 * keys change.
 */
export class TextSearchIndex<T> {
  #items: readonly T[]
  #keys: readonly PreparedKeys[]
  #preparations: Preparations

  /**
   * Prepare every key of every item.
   * @param items - candidates in their display order, which ties keep.
   * @param keys - the search text of one item, called once per item here.
   */
  constructor(items: readonly T[], keys: (item: T) => SearchKeys) {
    const built = build(items, keys, undefined)
    this.#items = items
    this.#keys = built.keys
    this.#preparations = built.preparations
  }

  /**
   * Build the index of a changed list. Items added, removed, reordered, or
   * changed are all expressed by the complete new list; a key string that this
   * index already prepared is reused instead of prepared again, and strings no
   * item uses any more are not carried over. This index stays valid.
   * @param items - the complete new list in display order.
   * @param keys - the search text of one item, called once per item here.
   * @returns a new index over `items`.
   */
  update(items: readonly T[], keys: (item: T) => SearchKeys): TextSearchIndex<T> {
    const next = new TextSearchIndex<T>([], keys)
    const built = build(items, keys, this.#preparations)
    next.#items = items
    next.#keys = built.keys
    next.#preparations = built.preparations
    return next
  }

  /**
   * Filter and rank the indexed items by a query.
   * @param query - the user's search text.
   * @returns the build list itself when the query is blank or holds only
   * combining marks; otherwise the items matching every query term, best total
   * score first and build order on ties.
   */
  search(query: string): readonly T[] {
    // A term made only of combining marks folds to nothing and constrains nothing.
    const terms = query.trim().split(/\s+/u)
      .map((term): Term => ({ stripped: strip(term), folded: fold(term) }))
      .filter(term => term.folded !== '')
    if (terms.length === 0) return this.#items
    const ranked: { readonly index: number; readonly score: number }[] = []
    this.#keys.forEach((itemKeys, index) => {
      let score = 0
      for (const term of terms) {
        const hit = termScore(term, itemKeys)
        if (hit === undefined) return
        score += hit
      }
      ranked.push({ index, score })
    })
    ranked.sort((left, right) => right.score - left.score || left.index - right.index)
    return ranked.map(entry => this.#items[entry.index] as T)
  }
}
