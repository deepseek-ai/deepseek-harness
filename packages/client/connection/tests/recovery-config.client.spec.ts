/** Recovery timing validation before a loop or Host bootstrap is published. */
import { describe, expect, it } from 'vitest'
import { resolveConnectionConfig } from '../src/recovery-config.ts'

describe('connection recovery configuration', () => {
  it('separates the slow-Host warning from the hard handshake deadline', () => {
    expect(resolveConnectionConfig()).toEqual({
      backoffBaseMs: 500,
      backoffFactor: 2,
      backoffMaxMs: 10_000,
      generationReadyWarnMs: 3_000,
      generationReadyTimeoutMs: 15_000,
    })
  })

  it.each([
    { backoffBaseMs: 0 },
    { backoffFactor: 0.5 },
    { backoffFactor: Infinity },
    { backoffFactor: NaN },
    { backoffMaxMs: -1 },
    { generationReadyWarnMs: NaN },
    { generationReadyTimeoutMs: 2_147_483_648 },
    { generationReadyTimeoutMs: '15000' },
  ])('rejects timing that could disable recovery or overflow a timer: %j', (config) => {
    expect(() => resolveConnectionConfig(config)).toThrow()
  })

  it('preserves a finite fractional growth factor', () => {
    expect(resolveConnectionConfig({ backoffFactor: 1.5 }).backoffFactor).toBe(1.5)
  })
})
