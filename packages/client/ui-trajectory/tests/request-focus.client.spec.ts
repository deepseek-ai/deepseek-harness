import { describe, expect, it } from 'vitest'
import { parseRequestFocus, requestFocus } from '../src/client/request-focus.ts'

describe('Trajectory request focus', () => {
  it('round-trips a model request address', () => {
    expect(parseRequestFocus(requestFocus(3, 2))).toEqual({ turn: 3, step: 2 })
  })

  it.each([
    ['a tool-call id', 'call-1'],
    ['a missing step', 'request\u00003'],
    ['a non-integer step', 'request\u00003\u0000x'],
  ])('reads %s as no request', (_label, focus) => {
    expect(parseRequestFocus(focus)).toBeNull()
  })
})
