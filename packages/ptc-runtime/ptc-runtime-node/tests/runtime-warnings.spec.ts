import { expect, it, vi } from 'vitest'
import { filterRuntimeWarnings, quietRuntimeCall } from '../src/environment.ts'

const LOADER_WARNING = 'vm.USE_MAIN_CONTEXT_DEFAULT_LOADER is an experimental feature and might change at any time'
const STRIP_WARNING = 'stripTypeScriptTypes is an experimental feature and might change at any time'

it('drops the runtime\'s own experimental warnings in the child and forwards other warnings unchanged', () => {
  const emitWarning = vi.fn()
  const state = { emitWarning: emitWarning as typeof process.emitWarning }
  filterRuntimeWarnings(state)
  state.emitWarning(LOADER_WARNING, 'ExperimentalWarning')
  state.emitWarning(new Error(STRIP_WARNING))
  const program = new Error('program warning')
  state.emitWarning('other warning', 'Warning', 'CODE')
  state.emitWarning(program)
  Reflect.apply(state.emitWarning, state, [42])
  expect(emitWarning.mock.calls).toEqual([['other warning', 'Warning', 'CODE'], [program], [42]])
  expect(emitWarning.mock.contexts).toEqual([state, state, state])
})

it('leaves process doubles without a warning emitter unchanged', () => {
  const state: { emitWarning?: typeof process.emitWarning } = {}
  filterRuntimeWarnings(state)
  expect(state).toEqual({})
})

it('drops the runtime\'s own warnings only during a quiet host call and restores the emitter afterward', () => {
  const original = Object.getOwnPropertyDescriptor(process, 'emitWarning')
  const emitWarning = vi.fn()
  process.emitWarning = emitWarning as typeof process.emitWarning
  try {
    expect(quietRuntimeCall(() => {
      process.emitWarning(STRIP_WARNING, 'ExperimentalWarning')
      process.emitWarning('other warning')
      return 'result'
    })).toBe('result')
    expect(Object.getOwnPropertyDescriptor(process, 'emitWarning')?.value).toBe(emitWarning)
    expect(() => quietRuntimeCall(() => { throw new Error('call failed') })).toThrow('call failed')
    expect(Object.getOwnPropertyDescriptor(process, 'emitWarning')?.value).toBe(emitWarning)
    process.emitWarning(STRIP_WARNING)
    expect(emitWarning.mock.calls).toEqual([['other warning'], [STRIP_WARNING]])
  } finally {
    if (original !== undefined) Object.defineProperty(process, 'emitWarning', original)
  }
})
