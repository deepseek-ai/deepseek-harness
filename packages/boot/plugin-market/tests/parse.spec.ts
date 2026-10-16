/** Index body parsing as the parse Worker runs it. */
import { expect, it } from 'vitest'
import { parseIndexBody } from '../src/parse.ts'

const URL_A = 'https://market.example/index.json'
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

it('validates a body and resolves relative icons against the index URL', () => {
  const body = { format: 1, title: 'M', plugins: [{ name: 'p', icon: 'p.svg', versions: [{ version: '1.0.0', publishTimestamp: 1, source: { type: 'npm' } }] }] }
  const result = parseIndexBody(bytes(JSON.stringify(body)), URL_A)
  expect(result.ok && result.index.plugins[0]?.icon).toBe('https://market.example/p.svg')
})

it.each([
  ['malformed UTF-8', new Uint8Array([0xff, 0xfe]), { path: '$', reason: 'must be UTF-8', message: 'must be UTF-8' }],
  ['malformed JSON', bytes('{'), { path: '$', reason: expect.stringMatching(/^must be JSON: /) as string }],
  ['a format violation', bytes('{"format":2}'), { path: '$.format', reason: 'must be 1', message: '$.format must be 1' }],
])('reports %s', (_label, body, failure) => {
  expect(parseIndexBody(body, URL_A)).toMatchObject({ ok: false, ...failure })
})
