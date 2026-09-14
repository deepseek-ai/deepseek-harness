import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { appendChunkedList, chunkedListSchema, iterateChunkedList } from '../src/index.ts'
import type { ChunkedList } from '../src/index.ts'

describe('persistent chunked list', () => {
  it('iterates an empty list and retains undefined values', () => {
    expect([...iterateChunkedList(undefined)]).toEqual([])
    const head = appendChunkedList(undefined, undefined)
    expect([...iterateChunkedList(head)]).toEqual([undefined])
  })

  it('keeps every prefix unchanged across chunk rollovers and divergent appends', () => {
    let head: ChunkedList<number> | undefined
    const prefixes: ChunkedList<number>[] = []
    for (let value = 0; value < 200; value += 1) {
      head = appendChunkedList(head, value)
      Object.freeze(head.values)
      Object.freeze(head)
      prefixes.push(head)
    }
    for (const [index, prefix] of prefixes.entries()) {
      expect([...iterateChunkedList(prefix)]).toEqual(Array.from({ length: index + 1 }, (_, i) => i))
    }
    expect(prefixes[64]?.previous).toBe(prefixes[63])
    expect(prefixes[65]?.previous).toBe(prefixes[63])
    expect([...iterateChunkedList(appendChunkedList(prefixes[64], -1))])
      .toEqual([...Array.from({ length: 65 }, (_, i) => i), -1])
    expect([...iterateChunkedList(prefixes[65])]).toEqual(Array.from({ length: 66 }, (_, i) => i))
  })

  it('retains stored objects by reference', () => {
    const value = Object.freeze({ id: 'first' })
    expect([...iterateChunkedList(appendChunkedList(undefined, value))][0]).toBe(value)
  })

  it('restores JSON checkpoints and appends at and after rollover', () => {
    const schema = chunkedListSchema(z.number())
    let head: ChunkedList<number> | undefined
    for (let value = 0; value < 130; value += 1) {
      head = appendChunkedList(head, value)
      head = schema.parse(JSON.parse(JSON.stringify(head)))
    }
    expect([...iterateChunkedList(head)]).toEqual(Array.from({ length: 130 }, (_, i) => i))
  })

  it.each([
    { values: [] },
    { values: Array.from({ length: 65 }, () => 0) },
    { values: ['invalid'] },
    { values: [0], extra: true },
    { values: [0], previous: { values: [] } },
    { values: [0], previous: { values: Array.from({ length: 65 }, () => 0) } },
    { values: [0], previous: { values: ['invalid'] } },
    { values: [0], previous: { values: [1], extra: true } },
  ])('rejects an invalid checkpoint: %j', (checkpoint) => {
    expect(() => chunkedListSchema(z.number()).parse(checkpoint)).toThrow(z.ZodError)
  })
})
