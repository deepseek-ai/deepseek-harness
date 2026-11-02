/** The package's single public entry carries the whole shared contract. */

import { expect, it } from 'vitest'
import * as root from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { MockIdentityProvider } from '../src/identity/mock.ts'

it('publishes the wire, identity, carrier, and viewer-state contracts from the package root', () => {
  expect(root.LIVESHARE_PROTOCOL_VERSION).toBeTypeOf('number')
  expect(root.parseShareAccessState).toBeTypeOf('function')
  expect(root.parseTunnelWorkerCommand).toBeTypeOf('function')
  expect(root.identityKeyOf({ providerId: 'p', tenantId: 't', subjectId: 's' })).toBe('p:t:s')
  expect(root.identityFromKey('p:t:s')).toEqual({ providerId: 'p', tenantId: 't', subjectId: 's' })
  expect(root.identityFromKey('p:t')).toBeUndefined()
  expect(root.identityFromKey('p::s')).toBeUndefined()
  expect(root.viewerCarrierScript).toBeTypeOf('function')
  expect(root.VIEWER_STATE_REACH).toBeTypeOf('object')
})

it('keeps the mock identity provider out of the published surface', () => {
  // Tests import the mock from its source module; no package entry exposes it.
  expect('MockIdentityProvider' in root).toBe(false)
  expect(MockIdentityProvider).toBeTypeOf('function')
})
