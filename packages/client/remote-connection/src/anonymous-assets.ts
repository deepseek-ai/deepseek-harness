/** Public pairing script served before the authenticated application loads. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { renderPairingScript } from './anonymous/index.ts'
import type { PairingRecovery } from './anonymous/pairing.ts'

/**
 * Register the generated script in the Remote plugin's lifetime.
 * @param ctx - plugin scope containing the HTTP listener.
 * @param recovery - validated public timing and recovery limits.
 */
export function registerAnonymousPairing(ctx: Context, recovery: PairingRecovery): void {
  const script = renderPairingScript(recovery)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/pairing/client.js', auth: 'anonymous',
    handler(request, response) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { allow: 'GET, HEAD' })
        response.end()
        return
      }
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      })
      response.end(request.method === 'HEAD' ? undefined : script)
    },
  }))
}
