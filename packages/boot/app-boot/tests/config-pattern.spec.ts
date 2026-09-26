/** Regex projection preserves known portable patterns and rejects Unicode-dependent assertions. */

import { describe, expect, it, vi } from 'vitest'
import { RegExpParser } from '@eslint-community/regexpp'
import { createPatternCheck } from '../src/config-schema/pattern.ts'

const portable = await createPatternCheck()

describe('JSON Schema pattern compatibility', () => {
  it.each([
    ['^[A-Za-z0-9_-]{1,32}$', '', true],
    ['^https?:\\/\\/\\S+$', '', true],
    ['\\S', '', true],
    ['^.$', '', false],
    ['\\uD83D', '', false],
    ['\\a', '', false],
    ['\\p{Letter}', '', false],
    ['^.$', 'u', true],
    ['\\a', 'u', false],
    ['^[a-z]+$', 'i', false],
    ['\\S+\\S+', '', false],
    ['(?:abc)', '', false],
    ['[\\uD7ff-\\uE000]', '', false],
    ['[\\uE000-\\uF000]', '', true],
    ['.', '', true],
    ['[^x]', '', false],
    ['^\\d+\\s\\w+$', '', true],
    ['a?', '', true],
    ['(?=a)a', '', false],
    ['\\bfoo\\b', '', true],
    ['a.*\\B', '', false],
    ['a.+\\B', '', false],
    ['a\\D*\\B', '', false],
    ['a\\W+\\B', '', false],
    ['a.*\\b', '', false],
  ])('%s with flags %s has portability %s', (source, flags, expected) => {
    expect(portable(source, flags)).toBe(expected)
  })

  it('uses native flagless semantics when flags are absent', () => {
    expect(portable('plain')).toBe(true)
  })

  it('does not hide unexpected parser failures', () => {
    const parse = vi.spyOn(RegExpParser.prototype, 'parsePattern').mockImplementation(() => { throw new Error('parser failed') })
    try {
      expect(() => portable('plain')).toThrow('parser failed')
    } finally {
      parse.mockRestore()
    }
  })
})
