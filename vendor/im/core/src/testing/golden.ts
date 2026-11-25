/**
 * `expectGolden(name, payloads)`: compare serialized payloads with `<dir>/<name>.json`, or rewrite that file when
 * `IM_GOLDENS=update` is set.
 *
 * A payload golden is the cheapest possible contract: `mode.serialize()` is pure, so the JSON a mode would post is
 * recorded without a network and compared on every run. Payloads are normalized through JSON (class prototypes,
 * `undefined` fields and non-enumerable state are dropped) so a re-serialized object cannot produce a false diff.
 *
 * The testkit writes the file itself instead of calling `expect()`: a missing golden has to fail with an instruction,
 * not with a mystery diff.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export interface GoldenOptions {
  /** Directory holding `<name>.json`; default `<cwd>/tests/goldens`. */
  dir?: string
  /** JSON indentation; default 2. */
  indent?: number
}

/** Environment values that put {@link expectGolden} in rewrite mode. */
const UPDATE = /^(?:1|true|update|yes)$/i

/** Absolute path of the golden file `expectGolden` uses. */
export function goldenFile(name: string, options: GoldenOptions = {}): string {
  return resolve(options.dir ?? 'tests/goldens', `${name}.json`)
}

/** True when `IM_GOLDENS=update` asks to rewrite the goldens. */
export function goldenUpdateRequested(env: Record<string, string | undefined> = process.env): boolean {
  return UPDATE.test(env.IM_GOLDENS ?? '')
}

export function expectGolden(name: string, payloads: unknown, options: GoldenOptions = {}): void {
  const file = goldenFile(name, options)
  const actual = `${format(payloads, options.indent ?? 2)}\n`
  if (goldenUpdateRequested()) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, actual)
    return
  }
  let expected: string
  try {
    expected = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`expectGolden: the golden "${name}" does not exist yet (${file}); `
        + 'create it with IM_GOLDENS=update and re-run the test')
    }
    throw error
  }
  if (expected === actual) return
  throw new Error(`expectGolden: "${name}" differs from ${file}\n`
    + `${diff(expected, actual)}\n`
    + '(review the change, then re-run with IM_GOLDENS=update to accept it)')
}

/** JSON projection of a payload collection (one level of JSON, so undefined fields and classes normalize away). */
function format(payloads: unknown, indent: number): string {
  let plain: unknown
  try {
    plain = JSON.parse(JSON.stringify(payloads) ?? 'null')
  } catch (error) {
    throw new Error(`expectGolden: the payloads are not JSON-serializable (${(error as Error).message})`, { cause: error })
  }
  return JSON.stringify(plain, null, indent)
}

/** First differing line with two lines of context; enough to see what changed without a full diff library. */
function diff(expected: string, actual: string): string {
  const left = expected.split('\n')
  const right = actual.split('\n')
  const at = left.findIndex((line, index) => line !== right[index])
  if (at < 0) {
    return `the files differ only in trailing content (expected ${left.length} lines, got ${right.length})`
  }
  const from = Math.max(0, at - 2)
  const window = (lines: string[]) => lines.slice(from, at + 3).map((line, index) => {
    const number = String(from + index + 1).padStart(4)
    return `${number}${from + index === at ? '>' : '|'} ${line}`
  }).join('\n')
  return `line ${at + 1}\n--- golden\n${window(left)}\n+++ actual\n${window(right)}`
}
