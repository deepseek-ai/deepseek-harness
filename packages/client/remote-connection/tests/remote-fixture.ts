/** Source-only lifecycle fixture; the Web replay exercises the actual generated pairing contribution. */
import { z } from 'zod'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import type { TypertRemoteCodecSpec } from '@deepseek-ai/dsh-typert-protocol'

function codec(create: () => z.ZodType): TypertRemoteCodecSpec {
  return { mode: 'strict', typeSymbol: '@pairing-test#value', create }
}

const id = codec(() => z.string())
const decision = codec(() => z.enum(['allow', 'deny']))
const nullableId = codec(() => z.string().nullable())
const invitationState = (): z.ZodType => z.enum(['pending', 'used', 'expired', 'cancelled', 'replaced', 'none'])

export default createTypertRemoteInfo({
  package: '@deepseek-ai/dsh-client-remote-connection',
  methods: {
    'remoteConnection/status': {
      service: 'remoteConnection', invocation: { kind: 'direct' },
      parameters: [{ name: 'id', source: 'json', codec: nullableId, strictCodec: nullableId }],
      result: codec(() => z.object({
        url: z.string(), availability: z.enum(['available', 'unreachable-host', 'untrusted-host']),
        loginUrlAllowed: z.boolean(), ticket: invitationState(), pollIntervalMs: z.number(),
      })),
    },
    'remoteConnection/create': {
      service: 'remoteConnection', invocation: { kind: 'direct' }, parameters: [],
      result: codec(() => z.object({ id: z.string(), url: z.string(), lifetimeMs: z.number() })),
    },
    'remoteConnection/loginUrl': {
      service: 'remoteConnection', invocation: { kind: 'direct' }, parameters: [],
      result: codec(() => z.string()),
    },
    'remoteConnection/cancel': {
      service: 'remoteConnection', invocation: { kind: 'direct' },
      parameters: [{ name: 'id', source: 'json', codec: id, strictCodec: id }], result: codec(invitationState),
    },
    'remoteConnection/decidePairing': {
      service: 'remoteConnection', invocation: { kind: 'direct' }, cancellation: { parameter: 'signal' },
      parameters: [
        { name: 'id', source: 'json', codec: id, strictCodec: id },
        { name: 'decision', source: 'json', codec: decision, strictCodec: decision },
      ],
      result: codec(() => z.enum(['approved', 'denied', 'unavailable'])),
    },
    'remoteConnection/pairingRequests': {
      service: 'remoteConnection', invocation: { kind: 'direct' }, cancellation: { parameter: 'signal' }, parameters: [],
      result: codec(() => z.object({ requests: z.array(z.object({
        id: z.string(), code: z.string(), authority: z.string(), sourceIp: z.string().nullable(), expiresInMs: z.number(),
      })), pollIntervalMs: z.number() })),
    },
  },
}, z)
