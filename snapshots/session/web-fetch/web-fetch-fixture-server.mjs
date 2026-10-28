/**
 * Deterministic HTTP provider for the web-fetch snapshot scenario: a small
 * UTF-8 HTML page with a malformed charset declaration on an
 * OS-assigned loopback port behind the real HTTP transport. Recording
 * and replay therefore exercise fetch and markdown rendering without external
 * network while retaining the recorded request URL.
 */
import { HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'
import { applyLoopbackServerEffect } from '../loopback-fixture-server.mjs'

/** Model-visible URL retained by the recorded session. */
const RECORDED_URL = 'http://public.test:43117/menu.html'

const PAGE = `<!doctype html>
<html><head><title>Menu</title><style>.x{color:red}</style><script>ignored()</script></head>
<body>
<h1>Café menu</h1>
<p>Prices include <strong>service &amp; <em>tax</em></strong> &mdash; updated daily.</p>
<ul><li>Espresso</li><li>Flat white</li></ul>
<table><thead><tr><th>Drink</th><th>Price</th></tr></thead><tbody><tr><td>Espresso</td><td>€2</td></tr><tr><td>Flat white</td><td>€3</td></tr></tbody></table>
<p>See <a href="https://fixture.invalid/specials">today&rsquo;s specials</a>.</p>
</body></html>
`

/** Cordis plugin name. */
export const name = 'web-fetch-fixture-server'

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
      label: 'web-fetch-fixture-server',
      requestListener: (req, res) => {
        if (req.url === '/menu.html') {
          res.writeHead(200, { 'content-type': 'text/html; charset=gbk,utf-8' })
          res.end(PAGE)
          return
        }
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
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
