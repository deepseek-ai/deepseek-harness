import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('session-log upload configuration', () => {
  it.each([
    { lane: 'ordinary process', vitest: undefined, snapshot: undefined, enabled: true },
    { lane: 'Vitest', vitest: 'true', snapshot: undefined, enabled: true },
    { lane: 'snapshot process', vitest: undefined, snapshot: '1', enabled: true },
    { lane: 'Vitest snapshot', vitest: 'true', snapshot: '1', enabled: true },
    { lane: 'empty Vitest marker', vitest: '', snapshot: undefined, enabled: true },
    { lane: 'empty snapshot marker', vitest: undefined, snapshot: '', enabled: true },
  ])('defaults upload for $lane and honors explicit overrides', async ({ vitest, snapshot, enabled }) => {
    vi.stubEnv('VITEST', vitest)
    vi.stubEnv('DSH_SNAPSHOT', snapshot)
    try {
      // Import under each environment to catch environment-dependent schema defaults.
      vi.resetModules()
      const { Config } = await import('../src/index.ts')
      expect(Config({}).enabled).toBe(enabled)
      expect(Config({ enabled: true }).enabled).toBe(true)
      expect(Config({ enabled: false }).enabled).toBe(false)
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })
})

describe('session-log upload byte limit', () => {
  it('defaults each request to 8 MiB and accepts only positive integer limits', async () => {
    const { Config } = await import('../src/index.ts')
    expect(Config({}).maxBytes).toBe(8 * 1024 * 1024)
    expect(Config({ maxBytes: 1 }).maxBytes).toBe(1)
    for (const maxBytes of [0, -1, 1.5]) expect(() => Config({ maxBytes })).toThrow()
  })
})
