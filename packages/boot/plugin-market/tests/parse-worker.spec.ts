/** The source-mode parse Worker, run end to end. */
import { expect, it } from 'vitest'
import { parseIndexInWorker } from '../src/parse-thread.ts'

const URL_A = 'https://market.example/index.json'
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

it('parses a body in a Worker and transfers its buffer', async () => {
  const body = bytes(JSON.stringify({ format: 1, title: 'M', plugins: [] }))
  const result = await parseIndexInWorker(body, URL_A, new AbortController().signal)
  expect(result).toMatchObject({ ok: true, index: { title: 'M', plugins: [] } })
  expect(body.byteLength).toBe(0)
  expect(await parseIndexInWorker(bytes('{'), URL_A, new AbortController().signal)).toMatchObject({ ok: false, path: '$' })
})
