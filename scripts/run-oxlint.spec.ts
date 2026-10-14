import { describe, expect, it } from 'vitest'
import { resolveOxlintInvocation } from './run-oxlint.ts'

describe('Oxlint invocation', () => {
  it('keeps Oxlint\'s own worker default in CI', () => {
    expect(resolveOxlintInvocation(['.'], { CI: 'true', PATH: '/bin' }, 256)).toEqual({
      args: ['.', '--format=default'],
      env: { CI: 'true', PATH: '/bin' },
    })
  })

  it('bounds local invocations by the local worker budget', () => {
    expect(resolveOxlintInvocation(['.'], { PATH: '/bin' }, 256)).toEqual({
      args: ['.', '--threads=12'],
      env: { PATH: '/bin', GOMAXPROCS: '12' },
    })
    expect(resolveOxlintInvocation(['.'], {}, 4).args).toEqual(['.', '--threads=4'])
  })

  it('passes a caller\'s own worker bound through without the environment setting', () => {
    expect(resolveOxlintInvocation(['.', '--threads=2'], { PATH: '/bin' }, 256)).toEqual({
      args: ['.', '--threads=2'],
      env: { PATH: '/bin' },
    })
  })

  it('bounds both worker pools from one setting', () => {
    expect(resolveOxlintInvocation(['.', '--fix'], { DSH_OXLINT_THREADS: '4', GOMAXPROCS: '12' })).toEqual({
      args: ['.', '--fix', '--threads=4'],
      env: { DSH_OXLINT_THREADS: '4', GOMAXPROCS: '4' },
    })
  })

  it('uses location-preserving diagnostics in CI', () => {
    expect(resolveOxlintInvocation(['.'], { CI: 'true', DSH_OXLINT_THREADS: '4' })).toEqual({
      args: ['.', '--format=default', '--threads=4'],
      env: { CI: 'true', DSH_OXLINT_THREADS: '4', GOMAXPROCS: '4' },
    })
  })

  it('preserves an explicitly selected CI formatter', () => {
    expect(resolveOxlintInvocation(['.', '--format', 'github'], { CI: 'true' }).args)
      .toEqual(['.', '--format', 'github'])
  })

  it.each(['0', '-1', '1.5', 'auto'])('rejects invalid worker bound %s', (value) => {
    expect(() => resolveOxlintInvocation(['.'], { DSH_OXLINT_THREADS: value }))
      .toThrow('DSH_OXLINT_THREADS must be a positive integer')
  })

  it('rejects a competing direct worker bound', () => {
    expect(() => resolveOxlintInvocation(['.', '--threads=2'], { DSH_OXLINT_THREADS: '4' }))
      .toThrow('use DSH_OXLINT_THREADS instead')
  })
})
