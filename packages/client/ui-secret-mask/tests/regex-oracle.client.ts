/**
 * The backtracking regular-expression formats this package replaced, kept as
 * an equivalence oracle for the prefix-pruned matcher. Not product code. It
 * joins every overlapping match, including later matches of the same format.
 */
import type { UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '../src/client/secret-rule.ts'

const MASK = '*'
/** Leading characters of a prefixed key left readable: the provider prefix and little else. */
const VISIBLE_PREFIX = 8

const maskRun = (value: string): string => value.replace(/[^\r\n]/gu, MASK)
const maskAfterPrefix = (value: string): string =>
  value.slice(0, VISIBLE_PREFIX) + maskRun(value.slice(VISIBLE_PREFIX))
/**
 * Keeps the `BEGIN` line, the `END` line when present, and every line break.
 * A block written on one line has no line to keep and is masked whole.
 */
const maskKeyBlock = (value: string): string => {
  const bodyStart = value.indexOf('\n') + 1
  const end = value.lastIndexOf('\n-----END')
  const bodyEnd = end < bodyStart ? value.length : end
  return value.slice(0, bodyStart) + maskRun(value.slice(bodyStart, bodyEnd)) + value.slice(bodyEnd)
}

interface Format {
  /** Global pattern whose whole match is the credential. */
  readonly pattern: RegExp
  readonly mask: (value: string) => string
}

/**
 * Credentials whose published format starts with a fixed prefix. Every pattern
 * matches more than `VISIBLE_PREFIX` characters, which `maskAfterPrefix` relies on.
 */
const PREFIXED: readonly RegExp[] = [
  // Model services: `sk-` keys carry at least one digit, which hyphenated identifiers rarely do.
  // The bounded lookahead keeps a long run of digit-free `sk-` repeats linear.
  /\bsk-(?=[A-Za-z0-9_-]{0,255}\d)[A-Za-z0-9_-]{20,}/gu,
  /\bAIza[A-Za-z0-9_-]{35}/gu,
  // Code hosting and package registries.
  /\bgh[pousr]_[A-Za-z0-9]{36,}/gu,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/gu,
  /\bglpat-[A-Za-z0-9_-]{20,}/gu,
  /\bnpm_[A-Za-z0-9]{36,}/gu,
  /\bhf_[A-Za-z0-9]{30,}/gu,
  // Cloud access key IDs.
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /\bLTAI[A-Za-z0-9]{12,20}\b/gu,
  /\bAKID[A-Za-z0-9]{28,36}\b/gu,
  // Collaboration and payment services.
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/gu,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/gu,
  /\bwhsec_[A-Za-z0-9]{24,}/gu,
  // JSON Web Tokens. The header bound keeps a long run of `eyJ` repeats linear.
  /\beyJ[A-Za-z0-9_-]{8,2048}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
]

/** Same-start matches resolve in this order, so a token used as an address password is masked completely. */
const FORMATS: readonly Format[] = [
  {
    pattern: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/gu,
    mask: maskKeyBlock,
  },
  // The lookbehind starts the match at the password, so a query from inside the address finds the same candidate.
  // The user name may be empty, and neither part crosses `?` or `#`, where the authority ends.
  { pattern: /(?<=\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s/:@?#]{0,256}:)[^\s/@?#]+(?=@)/gu, mask: maskRun },
  ...PREFIXED.map(pattern => ({ pattern, mask: maskAfterPrefix })),
]

interface Hit {
  readonly start: number
  readonly end: number
}

function find(regex: RegExp, text: string, from: number): Hit | undefined {
  regex.lastIndex = from
  const match = regex.exec(text)
  return match === null ? undefined : { start: match.index, end: match.index + match[0].length }
}

/**
 * Return the nearest credential at or after `from`. Overlapping matches of any
 * format join the earliest one and take its mask, so no credential is drawn half masked.
 * Reads no Facts, so Facts changes never invalidate its queries.
 */
export const regexSecretRule: UserTextRule<'secret'> = {
  id: 'secret',
  order: 0,
  match(text, from) {
    const scans = FORMATS.map((format) => {
      const regex = new RegExp(format.pattern)
      return { format, regex, hit: find(regex, text, from) }
    })
    let first: { readonly format: Format; readonly hit: Hit } | undefined
    for (const { format, hit } of scans) {
      // The strict comparison keeps the earlier format at an equal start.
      if (hit !== undefined && (first === undefined || hit.start < first.hit.start)) first = { format, hit }
    }
    if (first === undefined) return undefined
    const { start } = first.hit
    let end = first.hit.end
    for (let grown = true; grown;) {
      grown = false
      for (const scan of scans) {
        while (scan.hit !== undefined && scan.hit.start < end) {
          if (scan.hit.end > end) {
            end = scan.hit.end
            grown = true
          }
          // Overlapping matches of one format join as well, so a key that starts inside another is masked whole.
          scan.hit = find(scan.regex, text, scan.hit.start + 1)
        }
      }
    }
    return { id: 'secret', start, end, data: { masked: first.format.mask(text.slice(start, end)) } }
  },
}
