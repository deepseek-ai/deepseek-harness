/** Frames of whole samples from a byte stream that splits anywhere. */
import { expect, it } from 'vitest'
import { pcmFrames } from '../src/frames.ts'

async function frames(chunks: number[][], frameBytes: number): Promise<number[][]> {
  const source = (async function* () { for (const chunk of chunks) yield new Uint8Array(chunk) })()
  const out: number[][] = []
  for await (const frame of pcmFrames(source, frameBytes)) out.push([...frame])
  return out
}

it('emits full frames across chunk borders and then the remaining whole samples', async () => {
  expect(await frames([[1, 2, 3], [4, 5, 6, 7], [8, 9, 10]], 4)).toEqual([[1, 2, 3, 4], [5, 6, 7, 8], [9, 10]])
  expect(await frames([[1, 2, 3, 4, 5, 6, 7, 8]], 4)).toEqual([[1, 2, 3, 4], [5, 6, 7, 8]])
})

it('drops a final odd byte and emits nothing for an empty stream', async () => {
  expect(await frames([[1, 2, 3], [4, 5]], 4)).toEqual([[1, 2, 3, 4]])
  expect(await frames([[1]], 4)).toEqual([])
  expect(await frames([], 4)).toEqual([])
})
