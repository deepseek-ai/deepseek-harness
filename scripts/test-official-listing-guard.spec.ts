/** Unit suites cannot reach the official DeepSeek model listing unless they answer `fetch` themselves. */
import { createServer } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import type { Server } from 'node:http'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

it.each([
  ['string', () => fetch('https://api.deepseek.com/models')],
  ['URL', () => fetch(new URL('https://api.deepseek.com/models'))],
  ['Request', () => fetch(new Request('https://api.deepseek.com/models', { headers: { 'x-api-key': 'fixture-key' } }))],
])('rejects the official model listing given as a %s', async (_kind, request) => {
  await expect(request()).rejects.toThrow('unit suites do not reach https://api.deepseek.com/models; answer it with a fetch stub')
})

it('passes every other request to the ambient fetch', async () => {
  const server = createServer((_request, response) => { response.end('local') })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  await expect((await fetch(`http://127.0.0.1:${address.port}/models`)).text()).resolves.toBe('local')
})
