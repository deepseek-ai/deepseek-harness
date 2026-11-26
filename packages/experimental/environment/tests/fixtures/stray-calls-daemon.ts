/** Daemon fixture whose runs send host requests the service must refuse; the run result lists the refusals. */
import { z } from 'zod'
import { RpcPeer } from '../../src/protocol.ts'

const limits = { maxFrameBytes: 65536, maxMessageBytes: 65536, maxPending: 4, cancelGraceMs: 10_000 }
const peer: RpcPeer = new RpcPeer(process.stdin, process.stdout, limits, async (method, params) => {
  if (method === 'auth') return { mechanism: 'transport' }
  const { run } = z.object({ run: z.number() }).parse(params)
  const refusals = await Promise.allSettled([
    peer.request('call', { run: 999_999, method: 'x', params: null }),
    peer.request('call', { run, method: 'toString', params: null }),
    peer.request('call', { run, method: 'added', params: null }),
    peer.request('other', null),
  ])
  return refusals.map(outcome => outcome.status === 'rejected' ? (outcome.reason as Error).message : 'accepted')
})
await peer.closed
process.exit()
