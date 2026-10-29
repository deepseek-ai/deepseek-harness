/** A viewer's own fork children, and only those: ownership is the whole subject, tenant included. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { SessionId } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { createViewerReadService } from '../src/host/viewer-read.ts'
import { ForkRegistry } from '../src/host/fork-registry.ts'
import type { ForkShareState } from '../src/host/fork-policy.ts'
import { createViewerAccessPolicy, readerWriteRefusal, type ViewerAccessFacts } from '../src/host/viewer-access-policy.ts'
import type { ViewerCallRequest } from '../src/viewer-channel.ts'
import { readerConnection } from './viewer-read-peers.ts'

const creator = { providerId: 'feishu', tenantId: 'tenant-a', subjectId: 'ou_viewer' }

const share: ForkShareState = {
  shareId: 'share-1',
  sessionId: 'session-shared',
  // The view tier with the share's own fork switch on: forking is no longer a tier of its own.
  sessionMode: 'view',
  allowsFork: true,
  viewerAdmitted: true,
  stopped: false,
}

function pageBody(sessionId: string) {
  return { type: 'client-request', rpcId: 'page', method: 'session/page',
    payload: { args: { request: { address: { kind: 'session', sessionId }, throughSeq: 3 } } } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The Session one `session/page` envelope addresses. */
function pagedSession(envelope: unknown): string | undefined {
  if (!isRecord(envelope) || !isRecord(envelope.payload) || !isRecord(envelope.payload.args)) return undefined
  const request = envelope.payload.args.request
  if (!isRecord(request) || !isRecord(request.address)) return undefined
  return typeof request.address.sessionId === 'string' ? request.address.sessionId : undefined
}

/**
 * The owner's Gateway and Session Controller as one reader's calls reach them.
 *
 * Each call speaks for the reader's Peer, so a real remote access service carrying this package's
 * `share-viewer` policy is asked about that Peer's principal: the list keeps only the rows it allows, as
 * the Session Controller's own filter does, and a page it denies is refused as the Gateway refuses it.
 * The list carries the shared session, this viewer's child when the registry has one, and a session
 * nobody shared.
 */
function owner(access: RemoteAccessService) {
  const connection = readerConnection(async (request, peer) => {
    const endpoint = new URL(request.url).pathname === '/api/session/list' ? 'session/list' : 'session/page'
    const envelope: unknown = await request.json()
    const decide = (sessionId: string) => access.decide({
      principal: peer.principal,
      action: endpoint,
      resources: [{ kind: 'session', id: SessionId(sessionId) }],
    })
    if (endpoint === 'session/list') {
      const items = [
        { sessionId: 'session-shared', title: 'Shared' },
        { sessionId: 'session-child', title: 'Child' },
        { sessionId: 'session-other', title: 'Someone else' },
      ]
      return Response.json({ result: { ok: true, value: { items: items.filter(item => decide(item.sessionId).kind === 'allow') } } })
    }
    const sessionId = pagedSession(envelope)
    const decision = sessionId === undefined ? { kind: 'deny', reason: 'resource-invalid' } as const : decide(sessionId)
    if (decision.kind === 'deny') {
      return Response.json({
        type: 'server-response',
        rpcId: 'page',
        result: { ok: false, error: { code: 'remote-access/denied', message: 'denied', details: { action: endpoint, reason: decision.reason } } },
      })
    }
    // Every session read the owner answers carries a projection block; the viewer's history page
    // serves this value.
    return Response.json({ result: { ok: true, value: { projections: { asOfSeq: 3, values: { title: 'Child' } } } } })
  })
  onTestFinished(connection.dispose)
  return connection
}

async function service(childCreator = creator): Promise<{ read: ReturnType<typeof createViewerReadService> }> {
  const files = mkdtempSync(join(tmpdir(), 'liveshare-ownership-'))
  onTestFinished(() => { rmSync(files, { recursive: true, force: true }) })
  const forks = new ForkRegistry(join(files, 'forks.json'))
  await forks.record({
    childSessionId: 'session-child',
    shareId: 'share-1',
    sourceSessionId: 'session-shared',
    boundary: 3,
    creator: childCreator,
    createdAt: '2026-09-11T00:00:00.000Z',
  })
  const accessFacts: ViewerAccessFacts = {
    share: shareId => shareId === share.shareId ? share : undefined,
    viewerAdmitted: () => true,
    sourceConfined: () => false,
    forks,
    workspaces: () => [],
    declaredCapabilities: () => [],
  }
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  ctx.remoteAccess.registerPolicy('share-viewer', createViewerAccessPolicy(accessFacts))
  const read = createViewerReadService({
    connection: owner(ctx.remoteAccess).connection,
    sharedSessionId: () => 'session-shared',
    forkStateOf: () => share,
    forks,
    writeRefusal: (viewer, action, sessionId, concrete) => readerWriteRefusal(accessFacts, viewer, action, sessionId, concrete),
  })
  return { read }
}

/** Ask for the list as the given viewer. */
async function listSessions(read: Awaited<ReturnType<typeof service>>['read'], actor: typeof creator) {
  const answer = await read.answer('share-1', {
    op: 'call',
    path: '/api/session/list',
    body: { type: 'client-request', rpcId: 'list', method: 'session/list', payload: { args: { request: {} } } },
  }, actor)
  const body = answer.body as {
    readonly result?: { readonly value?: { readonly items?: readonly { readonly sessionId: string }[] } }
  }
  return body.result?.value?.items ?? []
}

describe('read-only fork ownership in the viewer session list', () => {
  it('keeps the shared session and this viewer’s own child, annotated', async () => {
    const { read } = await service()
    const items = await listSessions(read, creator)

    expect(items.map(item => item.sessionId)).toEqual(['session-shared', 'session-child'])
    expect(items[1]).toMatchObject({
      projections: {
        values: {
          forkLineage: {
            origin: 'fork',
            sourceSessionId: 'session-shared',
            workspaceReadOnly: true,
            authoredByViewer: true,
          },
        },
      },
    })
    // The shared Session is not this viewer's branch, so it states no branch facts.
    expect(items[0]).not.toHaveProperty('projections')
    read.close()
  })

  it('states the same branch facts on the branch’s own page, and none on the shared Session', async () => {
    const { read } = await service()
    // Opening the branch would otherwise replace the projection value the list published with the
    // owner's own baseline, which carries no branch facts: the page states them too.
    const child = await read.answer('share-1', {
      op: 'call', path: '/api/session/page', body: pageBody('session-child'),
    }, creator)
    expect(child).toMatchObject({
      status: 200,
      body: {
        result: {
          value: {
            projections: {
              values: {
                forkLineage: {
                  origin: 'fork',
                  sourceSessionId: 'session-shared',
                  workspaceReadOnly: true,
                  authoredByViewer: true,
                },
              },
            },
          },
        },
      },
    })
    const shared = await read.answer('share-1', {
      op: 'call', path: '/api/session/page', body: pageBody('session-shared'),
    }, creator)
    expect(shared).toMatchObject({
      status: 200,
      body: { result: { value: { projections: { values: { title: 'Child' } } } } },
    })
    expect(JSON.stringify(shared)).not.toContain('forkLineage')
    read.close()
  })

  it('drops the same provider and subject in another tenant', async () => {
    // The Relay admits by tenant, but ownership here is the whole subject: a viewer in tenant-b with
    // the same subject id must not be handed tenant-a's child, nor be treated as its creator.
    const { read } = await service()
    const items = await listSessions(read, { ...creator, tenantId: 'tenant-b' })

    expect(items.map(item => item.sessionId)).toEqual(['session-shared'])
    expect(JSON.stringify(items)).not.toContain('forkLineage')
    read.close()
  })

  it('drops another viewer’s child', async () => {
    const { read } = await service({ ...creator, subjectId: 'ou_other' })

    expect((await listSessions(read, creator)).map(item => item.sessionId)).toEqual(['session-shared'])
    read.close()
  })

  it('refuses a child prompt until the execution ceiling is installed, and another viewer’s child always', async () => {
    const { read } = await service()
    const prompt: ViewerCallRequest = {
      op: 'call',
      path: '/api/session/prompt',
      body: {
        type: 'client-request',
        rpcId: 'rpc-child-prompt',
        method: 'session/prompt',
        payload: { args: { request: { sessionId: 'session-child' } } },
      },
    }

    // The gate is reachable in production now: a child prompt is decided by the registry, and with no
    // ceiling installed the answer is the named refusal rather than an unreachable endpoint.
    const ungated = await read.answer('share-1', prompt, creator)
    expect(ungated).toMatchObject({ status: 403, body: { error: 'fork-ceiling-uninstalled' } })

    // Another viewer's prompt never reaches the dispatch, whatever the ceiling state is.
    const stranger = await read.answer('share-1', prompt, { ...creator, subjectId: 'ou_other' })
    expect(stranger).toMatchObject({ status: 403, body: { error: 'fork-viewer-mismatch' } })
    read.close()
  })

  it('lets the creator read its own child while refusing it to anyone else', async () => {
    const { read } = await service()

    // The creator's own child is readable; another viewer's read of it is not, and a session the
    // registry does not know stays refused exactly as before.
    const own = await read.answer('share-1', {
      op: 'call', path: '/api/session/page', body: pageBody('session-child'),
    }, creator)
    expect(own).toMatchObject({ status: 200, body: { result: { ok: true } } })

    const other = await read.answer('share-1', {
      op: 'call', path: '/api/session/page', body: pageBody('session-child'),
    }, { ...creator, tenantId: 'tenant-b' })
    expect(other.body).toMatchObject({ result: { ok: false, error: {
      code: 'remote-access/denied', details: { action: 'session/page', reason: 'liveshare/read-only' },
    } } })
    expect(JSON.stringify(other)).not.toContain('forkLineage')

    const unknown = await read.answer('share-1', {
      op: 'call', path: '/api/session/page', body: pageBody('session-other'),
    }, creator)
    expect(unknown.body).toMatchObject({ result: { ok: false, error: {
      code: 'remote-access/denied', details: { action: 'session/page', reason: 'liveshare/read-only' },
    } } })
    read.close()
  })
})
