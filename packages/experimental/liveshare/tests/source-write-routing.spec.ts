/**
 * Where a request that names the shared Session goes.
 *
 * A request naming the Session this share carries is the source path's, whatever the tier: every tier
 * drives it while its confined layer stands, and a share whose layer is missing refuses it as the share
 * it is. A request naming any other Session is the child path's. Which path a request takes, and what the
 * source path may do, are both read from the owner's published share, so that state has to carry the tier
 * the owner set.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { ForkRegistry } from '../src/host/fork-registry.ts'
import { publishedShareState, type OwnerShare } from '../src/host/share-host.ts'
import { readerWriteRefusal, type ViewerAccessFacts } from '../src/host/viewer-access-policy.ts'
import { createViewerReadService } from '../src/host/viewer-read.ts'
import type { ViewerCallRequest } from '../src/viewer-channel.ts'
import { readerConnection } from './viewer-read-peers.ts'

const creator = { providerId: 'feishu', tenantId: 'tenant-a', subjectId: 'ou_viewer' }
const source = 'session-shared'

/** Temporary state directories this spec created, removed after each test. */
const temporary: string[] = []

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** One share this host published, with everything a request decision reads. */
function ownerShare(mode: OwnerShare['sessionMode']): OwnerShare {
  return {
    shareId: 'share-1',
    sessionId: source,
    sessionTitle: 'Shared',
    accessMode: 'open',
    link: 'https://relay.example.test/liveshare/s/share-1',
    relay: 'https://relay.example.test',
    gatewayToken: 'gateway-token',
    allowedSubjectIds: [],
    revision: 1,
    createdAt: '2026-09-12T00:00:00.000Z',
    allowsFork: true,
    sessionMode: mode,
    online: true,
  }
}

/** One `session/prompt` as the viewer client sends it, naming the Session it drives. */
function promptRequest(rpcId: string): ViewerCallRequest {
  return {
    op: 'call',
    path: '/api/session/prompt',
    body: {
      type: 'client-request',
      rpcId,
      method: 'session/prompt',
      payload: {
        args: {
          request: {
            requestId: 'req-1',
            sessionId: source,
            mode: 'queue',
            content: [{ type: 'text', text: 'drive the source' }],
          },
        },
      },
    },
  }
}

/** One `session/cancel` naming the shared Session. */
function cancelRequest(rpcId: string): ViewerCallRequest {
  return {
    op: 'call',
    path: '/api/session/cancel',
    body: { type: 'client-request', rpcId, method: 'session/cancel', payload: { args: { request: { sessionId: source } } } },
  }
}

/**
 * One viewer-read service over a share, with the owner's dispatch recorded; the write rule is this
 * package's `share-viewer` policy rule over the same share state.
 */
function service(mode: OwnerShare['sessionMode'], options: {
  readonly confined?: () => boolean
  readonly prepareSource?: (sessionId: string) => Promise<void>
  readonly refusal?: () => string | undefined
  readonly admitted?: (actor: typeof creator) => boolean
  /** The share's mode as the authority reports it right now; omitted means the mode the service was built with. */
  readonly mode?: () => OwnerShare['sessionMode']
} = {}) {
  const files = mkdtempSync(join(tmpdir(), 'liveshare-routing-'))
  temporary.push(files)
  const dispatched: unknown[] = []
  const prepared: string[] = []
  const owner = readerConnection(async (request) => {
    dispatched.push(await request.json().catch(() => undefined))
    return Response.json({ result: { ok: true, value: { sessionId: source } } })
  })
  onTestFinished(owner.dispose)
  const forks = new ForkRegistry(join(files, 'forks.json'))
  const shareState = () => publishedShareState(ownerShare(options.mode?.() ?? mode))
  const sourceConfined = () => options.confined?.() ?? true
  const admitted = (actor: typeof creator) => options.admitted?.(actor) ?? true
  const accessFacts: ViewerAccessFacts = {
    share: shareState,
    viewerAdmitted: (_shareId, actor) => admitted(actor),
    sourceConfined,
    forks,
    workspaces: () => [],
    declaredCapabilities: () => [],
  }
  const read = createViewerReadService({
    connection: owner.connection,
    sharedSessionId: () => source,
    forkStateOf: shareState,
    sourceConfined,
    viewerStillAdmitted: (_shareId, actor) => admitted(actor),
    sourceRefusal: () => options.refusal?.(),
    prepareSource: (sessionId) => {
      prepared.push(sessionId)
      return options.prepareSource?.(sessionId) ?? Promise.resolve()
    },
    writeRefusal: (viewer, action, sessionId, concrete) => readerWriteRefusal(accessFacts, viewer, action, sessionId, concrete),
    forks,
  })
  return { read, dispatched, prepared, owner }
}

describe('the share state one request is decided against', () => {
  it('carries the mode the owner set', () => {
    expect(publishedShareState(ownerShare('write'))).toMatchObject({
      shareId: 'share-1',
      sessionId: source,
      allowsFork: true,
      viewerAdmitted: true,
      stopped: false,
      sessionMode: 'write',
    })
    expect(publishedShareState(ownerShare('view')).sessionMode).toBe('view')
  })
})

describe('a prompt that names the shared Session', () => {
  it('refuses a revoked viewer’s source prompt before preparation', async () => {
    const { read, dispatched, prepared } = service('write', { admitted: actor => actor.subjectId !== creator.subjectId })
    try {
      expect(await read.answer('share-1', promptRequest('rpc-revoked'), creator))
        .toMatchObject({ status: 403, body: { error: 'viewer-not-authorized' } })
      expect(prepared).toEqual([])
      expect(dispatched).toEqual([])
      expect((await read.answer('share-1', promptRequest('rpc-revoked'), { ...creator, subjectId: 'other' })).status)
        .toBe(200)
      expect(dispatched).toHaveLength(1)
    } finally {
      read.close()
    }
  })

  it('refuses a revoked viewer’s source cancel, and dispatches an admitted one to the owner’s Gateway', async () => {
    const { read, dispatched, prepared, owner } = service('write', {
      admitted: actor => actor.subjectId !== creator.subjectId,
    })
    const other = { ...creator, subjectId: 'other' }
    const admitted = cancelRequest('rpc-admitted')
    try {
      expect(await read.answer('share-1', cancelRequest('rpc-revoked'), creator))
        .toMatchObject({ status: 403, body: { error: 'viewer-not-authorized' } })
      expect(dispatched).toEqual([])
      // The cancel travels the same standard dispatch a prompt does: the owner's Gateway receives it as
      // the reader's own Peer and decides it against the same policy.
      expect(await read.answer('share-1', admitted, other)).toMatchObject({
        status: 200,
        body: { result: { ok: true, value: { sessionId: source } } },
      })
      expect(dispatched).toEqual([admitted.body])
      expect(owner.principalOf(0)).toEqual({ kind: 'share-viewer', shareId: 'share-1', actor: other })
      // No preparation is needed: the share's confinement is already usable here.
      expect(prepared).toEqual([])
    } finally {
      read.close()
    }
  })

  it('rechecks a viewer’s access after preparing the source for a prompt', async () => {
    let admitted = true
    let confined = false
    const { read, dispatched, prepared } = service('write', {
      admitted: () => admitted,
      confined: () => confined,
      prepareSource: () => {
        admitted = false
        confined = true
        return Promise.resolve()
      },
    })
    try {
      expect(await read.answer('share-1', promptRequest('rpc-preparing'), creator))
        .toMatchObject({ status: 403, body: { error: 'viewer-not-authorized' } })
      expect(prepared).toEqual([source])
      expect(dispatched).toEqual([])
    } finally {
      read.close()
    }
  })

  it('reaches the owner unchanged, as the reader’s Peer, when the share is a write share', async () => {
    const { read, dispatched, owner } = service('write')
    const request = promptRequest('rpc-write')

    const answer = await read.answer('share-1', request, creator)

    expect(answer.status).toBe(200)
    // The requester is the Peer the call speaks for; the body carries nothing the reader did not send.
    expect(dispatched).toEqual([request.body])
    expect(owner.peers).toHaveLength(1)
    expect(owner.principalOf(0)).toEqual({ kind: 'share-viewer', shareId: 'share-1', actor: creator })
    read.close()
  })

  it('refuses the prompt when the host could not confine the shared session', async () => {
    const { read, dispatched, prepared } = service('write', {
      confined: () => false,
      refusal: () => 'tool-unavailable',
    })

    const answer = await read.answer('share-1', promptRequest('rpc-unconfined'), creator)

    // A write share whose Session carries no usable confined layer is refused by name: the viewer's input
    // must never reach the owner's own tools because a limit could not be installed.
    expect(answer).toMatchObject({ status: 403, body: { error: 'source-write-unavailable' } })
    expect(dispatched).toHaveLength(0)
    // The host tried the owner-service preparation that installs a layer before refusing, so a restarted
    // host gets one chance to become able to serve this request.
    expect(prepared).toEqual([source])
    // The refusal says what it knows: the Session was named, the preparation was attempted, and the failure
    // is the deployment's missing tool rather than a request that was never prepared.
    expect(answer.body).toMatchObject({
      prepared: true,
      session: 'known',
      reason: 'tool-unavailable',
    })
    read.close()
  })

  it('refuses a prompt without dispatching when the share loses its confined layer while the source is prepared', async () => {
    let mode: OwnerShare['sessionMode'] = 'write'
    const confined = false
    const { read, dispatched, prepared } = service('write', {
      confined: () => confined,
      // The owner demotes the share in the same turn the layer lands — after the authorization this
      // request was admitted under — and the layer itself is lost with it.
      prepareSource: () => {
        mode = 'view'
        return Promise.resolve()
      },
      mode: () => mode,
    })

    const answer = await read.answer('share-1', promptRequest('rpc-demoted'), creator)

    // The demotion is read again after the preparation and refuses before the Session runs anything: the
    // view tier still drives, but no layer confines this Session.
    expect(answer).toMatchObject({ status: 403, body: { error: 'source-write-unavailable' } })
    expect(prepared).toEqual([source])
    expect(dispatched).toHaveLength(0)
    read.close()
  })

  it('drives the shared Session at the view tier once its confined layer is installed', async () => {
    let mode: OwnerShare['sessionMode'] = 'write'
    let confined = false
    const { read, dispatched, prepared } = service('write', {
      confined: () => confined,
      // The owner narrows the share to the view tier in the same turn the layer lands: both tiers drive.
      prepareSource: () => {
        confined = true
        mode = 'view'
        return Promise.resolve()
      },
      mode: () => mode,
    })

    const answer = await read.answer('share-1', promptRequest('rpc-view'), creator)

    expect(answer.status).toBe(200)
    expect(prepared).toEqual([source])
    expect(dispatched).toHaveLength(1)
    read.close()
  })

  it('prepares the source through the owner service, and serves it once the layer is installed', async () => {
    let confined = false
    const { read, dispatched, prepared } = service('write', {
      confined: () => confined,
      // Preparing the source Session is what makes the host's pre-publication step install the layer.
      prepareSource: () => {
        confined = true
        return Promise.resolve()
      },
    })

    const answer = await read.answer('share-1', promptRequest('rpc-cold'), creator)

    expect(answer.status).toBe(200)
    expect(prepared).toEqual([source])
    expect(dispatched).toHaveLength(1)
    read.close()
  })

  it('names the share’s own Session as the target, not a missing fork child', async () => {
    // This Session belongs to the share, so the fork registry's "not a fork of a share" never applies to
    // it: at the view tier the source Session is prepared and driven like any other tier's.
    let confined = false
    const { read, dispatched, prepared } = service('view', {
      confined: () => confined,
      prepareSource: () => {
        confined = true
        return Promise.resolve()
      },
    })

    const answer = await read.answer('share-1', promptRequest('rpc-view-tier'), creator)

    expect(answer.status).toBe(200)
    expect(prepared).toEqual([source])
    expect(dispatched).toHaveLength(1)
    read.close()
  })
})
