/**
 * The credential formats the matcher recognizes, as data: the literal each
 * format begins with, how its candidate is validated, and the ASCII character
 * classes those checks use. [format-tables.ts](./format-tables.ts) derives
 * lookup tables from this list on first use.
 */

// Character classes of one ASCII code unit, as bits.
/** `[A-Za-z0-9_-]` */
export const KEY = 1
/** `[A-Za-z0-9]` */
export const ALNUM = 2
/** `\w` */
export const WORD = 4
/** `[A-Za-z0-9-]` */
export const ALNUM_DASH = 8
/** `[A-Z0-9]` */
export const UPPER_ALNUM = 16
/** `[A-Z0-9 ]` */
export const LABEL = 32
/** `[a-z0-9+.-]` */
export const SCHEME = 64
/** `[a-z]` */
export const LOWER = 128
/** `[^\s/:@?#]` */
export const USER = 256
/** `[^\s/@?#]` */
export const PASSWORD = 512

// Literal kinds. Same-start candidates resolve by ascending kind, so a token used as an address password is masked completely.
/** A private key block from its `-----BEGIN` line. */
export const KEY_BLOCK = 0
/** The password of an address that carries credentials. */
export const ADDRESS = 1
/** A provider key or token after its fixed prefix. */
export const PREFIXED = 2

// Shapes of a prefixed format's character run after its literal.
/** The whole run, at least `min`. */
export const RUN = 0
/** `min` to `max`, then `\b`. */
export const BOUNDED = 1
/** At least `min`, with a digit among the first 256. */
export const SK = 2
/** Exactly `min`. */
export const GOOGLE = 3
/** Three runs joined by `.eyJ` and `.`. */
export const JWT = 4

/** One recognized format. */
export interface CredentialFormat {
  /** ASCII literal the candidate begins with; no literal occurs inside another. */
  readonly literal: string
  readonly kind: typeof KEY_BLOCK | typeof ADDRESS | typeof PREFIXED
  /** Prefixed formats only: how the run after the literal is validated. */
  readonly shape: number
  /** Prefixed formats only: the class bit of the run after the literal. */
  readonly run: number
  readonly min: number
  readonly max: number
}

const prefixed = (literal: string, shape: number, run: number, min: number, max = 0): CredentialFormat =>
  ({ literal, kind: PREFIXED, shape, run, min, max })

/** Every prefixed format matches more than the 8 characters a mask leaves readable. */
export const CREDENTIAL_FORMATS: readonly CredentialFormat[] = [
  { literal: '-----BEGIN ', kind: KEY_BLOCK, shape: RUN, run: 0, min: 0, max: 0 },
  { literal: '://', kind: ADDRESS, shape: RUN, run: 0, min: 0, max: 0 },
  // Model services: `sk-` keys carry a digit, which hyphenated identifiers rarely do.
  prefixed('sk-', SK, KEY, 20),
  prefixed('AIza', GOOGLE, KEY, 35),
  // Code hosting and package registries.
  prefixed('ghp_', RUN, ALNUM, 36),
  prefixed('gho_', RUN, ALNUM, 36),
  prefixed('ghu_', RUN, ALNUM, 36),
  prefixed('ghs_', RUN, ALNUM, 36),
  prefixed('ghr_', RUN, ALNUM, 36),
  prefixed('github_pat_', RUN, WORD, 22),
  prefixed('glpat-', RUN, KEY, 20),
  prefixed('npm_', RUN, ALNUM, 36),
  prefixed('hf_', RUN, ALNUM, 30),
  // Cloud access key IDs.
  prefixed('AKIA', BOUNDED, UPPER_ALNUM, 16, 16),
  prefixed('ASIA', BOUNDED, UPPER_ALNUM, 16, 16),
  prefixed('LTAI', BOUNDED, ALNUM, 12, 20),
  prefixed('AKID', BOUNDED, ALNUM, 28, 36),
  // Collaboration and payment services.
  prefixed('xoxa-', RUN, ALNUM_DASH, 10),
  prefixed('xoxb-', RUN, ALNUM_DASH, 10),
  prefixed('xoxp-', RUN, ALNUM_DASH, 10),
  prefixed('xoxr-', RUN, ALNUM_DASH, 10),
  prefixed('xoxs-', RUN, ALNUM_DASH, 10),
  prefixed('sk_live_', RUN, ALNUM, 16),
  prefixed('sk_test_', RUN, ALNUM, 16),
  prefixed('rk_live_', RUN, ALNUM, 16),
  prefixed('rk_test_', RUN, ALNUM, 16),
  prefixed('whsec_', RUN, ALNUM, 24),
  prefixed('eyJ', JWT, KEY, 8, 2048),
]
