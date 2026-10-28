/**
 * A child created in an earlier process has no installed limit. Its first write must prepare it through
 * the owner's own service — which is what installs the limit, before the agent is published — and only
 * then run; a preparation that installs nothing leaves the write refused with nothing dispatched.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { createViewerReadService, type ViewerReadDeps } from '../src/host/viewer-read.ts'
import { ForkRegistry } from '../src/host/fork-registry.ts'
import type { ForkShareState } from '../src/host/fork-policy.ts'
import { readerWriteRefusal, type ViewerAccessFacts } from '../src/host/viewer-access-policy.ts'
import type { ViewerCallRequest } from '../src/viewer-channel.ts'
import { readerConnection, type ReaderFetch } from './viewer-read-peers.ts'

const creator = { providerId: 'feishu', tenantId: 'tenant-a', subjectId: 'ou_viewer' }
const child = 'session-child'

const temporary: string[] = []
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const share: ForkShareState = {
  shareId: 'share-1',
  sessionId: 'session-shared',
  sessionMode: 'view',
  allowsFork: true,
  viewerAdmitted: true,
  stopped: false,
}

/** Every share id names a share of the same Session, so a child can be presented through the wrong one. */
const publishedShare = (shareId: string): ForkShareState => ({ ...share, shareId })

/**
 * A reader Connection whose Peers are released when the test ends.
 * @param fetch - The owner's shared-handler stand-in.
 * @returns The Connection and the Peers it created.
 */
function ownerConnection(fetch: ReaderFetch) {
  const owner = readerConnection(fetch)
  onTestFinished(owner.dispose)
  return owner
}

/**
 * The reader's pre-dispatch write check, by this package's `share-viewer` policy rules over the share
 * state and registry one test uses.
 * @param forks - Registry holding the test's child.
 * @param state - Share state as the owner host holds it.
 * @returns The `writeRefusal` dependency the share host gives the reader.
 */
function writeRefusalOver(
  forks: ForkRegistry,
  state: (shareId: string) => ForkShareState | undefined,
): NonNullable<ViewerReadDeps['writeRefusal']> {
  const facts: ViewerAccessFacts = {
    share: state,
    viewerAdmitted: () => true,
    sourceConfined: () => false,
    forks,
    workspaces: () => [],
    declaredCapabilities: () => [],
  }
  return (viewer, action, sessionId, concrete) => readerWriteRefusal(facts, viewer, action, sessionId, concrete)
}

/** A registry holding one child of the share, recorded as a previous process would leave it. */
async function registry(revoked: boolean): Promise<ForkRegistry> {
  const files = mkdtempSync(join(tmpdir(), 'liveshare-cold-child-'))
  temporary.push(files)
  const forks = new ForkRegistry(join(files, 'forks.json'))
  await forks.record({
    childSessionId: child,
    shareId: 'share-1',
    sourceSessionId: 'session-shared',
    boundary: 3,
    creator,
    createdAt: '2026-09-12T00:00:00.000Z',
    ...(revoked ? { revokedAt: '2026-09-12T01:00:00.000Z' } : {}),
  })
  return forks
}

/** One viewer-read service whose prompt dispatches are recorded. */
function service(
  forks: ForkRegistry,
  prepare?: (childSessionId: string) => Promise<void>,
  state: (shareId: string) => ForkShareState | undefined = publishedShare,
) {
  const dispatched: string[] = []
  const owner = ownerConnection(async (request) => {
    dispatched.push(new URL(request.url).pathname)
    return Response.json({ result: { ok: true, value: {} } })
  })
  const read = createViewerReadService({
    connection: owner.connection,
    sharedSessionId: () => 'session-shared',
    forkStateOf: state,
    forks,
    writeRefusal: writeRefusalOver(forks, state),
    ...(prepare === undefined ? {} : { prepareChild: prepare }),
  })
  return { read, dispatched }
}

/** One prompt for the child, as the viewer client sends it: the Connection mints the request identity. */
function prompt(): ViewerCallRequest {
  return {
    op: 'call',
    path: '/api/session/prompt',
    body: {
      type: 'client-request',
      rpcId: 'rpc-child-prompt',
      method: 'session/prompt',
      payload: { args: { request: { sessionId: child } } },
    },
  }
}

describe('cold fork child', () => {
  it('installs a write-tier share’s child with the bounded write, and a view-tier one without it', async () => {
    const requests: (boolean | undefined)[] = []
    for (const sessionMode of ['write', 'view'] as const) {
      const forks = await registry(false)
      const owner = ownerConnection(() => Promise.resolve(Response.json({ result: { ok: true, value: { sessionId: child } } })))
      const read = createViewerReadService({
        connection: owner.connection,
        sharedSessionId: () => 'session-shared',
        forkStateOf: () => ({ ...share, sessionMode }),
        forks,
        enforceChild: (_childSessionId, options) => {
          requests.push(options?.write)
          return Promise.resolve(() => {})
        },
      })

      await read.answer('share-1', {
        op: 'call',
        path: '/api/session/fork',
        body: { type: 'client-request', rpcId: `rpc-${sessionMode}`, method: 'session/fork', payload: { args: { request: { sessionId: 'session-shared', atSeq: 3 } } } },
      }, creator)
      read.close()
    }

    // The write share asked for the bounded write; the read-only fork share did not.
    expect(requests).toEqual([true, false])
  })

  it('prepares the child, then runs the write it prepared', async () => {
    const forks = await registry(false)
    const { read, dispatched } = service(forks, async (childSessionId) => {
      // This is what the owner's preparation does through the setup contribution.
      forks.installEnforcement(childSessionId, { readOnly: true, allowedTools: ['read'], deniedCapabilities: [] })
    })

    const answer = await read.answer('share-1', prompt(), creator)

    expect(answer.status).toBe(200)
    expect(dispatched).toEqual(['/api/session/prompt'])
    read.close()
  })

  it('refuses with nothing dispatched when preparation installs no limit', async () => {
    const forks = await registry(false)
    const { read, dispatched } = service(forks, () => Promise.resolve())

    const answer = await read.answer('share-1', prompt(), creator)

    expect(answer).toMatchObject({ status: 403, body: { error: 'fork-ceiling-uninstalled' } })
    expect(dispatched).toEqual([])
    read.close()
  })

  it('refuses a revoked child without preparing it at all', async () => {
    const forks = await registry(true)
    let preparations = 0
    const { read, dispatched } = service(forks, () => {
      preparations += 1
      return Promise.resolve()
    })

    const answer = await read.answer('share-1', prompt(), creator)

    expect(answer).toMatchObject({ status: 403, body: { error: 'fork-source-revoked' } })
    expect(preparations).toBe(0)
    expect(dispatched).toEqual([])
    read.close()
  })

  it('dispatches an admitted prompt unchanged, as the reader’s Peer', async () => {
    const forks = await registry(false)
    const sent: unknown[] = []
    const dispatchedAs: PeerScope[] = []
    const owner = ownerConnection(async (request, peer) => {
      sent.push(await request.json())
      dispatchedAs.push(peer)
      return Response.json({ result: { ok: true, value: {} } })
    })
    const read = createViewerReadService({
      connection: owner.connection,
      sharedSessionId: () => 'session-shared',
      forkStateOf: publishedShare,
      forks,
      writeRefusal: writeRefusalOver(forks, publishedShare),
      enforceChild: () => Promise.resolve(() => {}),
    })
    // The child is already enforced here: this test is about what the admitted prompt carries.
    forks.installEnforcement(child, { readOnly: true, allowedTools: ['read'], deniedCapabilities: [] })
    const request: ViewerCallRequest = {
      op: 'call',
      path: '/api/session/prompt',
      body: {
        type: 'client-request',
        rpcId: 'rpc-identity',
        method: 'session/prompt',
        payload: { args: { request: { sessionId: child, requestId: 'rpc-identity', mode: 'queue', content: [] } } },
      },
    }

    const answer = await read.answer('share-1', request, creator)

    expect(answer.status).toBe(200)
    // The requester is the Peer the prompt speaks for; the body is exactly what the reader sent.
    expect(sent).toEqual([request.body])
    expect(dispatchedAs).toEqual([owner.peers[0]])
    expect(owner.principalOf(0)).toEqual({
      kind: 'share-viewer',
      shareId: 'share-1',
      actor: { providerId: 'feishu', tenantId: 'tenant-a', subjectId: 'ou_viewer' },
    })
    read.close()
  })

  it('keeps refusing a child of another viewer without preparing it', async () => {
    const forks = await registry(false)
    let preparations = 0
    const { read } = service(forks, () => {
      preparations += 1
      return Promise.resolve()
    })

    const answer = await read.answer('share-1', prompt(), { ...creator, subjectId: 'ou_other' })

    expect(answer).toMatchObject({ status: 403, body: { error: 'fork-viewer-mismatch' } })
    expect(preparations).toBe(0)
    read.close()
  })

  it('refuses a child presented through another share without preparing it', async () => {
    // The viewer owns this child, but it was created through share-1 and the request arrives through
    // share-2: reachability is attribution, so nothing is resumed for it.
    const forks = await registry(false)
    let preparations = 0
    const { read, dispatched } = service(forks, () => {
      preparations += 1
      return Promise.resolve()
    })

    const answer = await read.answer('share-2', prompt(), creator)

    expect(answer).toMatchObject({ status: 403, body: { error: 'fork-unknown-child' } })
    expect(preparations).toBe(0)
    expect(dispatched).toEqual([])
    read.close()
  })

  it('reports a preparation that failed instead of the generic missing limit', async () => {
    const forks = await registry(false)
    const { read, dispatched } = service(forks, () => Promise.reject(new Error('agent activation failed')))

    const answer = await read.answer('share-1', prompt(), creator)

    expect(answer.status).toBe(403)
    expect((answer.body as { readonly error?: string }).error).toBe('fork-prepare-failed')
    // The preparation's own reason reaches the caller; the generic code would hide a service that never
    // answered.
    expect(JSON.stringify(answer.body)).toContain('agent activation failed')
    expect(dispatched).toEqual([])
    read.close()
  })

  it('refuses a child whose share is no longer published here, without preparing it', async () => {
    const forks = await registry(false)
    let preparations = 0
    const { read, dispatched } = service(forks, () => {
      preparations += 1
      return Promise.resolve()
    }, () => undefined)

    const answer = await read.answer('share-1', prompt(), creator)

    expect(answer).toMatchObject({ status: 403, body: { error: 'share-not-found' } })
    expect(preparations).toBe(0)
    expect(dispatched).toEqual([])
    read.close()
  })
})
