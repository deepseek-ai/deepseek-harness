import { describe, expect, it } from 'vitest'
import { pool } from '../src/pool.ts'

describe('bounded concurrency', () => {
  it('runs every item with at most the limit at once', async () => {
    let running = 0
    let peak = 0
    const done: number[] = []
    await pool([1, 2, 3, 4, 5], 2, async (item) => {
      running++
      peak = Math.max(peak, running)
      await new Promise(resolve => setTimeout(resolve, 5))
      done.push(item)
      running--
    })
    expect(done.sort()).toEqual([1, 2, 3, 4, 5])
    expect(peak).toBe(2)
  })

  it('finishes every task, then rejects with the first rejection', async () => {
    const done: number[] = []
    await expect(pool([1, 2, 3], 3, async (item) => {
      if (item === 2) throw new Error('second failed')
      await new Promise(resolve => setTimeout(resolve, 5))
      done.push(item)
    })).rejects.toThrow('second failed')
    expect(done.sort()).toEqual([1, 3])
  })

  it('does nothing without items', async () => {
    await expect(pool([], 4, async () => { throw new Error('not run') })).resolves.toBeUndefined()
  })
})
