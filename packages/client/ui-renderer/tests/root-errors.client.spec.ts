/**
 * Root error capture: errors React 19 reports through `onUncaughtError` fail the
 * root operation that caused them, as React 18's thrown errors do, and errors
 * outside an operation reach `reportError`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RootErrorCapture } from '../src/client/root-errors.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('RootErrorCapture', () => {
  it('returns the operation result when nothing fails', () => {
    expect(new RootErrorCapture().run(() => 7)).toBe(7)
  })

  it('throws an error reported during the operation', () => {
    const capture = new RootErrorCapture()
    const failure = new Error('render failed')
    let thrown: unknown
    try {
      capture.run(() => { capture.options.onUncaughtError(failure) })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBe(failure)
  })

  it('throws an error thrown by the operation, as React 18 does', () => {
    const failure = new Error('render failed')
    expect(() => new RootErrorCapture().run(() => { throw failure })).toThrow(failure)
  })

  it('aggregates thrown and reported errors in order', () => {
    const capture = new RootErrorCapture()
    const thrown = new Error('thrown')
    const first = new Error('first reported')
    const second = new Error('second reported')
    let failure: unknown
    try {
      capture.run(() => {
        capture.options.onUncaughtError(first)
        capture.options.onUncaughtError(second)
        throw thrown
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([thrown, first, second])
  })

  it('reports errors outside an operation through reportError', () => {
    const reportError = vi.fn()
    vi.stubGlobal('reportError', reportError)
    const capture = new RootErrorCapture()
    const late = new Error('later update failed')
    capture.run(() => undefined)
    capture.options.onUncaughtError(late)
    expect(reportError).toHaveBeenCalledWith(late)
  })

  it('returns reports to the enclosing operation after a nested one', () => {
    const capture = new RootErrorCapture()
    const failure = new Error('outer failed')
    let thrown: unknown
    try {
      capture.run(() => {
        capture.run(() => undefined)
        capture.options.onUncaughtError(failure)
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBe(failure)
  })
})
