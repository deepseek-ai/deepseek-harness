import { describe, expect, it } from 'vitest'
import { HarnessError } from '../src/index.ts'

class SampleError extends HarnessError {}

describe('HarnessError', () => {
  it('carries a code, a cause, and the constructing class name', () => {
    const cause = new Error('underlying failure')
    const error = new SampleError('operation failed', 'SAMPLE_FAILED', { cause })

    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(HarnessError)
    expect(error).toMatchObject({ name: 'SampleError', code: 'SAMPLE_FAILED', message: 'operation failed', cause })
  })

  it('names a direct instance HarnessError', () => {
    expect(new HarnessError('failed', 'FAILED').name).toBe('HarnessError')
  })
})
