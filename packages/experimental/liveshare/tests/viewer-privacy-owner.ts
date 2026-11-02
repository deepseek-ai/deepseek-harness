/** Production Owner reader behind the privacy artifact fixture's neutral bridge. */
import { Context } from '@deepseek-ai/cordis'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { createViewerAccessPolicy } from '../src/host/viewer-access-policy.ts'
import { createViewerReadService } from '../src/host/viewer-read.ts'
import type { ForkShareState } from '../src/host/fork-policy.ts'
import type { PrivacyOwnerReader } from './viewer-privacy-bridge.ts'
import { readerConnection } from './viewer-read-peers.ts'

/**
 * Construct the real share-bound reader in front of an Owner Gateway stand-in.
 *
 * The production reader hands every call to the Owner's shared handler as the reader's Peer. The stand-in
 * asks a real remote access service carrying the production `share-viewer` policy about that Peer's
 * principal on the `global` resource, which is the resource of a call naming none, and answers a refusal
 * as the Gateway encodes `remote-access/denied`; only an allowed call reaches `dispatch`, so it remains
 * untouched for global reads.
 */
export function createPrivacyOwnerReader(dispatch: (request: Request) => Promise<Response>): PrivacyOwnerReader {
  const actor = { providerId: 'oidc', tenantId: 'fixture-tenant', subjectId: 'reader' }
  const share: ForkShareState = {
    shareId: 'share-1', sessionId: 'fx-alpha', viewerAdmitted: true,
    stopped: false, allowsFork: true, sessionMode: 'write',
  }
  const owner = new Context()
  const access = (async (): Promise<RemoteAccessService> => {
    await owner.plugin(TypertRegistry)
    await owner.plugin(RemoteAccessService)
    owner.remoteAccess.registerPolicy('share-viewer', createViewerAccessPolicy({
      share: shareId => shareId === share.shareId ? share : undefined,
      viewerAdmitted: () => true,
      sourceConfined: () => true,
      forks: {
        find: () => undefined,
        listForShare: () => [],
        allowsPrompt: () => ({ ok: false, code: 'fork-unknown-child', message: 'the fixture Owner holds no forks' }),
      },
      workspaces: () => [],
      declaredCapabilities: () => [],
    }))
    return owner.remoteAccess
  })()
  const readers = readerConnection(async (request, peer) => {
    const envelope = await request.clone().json() as {
      readonly rpcId?: string
      readonly payload?: { readonly args?: Readonly<Record<string, unknown>> }
    }
    const [namespace = '', method = ''] = new URL(request.url).pathname.slice('/api/'.length).split('/')
    const endpoint = `${namespace}/${method}` as const
    const decision = (await access).decide({
      principal: peer.principal,
      action: endpoint,
      resources: [{ kind: 'global' }],
      args: envelope.payload?.args ?? {},
    })
    if (decision.kind === 'allow') return dispatch(request)
    return Response.json({
      type: 'server-response',
      rpcId: envelope.rpcId,
      result: {
        ok: false,
        error: {
          code: 'remote-access/denied',
          message: `remote access: ${endpoint}: access denied (${decision.reason})`,
          details: { action: endpoint, reason: decision.reason },
        },
      },
    })
  })
  const reader = createViewerReadService({
    sharedSessionId: () => 'fx-alpha',
    viewerStillAdmitted: () => true,
    forkStateOf: () => share,
    connection: readers.connection,
  })
  return {
    answer: (request, signal) => reader.answer('share-1', request, actor, signal),
    close: () => {
      reader.close()
      void readers.dispose()
      void owner.fiber.dispose()
    },
  }
}
