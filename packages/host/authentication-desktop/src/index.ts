/** Desktop's private credential verifier, registered as an ordinary Connection provider. */
import { timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'

/** Stable plugin name. */
export const name = 'host-authentication-desktop'
/** Connection creates Peers; ConnectionAuthentication owns credential verifiers. */
export const inject = ['connection', 'connection.authentication']

/** In-memory startup input supplied by the Desktop process owner. */
export interface Config {
  /** Read the credential already validated on the private parent IPC channel. */
  readSecret: () => string
}

/**
 * Own one Desktop Peer and the verifier accepting its private credential.
 * The credential flows only between the Electron main process and its owned Host, never into the browser cookie jar.
 * @param ctx - plugin scope owning the Peer and registration.
 * @param config - in-memory credential reader from the Desktop startup owner.
 */
export function apply(ctx: Context, config: Config): void {
  const expected = Buffer.from(config.readSecret(), 'ascii')
  const peer = ctx.connection.createPeer({ principal: { kind: 'owner' } })
  ctx.connection.authentication.register({
    authenticate(request) {
      const cookie = request.headers instanceof Headers ? request.headers.get('cookie') : request.headers.cookie
      if (typeof cookie !== 'string') return undefined
      let value: string | undefined
      for (const part of cookie.split(';')) {
        const equals = part.indexOf('=')
        if (equals < 0 || part.slice(0, equals).trim() !== 'dsh-desktop-session') continue
        if (value !== undefined) return undefined
        value = part.slice(equals + 1).trim()
      }
      if (value === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(value)) return undefined
      const actual = Buffer.from(value, 'ascii')
      return actual.length === expected.length && timingSafeEqual(actual, expected) ? peer : undefined
    },
  })
}
