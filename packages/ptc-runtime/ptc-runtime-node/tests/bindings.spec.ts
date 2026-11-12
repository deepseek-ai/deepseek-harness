import { describe, expect, it } from 'vitest'
import { validateBindings } from '../src/bindings.ts'

const INVALID_ARGUMENT = { name: 'PtcRuntimeError', code: 'PTC_RUNTIME_INVALID_ARGUMENT' }

describe('program binding validation', () => {
  it.each(['a-b', '', 'while', 'eval', 'console'])('rejects unusable global %s', (global) => {
    expect(() => validateBindings({ program: '', bindings: [{ global, functions: {} }] })).toThrow(expect.objectContaining(INVALID_ARGUMENT))
  })
  it.each(['$name', 'lambda', 'nonlocal', '__dsh_main__', '__builtins__', '__name__', '__debug__'])('accepts TypeScript global and error class %s', (name) => {
    expect(validateBindings({ program: '', bindings: [{ global: name, functions: {} }] }).has(name)).toBe(true)
    expect(validateBindings({ program: '', bindings: [{ global: 'tools', functions: {}, errorClass: { name, memberNameProperty: 'member' } }] }).has('tools')).toBe(true)
  })
  it.each(['args', 'with_traceback', 'add_note', '__member__', '__proto__'])('accepts own error member %s', (memberNameProperty) => {
    expect(validateBindings({ program: '', bindings: [{ global: 'tools', functions: {}, errorClass: { name: 'ToolError', memberNameProperty } }] }).has('tools')).toBe(true)
  })
  it('rejects duplicated globals and accepts arbitrary own member names', () => {
    const functions = Object.create(null) as Record<string, () => Promise<string>>
    functions.__proto__ = async () => 'own'
    expect(validateBindings({ program: '', bindings: [{ global: 'tools', functions }] }).get('tools')?.functions).toBe(functions)
    expect(() => validateBindings({ program: '', bindings: [{ global: 'tools', functions }, { global: 'tools', functions }] })).toThrow('duplicate')
  })
  it.each(['a-b', 'while', 'console', 'tools'])('rejects invalid error class name %s', (name) => {
    expect(() => validateBindings({ program: '', bindings: [{ global: 'tools', functions: {}, errorClass: { name, memberNameProperty: 'member' } }] })).toThrow(expect.objectContaining(INVALID_ARGUMENT))
  })
  it.each(['', 'name', 'message', 'stack'])('rejects invalid error member %s', (memberNameProperty) => {
    expect(() => validateBindings({ program: '', bindings: [{ global: 'tools', functions: {}, errorClass: { name: 'ToolError', memberNameProperty } }] })).toThrow(expect.objectContaining(INVALID_ARGUMENT))
  })
  it('rejects two injected constructors with the same name', () => {
    expect(() => validateBindings({ program: '', bindings: ['first', 'second'].map(global => ({ global, functions: {}, errorClass: { name: 'ToolError', memberNameProperty: 'member' } })) })).toThrow('duplicate')
  })
})
