import { describe, expect, it } from 'vitest'
import {
  DUNDER_MEMBER,
  PORTABLE_RESERVED_WORDS,
  RESERVED_BINDING_GLOBALS,
  RESERVED_ERROR_MEMBERS,
} from '@deepseek-ai/dsh-ptc-runtime'

/**
 * The Service Definition owns the portable-identifier exclusion sets so every backend
 * enforces one contract: a namespace list valid on one backend is valid on
 * all. These assertions pin the shared membership backends import rather than
 * re-declare.
 */
describe('seam-owned portable identifier exclusions', () => {
  it('RESERVED_BINDING_GLOBALS covers each backend-owned slot', () => {
    expect(RESERVED_BINDING_GLOBALS.has('console')).toBe(true)
    expect(RESERVED_BINDING_GLOBALS.has('__dsh_main__')).toBe(true)
    expect(RESERVED_BINDING_GLOBALS.has('__builtins__')).toBe(true)
    expect(RESERVED_BINDING_GLOBALS.has('__name__')).toBe(true)
    expect(RESERVED_BINDING_GLOBALS.has('__debug__')).toBe(true)
    expect(RESERVED_BINDING_GLOBALS.has('tools')).toBe(false)
  })

  it('RESERVED_ERROR_MEMBERS covers the JS Error and Python exception-protocol members', () => {
    for (const name of ['name', 'message', 'stack', 'args', 'with_traceback', 'add_note']) {
      expect(RESERVED_ERROR_MEMBERS.has(name)).toBe(true)
    }
    expect(RESERVED_ERROR_MEMBERS.has('code')).toBe(false)
  })

  it('DUNDER_MEMBER matches dunder-form names only', () => {
    expect(DUNDER_MEMBER.test('__dict__')).toBe(true)
    expect(DUNDER_MEMBER.test('__init__')).toBe(true)
    expect(DUNDER_MEMBER.test('_private')).toBe(false)
    expect(DUNDER_MEMBER.test('name')).toBe(false)
    expect(DUNDER_MEMBER.test('__mid')).toBe(false)
    // `__` has an empty middle — not a real CPython dunder, so not matched.
    expect(DUNDER_MEMBER.test('__')).toBe(false)
    // `____` also has an empty middle between the two `__` pairs — not matched.
    expect(DUNDER_MEMBER.test('____')).toBe(false)
    // A single character between the pairs is the shortest real dunder form.
    expect(DUNDER_MEMBER.test('__x__')).toBe(true)
  })

  it('PORTABLE_RESERVED_WORDS is the union of ECMAScript and Python reserved words', () => {
    // ECMAScript-only keyword.
    expect(PORTABLE_RESERVED_WORDS.has('function')).toBe(true)
    // Python-only keyword — refused here so the list stays portable.
    expect(PORTABLE_RESERVED_WORDS.has('lambda')).toBe(true)
    expect(PORTABLE_RESERVED_WORDS.has('nonlocal')).toBe(true)
    // Shared keyword.
    expect(PORTABLE_RESERVED_WORDS.has('class')).toBe(true)
    // Ordinary identifier is not reserved.
    expect(PORTABLE_RESERVED_WORDS.has('tools')).toBe(false)
  })
})
