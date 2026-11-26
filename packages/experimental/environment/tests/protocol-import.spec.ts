import { expect, it, vi } from 'vitest'

// Hosts without V8 serialization, such as the browser preview worker, still import the registry; only runs need it.
vi.mock('node:v8', () => ({
  serialize: () => { throw new Error('serialize called while importing') },
  deserialize: () => { throw new Error('deserialize called while importing') },
}))

it('encodes nothing while the protocol module loads', async () => {
  await expect(import('../src/protocol.ts')).resolves.toHaveProperty('RpcPeer')
})
