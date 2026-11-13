/**
 * Deterministic transport failure for the web-fetch-transport-failure snapshot scenario: an
 * OS-assigned loopback server closes each connection once the request arrives, behind the real
 * HTTP transport. Replay therefore reaches the model-visible failure text without external network
 * while retaining the recorded request URL.
 */
import { HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'
import { applyLoopbackServerEffect } from '../loopback-fixture-server.mjs'

/** Model-visible URL retained by the recorded session. */
const RECORDED_URL = 'http://public.test:43117/menu.html'

/** Cordis plugin name. */
export const name = 'web-fetch-transport-failure-fixture'

/** Service used by the fixture provider. */
export const inject = ['web']

const LIMITS = {
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 30_000,
  maxRedirects: 5,
  userAgent: 'deepseek-harness-snapshot/1.0',
}

/**
 * Register the deterministic provider and start its loopback server.
 * @param ctx - Cordis context; the effect disposes the server with the fiber.
 */
export async function apply(ctx) {
  const readiness = Promise.withResolvers()
  let transportUrl
  let startupError

  const provider = new HttpFetchProvider(LIMITS)
  const unregister = ctx.web.registerFetchProvider({
    id: provider.id,
    available: () => provider.available(),
    fetch: async (request, signal) => {
      if (request.url !== RECORDED_URL) throw new Error(`unexpected snapshot URL: ${request.url}`)
      await readiness.promise
      if (startupError !== undefined) throw startupError
      const result = await provider.fetch({ url: transportUrl.toString() }, signal)
      return { ...result, url: RECORDED_URL }
    },
  })
  try {
    await applyLoopbackServerEffect(ctx, {
      label: 'web-fetch-transport-failure-fixture',
      requestListener: (req) => {
        req.socket.end()
      },
      onListening: (address) => {
        transportUrl = new URL(RECORDED_URL)
        transportUrl.hostname = '127.0.0.1'
        transportUrl.port = String(address.port)
        readiness.resolve(undefined)
      },
      onCleanup: () => {
        unregister()
      },
    })
  } catch (cause) {
    startupError = cause
    readiness.resolve(undefined)
    throw cause
  }
}
