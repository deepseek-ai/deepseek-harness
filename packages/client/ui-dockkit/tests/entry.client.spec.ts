/** The `immediately` row registers nothing on either face, and the Host entry holds nothing but `apply`. */
import { expect, it } from 'vitest'
import * as client from '../src/client/index.ts'

it('registers nothing on either face', async () => {
  // The Host entry is hand-written JavaScript without declarations, so the spec imports it by URL.
  const host = await import(/* @vite-ignore */ new URL('../src/index.js', import.meta.url).href) as Record<string, unknown>
  expect(Object.keys(host)).toEqual(['apply'])
  expect(host.apply).toBeTypeOf('function')
  expect(host.apply).not.toThrow()
  expect(client.apply).not.toThrow()
})
