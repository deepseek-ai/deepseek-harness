/** Lookup tables derived from the credential formats, built once on first use. */
import {
  ALNUM, ALNUM_DASH, CREDENTIAL_FORMATS, KEY, LABEL, LOWER, PASSWORD, SCHEME, UPPER_ALNUM, USER, WORD,
} from './credential-formats.ts'

/** Tables indexed by format position in `CREDENTIAL_FORMATS`, by ASCII code unit, or by a literal's last two code units. */
export interface FormatTables {
  /** Class bits per ASCII code unit. */
  readonly classes: Uint16Array
  readonly literals: readonly string[]
  readonly literalLength: Uint8Array
  readonly literalKind: Uint8Array
  readonly literalShape: Uint8Array
  readonly literalRun: Uint16Array
  readonly literalMin: Int32Array
  readonly literalMax: Int32Array
  /**
   * Length of the longest proper suffix of each literal that begins a literal. The
   * scan resumes there, so a key block whose first dash ends `sk-` is still seen.
   */
  readonly literalOverlap: Uint8Array
  /** Literal-only alternation of every literal, grouped by shared leading characters; no quantifier. */
  readonly prefixSource: string
  /** Per key `code[-2] * 128 + code[-1]`: the literal with that ending plus one, or -1 where several share it. */
  readonly ending: Int8Array
  /** Literals sharing an ending, by the same key. */
  readonly sharedEndings: readonly (readonly number[] | undefined)[]
}

let tables: FormatTables | undefined

/**
 * The tables for `CREDENTIAL_FORMATS`; the first call builds them.
 * @returns the shared, read-only tables.
 */
export function formatTables(): FormatTables {
  tables ??= buildTables()
  return tables
}

function buildTables(): FormatTables {
  const formats = CREDENTIAL_FORMATS
  const literals = formats.map(f => f.literal)
  const { ending, sharedEndings } = endingTables(literals)
  return {
    classes: charClasses(),
    literals,
    literalLength: Uint8Array.from(literals, literal => literal.length),
    literalKind: Uint8Array.from(formats, f => f.kind),
    literalShape: Uint8Array.from(formats, f => f.shape),
    literalRun: Uint16Array.from(formats, f => f.run),
    literalMin: Int32Array.from(formats, f => f.min),
    literalMax: Int32Array.from(formats, f => f.max),
    literalOverlap: Uint8Array.from(literals, literal => overlap(literal, literals)),
    prefixSource: alternation(literals),
    ending,
    sharedEndings,
  }
}

function charClasses(): Uint16Array {
  const classes = new Uint16Array(128)
  for (let code = 0; code < 128; code++) {
    const upper = code >= 65 && code <= 90
    const lower = code >= 97 && code <= 122
    const digit = code >= 48 && code <= 57
    const alnum = upper || lower || digit
    const authority = !((code >= 9 && code <= 13) || code === 32 || code === 47 || code === 64 || code === 63 || code === 35)
    classes[code] = (alnum || code === 95 || code === 45 ? KEY : 0) | (alnum ? ALNUM : 0) | (alnum || code === 95 ? WORD : 0)
      | (alnum || code === 45 ? ALNUM_DASH : 0) | (upper || digit ? UPPER_ALNUM : 0) | (upper || digit || code === 32 ? LABEL : 0)
      | (lower || digit || code === 43 || code === 46 || code === 45 ? SCHEME : 0) | (lower ? LOWER : 0)
      | (authority && code !== 58 ? USER : 0) | (authority ? PASSWORD : 0)
  }
  return classes
}

function overlap(literal: string, literals: readonly string[]): number {
  for (let size = literal.length - 1; size > 0; size--) {
    const suffix = literal.slice(-size)
    if (literals.some(other => other.startsWith(suffix))) return size
  }
  return 0
}

function endingTables(literals: readonly string[]): Pick<FormatTables, 'ending' | 'sharedEndings'> {
  const ending = new Int8Array(128 * 128)
  const sharedEndings: number[][] = []
  literals.forEach((literal, index) => {
    const key = literal.charCodeAt(literal.length - 2) * 128 + literal.charCodeAt(literal.length - 1)
    const existing = ending[key] as number
    if (existing === 0) {
      ending[key] = index + 1
      return
    }
    if (existing > 0) {
      sharedEndings[key] = [existing - 1]
      ending[key] = -1
    }
    (sharedEndings[key] as number[]).push(index)
  })
  return { ending, sharedEndings }
}

const escape = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&')

/** Literal alternatives grouped by shared leading characters; groups only factor literals and add no quantifier. */
function alternation(literals: readonly string[]): string {
  const groups = new Map<string, string[]>()
  for (const literal of literals) groups.set(literal.charAt(0), [...groups.get(literal.charAt(0)) ?? [], literal.slice(1)])
  return [...groups].map(([head, tails]) => tails.length === 1
    ? escape(head + tails.join(''))
    : `${escape(head)}(?:${alternation(tails)})`).join('|')
}
