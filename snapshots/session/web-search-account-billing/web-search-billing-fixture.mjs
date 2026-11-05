/**
 * Signed-in DeepSeek account stand-in and Search API endpoint for the billing snapshots. The account releases one fixed
 * token, and the endpoint answers only a request that carries that token and no API key.
 */
import { applyLoopbackServerEffect } from '../loopback-fixture-server.mjs'

/** Search endpoint under the default account route origin, routed to the current loopback listener. */
const RECORDED_ENDPOINT = 'https://api.deepseek.com/v1/tools/search'

/** Token the stand-in account releases. */
const ACCOUNT_TOKEN = 'snapshot-account-token'

/** Cordis plugin name. */
export const name = 'web-search-billing-fixture'

function requestUrl(input) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input instanceof Request) return input.url
  return undefined
}

function transportInput(input, transportEndpoint) {
  const url = requestUrl(input)
  if (url === RECORDED_ENDPOINT) {
    return input instanceof Request ? new Request(transportEndpoint, input) : transportEndpoint
  }
  if (url !== undefined && url.startsWith('https://api.deepseek.com/')) {
    throw new Error(`web-search-billing-fixture: unexpected DeepSeek request: ${url}`)
  }
  return input
}

/** Provide the signed-in account and start the Search endpoint; both end with the plugin fiber. */
export async function apply(ctx) {
  ctx.provide('deepseekAccount', {
    resolveToken: async endpoint => endpoint.startsWith('https://api.deepseek.com/') ? ACCOUNT_TOKEN : undefined,
    rejectToken: async () => {},
  })
  let restoreFetch = () => {}
  await applyLoopbackServerEffect(ctx, {
    label: 'web-search-billing-fixture',
    requestListener: (request, response) => {
      if (request.method === 'POST' && request.url === '/v1/tools/search') {
        if (request.headers['x-dsh-auth-token'] !== ACCOUNT_TOKEN || request.headers.authorization !== undefined) {
          response.writeHead(401, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { message: 'expected only the account token' } }))
          return
        }
        request.resume()
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          results: [{
            url: 'https://billing.example.test/guide', title: 'Billing guide', snippet: 'Account billing for web search.',
            summary: 'Web search bills the signed-in account.', date: null,
          }],
        }))
        return
      }
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found')
    },
    onListening: (address) => {
      const transportEndpoint = `http://127.0.0.1:${String(address.port)}/v1/tools/search`
      const originalFetch = globalThis.fetch
      const fixtureFetch = async (input, init) => originalFetch(transportInput(input, transportEndpoint), init)
      globalThis.fetch = fixtureFetch
      restoreFetch = () => {
        if (globalThis.fetch !== fixtureFetch) {
          throw new Error('web-search-billing-fixture: global fetch owner changed before cleanup')
        }
        globalThis.fetch = originalFetch
      }
    },
    onCleanup: () => restoreFetch(),
  })
}
