import { describe, expect, it } from 'vitest'
import { RESERVED_BINDING_WORDS, RESERVED_BINDING_GLOBALS, RESERVED_ERROR_MEMBERS } from '@deepseek-ai/dsh-ptc-runtime'

describe('runtime binding exclusions', () => {
  it('reserves output globals', () => {
    expect([...RESERVED_BINDING_GLOBALS]).toEqual(['console', 'inspect', 'Image'])
  })

  it('reserves Error presentation fields', () => {
    expect([...RESERVED_ERROR_MEMBERS]).toEqual(['name', 'message', 'stack'])
  })

  it('reserves ECMAScript keywords and strict-mode names', () => {
    for (const name of ['function', 'class', 'await', 'eval', 'arguments']) {
      expect(RESERVED_BINDING_WORDS.has(name)).toBe(true)
    }
    for (const name of ['tools', 'lambda', 'nonlocal', 'type', '_']) {
      expect(RESERVED_BINDING_WORDS.has(name)).toBe(false)
    }
  })
})
