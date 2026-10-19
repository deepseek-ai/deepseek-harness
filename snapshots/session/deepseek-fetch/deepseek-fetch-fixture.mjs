/** Dedicated Fetch API response for the recorded retrieval scenario. */
import { applyLoopbackServerEffect } from '../loopback-fixture-server.mjs'

/** Stable fixture endpoint routed to the current loopback listener. */
const RECORDED_ENDPOINT = 'http://127.0.0.1:43118/api/v1/tools/fetch'
const RECORDED_URL = new URL(RECORDED_ENDPOINT)

/** Cordis plugin name. */
export const name = 'deepseek-fetch-fixture'

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
  if (url === undefined) return input
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return input
  }
  if (parsed.host === RECORDED_URL.host) {
    throw new Error(`deepseek-fetch-fixture: unexpected URL for recorded authority: ${url}`)
  }
  return input
}

/** Start the local Fetch endpoint and stop it with the plugin fiber. */
export async function apply(ctx) {
  let restoreFetch = () => {}
  await applyLoopbackServerEffect(ctx, {
    label: 'deepseek-fetch-fixture',
    requestListener: (request, response) => {
      if (request.method === 'POST' && request.url === '/api/v1/tools/fetch') {
        if (request.headers.authorization !== 'Bearer snapshot-key') {
          response.writeHead(401).end()
          return
        }
        request.resume()
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ title: 'Menu', content: '# Menu\n\nTea — $2' }))
        return
      }
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found')
    },
    onListening: (address) => {
      const transportEndpoint = `http://127.0.0.1:${String(address.port)}/api/v1/tools/fetch`
      const originalFetch = globalThis.fetch
      const fixtureFetch = async (input, init) => originalFetch(transportInput(input, transportEndpoint), init)
      globalThis.fetch = fixtureFetch
      restoreFetch = () => {
        if (globalThis.fetch !== fixtureFetch) {
          throw new Error('deepseek-fetch-fixture: global fetch owner changed before cleanup')
        }
        globalThis.fetch = originalFetch
      }
    },
    onCleanup: () => restoreFetch(),
  })
}
