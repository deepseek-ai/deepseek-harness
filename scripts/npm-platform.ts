/** npm `os`/`cpu` package-field matching for build and release scripts. */

/**
 * Test whether an npm `os` or `cpu` field admits a value, following npm's install checks.
 * @param value - Raw manifest field; `undefined` admits every value.
 * @param current - Target platform or architecture.
 * @returns Whether the package may install for the target.
 * @throws When the field is not an array of strings.
 */
export function acceptsNpmPlatform(value: unknown, current: string): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value) || !value.every((tag): tag is string => typeof tag === 'string')) {
    throw new Error('npm platform constraints must be arrays of strings')
  }
  let accepted = value.every(tag => tag.startsWith('!'))
  for (const tag of value) {
    if (tag === `!${current}`) return false
    if (tag === current || (tag === 'any' && value.length === 1)) accepted = true
  }
  return accepted
}
