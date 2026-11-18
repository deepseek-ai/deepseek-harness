/** One share reader's principal: the Relay-asserted identity and display name, and how two readers compare. */

import type { ShareRpcActor } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { describe, expect, it } from 'vitest'
import {
  isShareViewer, shareViewerOf, shareViewerPrincipal,
} from '../src/host/viewer-principal.ts'

const actor = { providerId: 'feishu', tenantId: 'tenant-a', subjectId: 'ou_reader' }
const principal = shareViewerPrincipal('share-one', actor)

describe('share viewer principal', () => {
  it('names a reader by the share, identity triple, and recorded display name', () => {
    expect(principal).toEqual({ kind: 'share-viewer', shareId: 'share-one', actor })
    // The display name is attribution data; credential and avatar fields never reach the principal.
    const withDisplay: ShareRpcActor & {
      readonly displayName: string
      readonly avatarUrl: string
      readonly credential: string
    } = {
      ...actor, displayName: 'Reader', avatarUrl: 'https://example.test/avatar.png', credential: 'signed',
    }
    expect(shareViewerPrincipal('share-one', withDisplay)).toEqual({
      kind: 'share-viewer',
      shareId: 'share-one',
      actor: { ...actor, displayName: 'Reader' },
    })
  })

  it('omits the display name when the Relay reported none', () => {
    expect(shareViewerPrincipal('share-one', actor)).toEqual({ kind: 'share-viewer', shareId: 'share-one', actor })
  })

  it('reads the reader out of a share-viewer principal and nothing out of another kind', () => {
    expect(shareViewerOf(principal)).toBe(principal)
    expect(shareViewerOf({ kind: 'owner' })).toBeUndefined()
  })

  it('compares readers by share and whole identity key', () => {
    expect(isShareViewer(principal, 'share-one', actor)).toBe(true)
    expect(isShareViewer(principal, 'share-two', actor)).toBe(false)
    // The same subject id issued by another provider or tenant is another reader.
    expect(isShareViewer(principal, 'share-one', { ...actor, providerId: 'other' })).toBe(false)
    expect(isShareViewer(principal, 'share-one', { ...actor, tenantId: 'tenant-b' })).toBe(false)
  })
})
