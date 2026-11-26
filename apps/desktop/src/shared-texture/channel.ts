/**
 * Main's endpoint of the `shared-texture` control exchange on each Desktop Host child-process channel. Host messages
 * are untrusted: this module validates the envelope and the request before Main's handler sees them. Frames and their
 * replies use the native ingress instead.
 */
import { z } from 'zod'
import type { DesktopHostChannel, DesktopHostChild } from '../host-process.ts'
import type { SharedTextureHostLink } from './presenter.ts'
import type {
  SharedTextureHostMessage, SharedTextureHostRequest, SharedTextureMainReply,
} from '@deepseek-ai/dsh-desktop-host/types'

const SHARED_TEXTURE_MESSAGE = 'shared-texture' satisfies SharedTextureHostMessage['type']

const milliseconds = z.number().int().min(1).max(2_147_483_646).transform(value => Math.min(value, 30_000))

const hostRequest = z.discriminatedUnion('op', [
  z.object({ op: z.literal('capabilities') }),
  z.object({ op: z.literal('adapter-luid'), timeoutMs: milliseconds }),
])

/**
 * Parse a Host control request received over the child-process channel.
 * @param value - Untrusted request payload.
 * @returns The validated request; throws for any other value.
 */
export function parseSharedTextureHostRequest(value: unknown): SharedTextureHostRequest {
  return hostRequest.parse(value)
}

/**
 * Route `shared-texture` messages from each Host process to Main's handler.
 * @param handle - Main's handler, called with a validated request and the Host that sent it.
 * @returns A Host channel that claims `shared-texture` messages and replies to each by `requestId`. A malformed
 *   envelope fails and terminates the Host; an invalid request, or any request while the Host is stopping, gets an
 *   error reply.
 */
export function createSharedTextureChannel(
  handle: (request: SharedTextureHostRequest, host: SharedTextureHostLink) => Promise<unknown>,
): DesktopHostChannel {
  return {
    attach(child: DesktopHostChild, host) {
      const link: SharedTextureHostLink = { pid: child.pid ?? 0 }
      return (message) => {
        if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== SHARED_TEXTURE_MESSAGE) return false
        if (!('requestId' in message) || typeof message.requestId !== 'number' || !Number.isSafeInteger(message.requestId) || message.requestId < 1
          || !('request' in message)) {
          host.fail(new Error('dsh desktop host sent invalid shared-texture control'))
          child.kill('SIGTERM')
          return true
        }
        const { requestId, request } = message
        void (async () => {
          let reply: SharedTextureMainReply
          try {
            if (host.stopping() || link.pid === 0) throw new Error('Desktop shared textures are unavailable')
            const value = await handle(parseSharedTextureHostRequest(request), link)
            reply = { type: SHARED_TEXTURE_MESSAGE, requestId, value }
          } catch (error) {
            reply = { type: SHARED_TEXTURE_MESSAGE, requestId, error: error instanceof Error ? error.message : String(error) }
          }
          if (child.connected) child.send(reply, (error) => { if (error !== null) host.fail(error) })
        })().catch((error: unknown) => { host.fail(error instanceof Error ? error : new Error(String(error))) })
        return true
      }
    },
  }
}
