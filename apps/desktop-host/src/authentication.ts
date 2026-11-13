/** Receive the Desktop startup credential over the private parent IPC channel. */

interface AuthenticationChannel {
  readonly connected: boolean
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'disconnect', listener: () => void): unknown
  off(event: 'message', listener: (message: unknown) => void): unknown
  off(event: 'disconnect', listener: () => void): unknown
}

/** Normal parent termination before or after private credential delivery. */
export class DesktopAuthenticationEnd extends Error {
  constructor(readonly kind: 'shutdown' | 'disconnected') {
    super(kind === 'shutdown' ? 'Desktop authentication cancelled by shutdown' : 'Desktop authentication channel disconnected')
    this.name = 'DesktopAuthenticationEnd'
  }
}

/** One private credential receipt and the lifetime of its parent channel. */
export interface DesktopSecretReceipt {
  readonly secret: Promise<string>
  readonly signal: AbortSignal
  /** Remove private IPC listeners and end any pending receipt. */
  dispose(): void
}

/**
 * Install credential receipt before publishing the Host's starting message.
 * @param channel - owned parent IPC connection.
 * @returns one credential and a signal ended by disconnect, shutdown, invalid input, or duplicate delivery.
 * Pending receipt rejects with DesktopAuthenticationEnd for normal parent termination; malformed or repeated credentials remain failures.
 */
export function receiveDesktopSecret(channel: AuthenticationChannel): DesktopSecretReceipt {
  const delivered = Promise.withResolvers<string>()
  const lifetime = new AbortController()
  let received = false
  const detach = (): void => {
    channel.off('message', onMessage)
    channel.off('disconnect', onDisconnect)
  }
  const end = (error: Error): void => {
    if (lifetime.signal.aborted) return
    detach()
    lifetime.abort(error)
    delivered.reject(error)
  }
  const onDisconnect = (): void => { end(new DesktopAuthenticationEnd('disconnected')) }
  const onMessage = (message: unknown): void => {
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    if (message.type === 'shutdown') { end(new DesktopAuthenticationEnd('shutdown')); return }
    if (message.type !== 'desktop-auth') return
    if (received) { end(new Error('Desktop authentication credential already received')); return }
    if (Array.isArray(message) || Object.keys(message).length !== 2 || !('secret' in message) || typeof message.secret !== 'string'
      || !/^[A-Za-z0-9_-]{43}$/u.test(message.secret)
      || Buffer.from(message.secret, 'base64url').toString('base64url') !== message.secret) {
      end(new Error('Desktop authentication message is invalid'))
      return
    }
    received = true
    delivered.resolve(message.secret)
  }
  channel.on('message', onMessage)
  channel.on('disconnect', onDisconnect)
  if (!channel.connected) onDisconnect()
  return {
    secret: delivered.promise,
    signal: lifetime.signal,
    dispose() { end(new Error('Desktop authentication receiver disposed')) },
  }
}
