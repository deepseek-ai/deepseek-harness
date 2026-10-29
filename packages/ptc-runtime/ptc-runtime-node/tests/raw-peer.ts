/** Raw newline JSON peer for testing hostile RPC traffic without birpc validation. */
import { createInterface } from 'node:readline'
import type { Duplex } from 'node:stream'

/**
 * Observe and forge JSON messages over a test-owned stream.
 * @param stream - Test endpoint.
 * @param receive - Raw JSON message observer.
 * @returns Write receipts and endpoint cleanup.
 */
export function rawPeer(stream: Duplex, receive: (message: unknown) => void) {
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  lines.on('line', (line) => { receive(JSON.parse(line)) })
  // The endpoint under test can destroy the shared stream pair; it reports that failure itself.
  lines.on('error', (error: Error) => { void error })
  return {
    send: (message: unknown): Promise<void> => new Promise((resolve, reject) => {
      stream.write(`${JSON.stringify(message)}\n`, (error) => { if (error) reject(error); else resolve() })
    }),
    close: (): void => { lines.close(); stream.destroy() },
  }
}
