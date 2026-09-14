/**
 * Persistent append-only lists with bounded copying and JSON checkpoint validation.
 * @module @deepseek-ai/dsh-chunked-list
 */

import { z } from 'zod'

const CHUNK_CAPACITY = 64

/**
 * Newest chunk of an immutable list; `undefined` represents the empty list.
 * Values within each chunk follow insertion order. Callers treat nodes, arrays,
 * and stored values as immutable; operations share values and older chunks.
 */
export interface ChunkedList<T> {
  readonly values: readonly T[]
  readonly previous?: ChunkedList<T> | undefined
}

/**
 * Append without modifying the input, copying at most one 64-value chunk.
 * @param head - current list, or `undefined` for an empty list.
 * @param value - value to retain by reference.
 * @returns new list sharing the unchanged older chunks.
 */
export function appendChunkedList<T>(head: ChunkedList<T> | undefined, value: T): ChunkedList<T> {
  if (head === undefined || head.values.length === CHUNK_CAPACITY) {
    return { values: [value], ...head === undefined ? {} : { previous: head } }
  }
  return {
    values: [...head.values, value],
    ...head.previous === undefined ? {} : { previous: head.previous },
  }
}

/**
 * Visit all values in insertion order, with O(N) time and O(N / 64) scratch space.
 * @param head - current list, or `undefined` for an empty list.
 * @returns iterator yielding the stored values by reference, without truncation.
 */
export function* iterateChunkedList<T>(head: ChunkedList<T> | undefined): Generator<T> {
  const chunks: ChunkedList<T>[] = []
  for (let chunk = head; chunk !== undefined; chunk = chunk.previous) chunks.push(chunk)
  for (const chunk of chunks.reverse()) yield* chunk.values
}

/**
 * Validate nonempty list checkpoints, including every stored value and chunk size.
 * @param valueSchema - caller-owned validation for each stored value.
 * @returns recursive Zod schema rejecting empty or oversized chunks and unknown fields.
 */
export function chunkedListSchema<T>(valueSchema: z.ZodType<T>): z.ZodType<ChunkedList<T>> {
  const schema: z.ZodType<ChunkedList<T>> = z.lazy(() => z.object({
    values: z.array(valueSchema).min(1).max(CHUNK_CAPACITY),
    previous: schema.optional(),
  }).strict())
  return schema
}
