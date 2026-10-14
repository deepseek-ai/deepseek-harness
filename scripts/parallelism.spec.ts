import { describe, expect, it } from 'vitest'
import { LOCAL_PARALLELISM_CAP, LOCAL_TEST_PARALLELISM_CAP, defaultParallelism, describeDefaultParallelism } from './parallelism.ts'

describe('default worker budget', () => {
  it('uses every reported CPU in CI', () => {
    expect(defaultParallelism({ CI: 'true' }, 256)).toBe(256)
    expect(describeDefaultParallelism({ CI: 'true' }, 16)).toBe('16 available CPU(s)')
  })

  it('caps local runs without exceeding the reported CPUs', () => {
    expect(LOCAL_PARALLELISM_CAP).toBe(12)
    expect(defaultParallelism({}, 256)).toBe(12)
    expect(defaultParallelism({ CI: 'false' }, 256)).toBe(12)
    expect(defaultParallelism({}, 4)).toBe(4)
    expect(describeDefaultParallelism({}, 256)).toBe('12 local default worker(s) of 256 CPU(s)')
  })

  it('lets Vitest forks use a larger local cap', () => {
    expect(LOCAL_TEST_PARALLELISM_CAP).toBe(48)
    expect(defaultParallelism({}, 256, LOCAL_TEST_PARALLELISM_CAP)).toBe(48)
    expect(defaultParallelism({ CI: 'true' }, 256, LOCAL_TEST_PARALLELISM_CAP)).toBe(256)
  })
})
