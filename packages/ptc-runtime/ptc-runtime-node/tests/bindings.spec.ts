import { describe, expect, it } from 'vitest'
import { validateBindings } from '../src/bindings.ts'

describe('program binding validation', () => {
  it.each(['$name', '', 'while', 'lambda', 'console'])('rejects unusable global %s', (global) => {
    expect(() => validateBindings({ program: '', bindings: [{ global, functions: {} }] })).toThrow()
  })
  it('rejects duplicated globals and accepts arbitrary own member names', () => {
    const functions = Object.create(null) as Record<string, () => Promise<string>>
    functions.__proto__ = async () => 'own'
    expect(validateBindings({ program: '', bindings: [{ global: 'tools', functions }] }).get('tools')?.functions).toBe(functions)
    expect(() => validateBindings({ program: '', bindings: [{ global: 'tools', functions }, { global: 'tools', functions }] })).toThrow('duplicate')
  })
  it.each(['$name', 'while', 'console', 'tools'])('rejects invalid error class name %s', (name) => {
    expect(() => validateBindings({ program: '', bindings: [{ global: 'tools', functions: {}, errorClass: { name, memberNameProperty: 'member' } }] })).toThrow()
  })
  it.each(['', 'name', '__member__'])('rejects invalid error member %s', (memberNameProperty) => {
    expect(() => validateBindings({ program: '', bindings: [{ global: 'tools', functions: {}, errorClass: { name: 'ToolError', memberNameProperty } }] })).toThrow()
  })
  it('rejects two injected constructors with the same name', () => {
    expect(() => validateBindings({ program: '', bindings: ['first', 'second'].map(global => ({ global, functions: {}, errorClass: { name: 'ToolError', memberNameProperty: 'member' } })) })).toThrow('duplicate')
  })
})
