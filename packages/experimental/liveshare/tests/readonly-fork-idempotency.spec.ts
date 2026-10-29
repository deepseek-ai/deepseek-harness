/**
 * One logical fork request creates one child.
 *
 * A retry of the same request replays the answer it already produced, a concurrent retry waits for the
 * request in flight, one identity naming another boundary is refused instead of receiving the earlier
 * child, and a different operation naming the same boundary still creates its own child. Admission runs
 * before any of it, so a recorded answer is never replayed for a share that stopped.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { createViewerReadService } from '../src/host/viewer-read.ts'
import { ForkRegistry } from '../src/host/fork-registry.ts'
import type { ForkShareState } from '../src/host/fork-policy.ts'
import type { ViewerCallRequest } from '../src/viewer-channel.ts'
import { readerConnection, type ReaderFetch } from './viewer-read-peers.ts'

const creator = { providerId: 'feishu', tenantId: 'tenant-a', subjectId: 'ou_viewer' }

/** Temporary state directories this spec created, removed after each test. */
const temporary: string[] = []

/**
 * Let the fork path reach its next awaited step.
 *
 * The path reserves the operation through the registry's file lock before it enforces the child, so
 * waiting on microtasks alone would starve the file I/O that reservation completes on.
 * @returns A promise settled after the macrotask queue ran.
 */
const settleMacrotasks = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const share: ForkShareState = {
  shareId: 'share-1',
  sessionId: 'session-shared',
  allowsFork: true,
  viewerAdmitted: true,
  stopped: false,
}

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

/** A connection whose fork answer mints one child per dispatch, counted by the caller. */
function connection(
  childIds: readonly string[],
  dispatch: () => Promise<void>,
  envelope: (request: unknown) => unknown = () => ({}),
) {
  let dispatches = 0
  const dispatchedAs: PeerScope[] = []
  const sentBodies: unknown[] = []
  const owner = ownerConnection(async (request, peer) => {
    dispatches += 1
    dispatchedAs.push(peer)
    const index = dispatches - 1
    const sent: unknown = await request.json().catch(() => undefined)
    sentBodies.push(sent)
    await dispatch()
    return new Response(
      JSON.stringify({
        ...(envelope(sent) as object),
        result: { ok: true, value: { sessionId: childIds[index] ?? 'session-child' } },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  })
  return { owner, dispatchedAs, sentBodies, dispatches: () => dispatches }
}

/** One viewer-read service over a fresh registry, with the share state the test wants. */
function service(options: {
  readonly childIds?: readonly string[]
  readonly dispatch?: () => Promise<void>
  readonly state?: () => ForkShareState
  readonly enforce?: (childSessionId: string) => Promise<(() => void) | undefined>
  readonly envelope?: (request: unknown) => unknown
  /** Registry to serve from, for a test that reloads one a previous host wrote. */
  readonly forks?: ForkRegistry
} = {}) {
  const files = mkdtempSync(join(tmpdir(), 'liveshare-idempotency-'))
  temporary.push(files)
  const forks = options.forks ?? new ForkRegistry(join(files, 'forks.json'))
  const spawned = connection(
    options.childIds ?? [],
    options.dispatch ?? (() => Promise.resolve()),
    options.envelope,
  )
  const read = createViewerReadService({
    connection: spawned.owner.connection,
    sharedSessionId: () => 'session-shared',
    forkStateOf: options.state ?? (() => share),
    forks,
    // A host that installs the child's limit by default, as the share host does; a test overrides it to
    // watch the failure path.
    enforceChild: options.enforce ?? (() => Promise.resolve(() => {})),
  })
  return {
    read, forks, dispatches: spawned.dispatches, owner: spawned.owner,
    dispatchedAs: spawned.dispatchedAs, sentBodies: spawned.sentBodies,
  }
}

/** One fork request as the viewer client sends it: a Typert envelope carrying the caller's rpcId. */
function forkRequest(options: {
  readonly rpcId?: string
  readonly atSeq?: number
  readonly operationId?: string
} = {}): ViewerCallRequest {
  return {
    op: 'call',
    path: '/api/session/fork',
    body: {
      type: 'client-request',
      ...(options.rpcId === undefined ? {} : { rpcId: options.rpcId }),
      method: 'session/fork',
      payload: {
        args: {
          request: {
            sessionId: 'session-shared',
            ...(options.atSeq === undefined ? {} : { atSeq: options.atSeq }),
            ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
          },
        },
      },
    },
  }
}

/** The child one answer names, as the viewer client reads it. */
function childOf(answer: { readonly body: unknown }): string | undefined {
  const body = answer.body as { readonly result?: { readonly value?: { readonly sessionId?: string } } }
  return body.result?.value?.sessionId
}

/** The child identity one fork envelope names, as the owner's service reads it. */
function namedForkChild(envelope: unknown): string | undefined {
  const request = (envelope as {
    readonly payload?: { readonly args?: { readonly request?: { readonly childSessionId?: unknown } } }
  }).payload?.args?.request
  const named = request?.childSessionId
  return typeof named === 'string' && named !== '' ? named : undefined
}

describe('fork request idempotency', () => {
  it('replays the child a retried request already created', async () => {
    const { read, dispatches, owner, dispatchedAs } = service({ childIds: ['session-child-1', 'session-child-2'] })
    const request = forkRequest({ rpcId: 'rpc-1', atSeq: 16 })

    const first = await read.answer('share-1', request, creator)
    const retry = await read.answer('share-1', request, creator)

    expect(childOf(first)).toBe('session-child-1')
    expect(childOf(retry)).toBe('session-child-1')
    expect(dispatches()).toBe(1)
    // The one fork that ran spoke for this reader's own Peer.
    expect(dispatchedAs).toEqual([owner.peers[0]])
    expect(owner.principalOf(0)).toEqual({ kind: 'share-viewer', shareId: 'share-1', actor: creator })
    read.close()
  })

  it('creates one child when a retry overlaps the request still in flight', async () => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const { read, dispatches } = service({
      childIds: ['session-child-1'],
      dispatch: () => held,
      // The owner echoes the caller's correlation id, as the real gateway does.
      envelope: sent => ({ rpcId: (sent as { readonly rpcId?: string }).rpcId }),
    })
    // The same logical operation, sent twice at once with different correlation ids.
    const first = read.answer(
      'share-1', forkRequest({ rpcId: 'rpc-first', operationId: 'op-concurrent', atSeq: 16 }), creator,
    )
    const second = read.answer(
      'share-1', forkRequest({ rpcId: 'rpc-retry', operationId: 'op-concurrent', atSeq: 16 }), creator,
    )
    release()

    const firstAnswer = await first
    const secondAnswer = await second
    expect(childOf(firstAnswer)).toBe('session-child-1')
    expect(childOf(secondAnswer)).toBe('session-child-1')
    // The caller waiting on the in-flight fork gets its own correlation id, not the starter's.
    expect((firstAnswer.body as { readonly rpcId?: string }).rpcId).toBe('rpc-first')
    expect((secondAnswer.body as { readonly rpcId?: string }).rpcId).toBe('rpc-retry')
    expect(dispatches()).toBe(1)
    read.close()
  })

  it('refuses one identity naming another boundary instead of reusing the earlier child', async () => {
    const { read, dispatches } = service({ childIds: ['session-child-1', 'session-child-2'] })
    await read.answer('share-1', forkRequest({ rpcId: 'rpc-2', atSeq: 16 }), creator)

    const conflict = await read.answer('share-1', forkRequest({ rpcId: 'rpc-2', atSeq: 12 }), creator)

    expect(conflict).toMatchObject({ status: 409, body: { error: 'fork-operation-conflict' } })
    expect(dispatches()).toBe(1)
    read.close()
  })

  it('refuses another boundary for a reservation whose child was never recorded', async () => {
    const { read, forks, dispatches } = service({ childIds: ['session-child-1'] })
    // The identity this service computes, written as the reservation a process that died mid-fork leaves.
    const identity = [
      creator.providerId, creator.tenantId, creator.subjectId, 'share-1', 'session-shared',
      'rpc:rpc-reserved',
    ].join('\u0000')
    await forks.reserveOperation(identity, 16)

    const conflict = await read.answer('share-1', forkRequest({ rpcId: 'rpc-reserved', atSeq: 12 }), creator)

    // The boundary bound with the identity decides: another boundary is refused, and nothing is created.
    expect(conflict).toMatchObject({ status: 409, body: { error: 'fork-operation-conflict' } })
    expect(dispatches()).toBe(0)
    expect(forks.find('session-child-1')).toBeUndefined()
    read.close()
  })

  it('reloads a served operation and refuses its retry without forking again', async () => {
    // A record written before readiness existed: the retry must keep its child and be refused, not create
    // a second one and not be told the fork succeeded.
    const files = mkdtempSync(join(tmpdir(), 'liveshare-reload-'))
    temporary.push(files)
    const path = join(files, 'forks.json')
    // The identity this service computes: trusted viewer, share, source, and the caller's operation, which
    // is the caller's rpcId when it names no explicit one.
    const legacyKey = ['feishu', 'tenant-a', 'ou_viewer', 'share-1', 'session-shared', 'rpc:legacy'].join('\u0000')
    writeFileSync(path, JSON.stringify({
      version: 1,
      forks: [],
      operations: [{
        key: legacyKey,
        childSessionId: 'session-child-1',
        boundary: 16,
        status: 200,
        body: { result: { ok: true, value: { sessionId: 'session-child-1' } } },
      }],
    }))
    const forks = new ForkRegistry(path)
    const spawned = service({ childIds: ['session-child-2'], forks })
    const read = spawned.read

    const answer = await read.answer(
      'share-1',
      // The identity the legacy record was written under, at the boundary it named.
      forkRequest({ rpcId: 'legacy', atSeq: 16 }),
      creator,
    )

    expect(answer.status).toBe(503)
    expect(answer.body).toMatchObject({ error: 'fork-enforcement-failed', sessionId: 'session-child-1' })
    expect(spawned.dispatches()).toBe(0)
    read.close()
  })

  it('sends no child identity and reuses the recorded child on a retry', async () => {
    const { read, forks, sentBodies, dispatches } = service({ childIds: ['session-child-1'] })
    const request = forkRequest({ rpcId: 'rpc-no-child', atSeq: 16 })

    const first = await read.answer('share-1', request, creator)
    const retry = await read.answer('share-1', request, creator)

    expect(childOf(first)).toBe('session-child-1')
    expect(childOf(retry)).toBe('session-child-1')
    expect(dispatches()).toBe(1)
    // The current `SessionForkRequest` has no child identity field, and the owner mints the id itself, so
    // the host forwards the caller's envelope unchanged and makes the retry idempotent from its own record.
    expect(sentBodies).toHaveLength(1)
    expect(namedForkChild(sentBodies[0])).toBeUndefined()
    expect(forks.listForShare('share-1').map(record => record.childSessionId)).toEqual(['session-child-1'])
    read.close()
  })

  it('creates a new child when a different operation names the same boundary', async () => {
    const { read, dispatches } = service({ childIds: ['session-child-1', 'session-child-2'] })

    const first = await read.answer('share-1', forkRequest({ rpcId: 'rpc-3', atSeq: 16 }), creator)
    const second = await read.answer('share-1', forkRequest({ rpcId: 'rpc-4', atSeq: 16 }), creator)

    expect(childOf(first)).toBe('session-child-1')
    expect(childOf(second)).toBe('session-child-2')
    expect(dispatches()).toBe(2)
    read.close()
  })

  it('never replays a recorded answer for a share that stopped', async () => {
    // The same registry and the same service: the recorded operation is really present when the share
    // stops, so the refusal comes from admission rather than from an empty store.
    let state: ForkShareState = share
    const { read, forks, dispatches } = service({
      childIds: ['session-child-1'],
      state: () => state,
      envelope: sent => ({ rpcId: (sent as { readonly rpcId?: string }).rpcId }),
    })
    const request = forkRequest({ rpcId: 'rpc-5', atSeq: 16 })
    await read.answer('share-1', request, creator)
    await forks.revokeShare('share-1', '2026-09-12T00:00:00.000Z')
    state = { ...share, stopped: true }

    const refused = await read.answer('share-1', forkRequest({ rpcId: 'rpc-6', atSeq: 16 }), creator)

    expect(refused.status).toBe(403)
    // Admission ran first: the recorded operation was not served even though the identity repeats.
    expect(dispatches()).toBe(1)
    read.close()
  })

  it('answers a retry under the correlation id of the request being served', async () => {
    // The owner echoes the caller's correlation id beside its result, as the real gateway does.
    const { read, dispatches } = service({
      childIds: ['session-child-1'],
      envelope: sent => ({ rpcId: (sent as { readonly rpcId?: string }).rpcId }),
    })

    // One logical operation, retried under a fresh correlation id: the identity survives, the id does not.
    const first = await read.answer(
      'share-1', forkRequest({ rpcId: 'rpc-old', operationId: 'op-1', atSeq: 16 }), creator,
    )
    const retry = await read.answer(
      'share-1', forkRequest({ rpcId: 'rpc-new', operationId: 'op-1', atSeq: 16 }), creator,
    )

    expect(childOf(retry)).toBe('session-child-1')
    expect((first.body as { readonly rpcId?: string }).rpcId).toBe('rpc-old')
    // The replayed body names the child but carries the id this request is waiting on.
    expect((retry.body as { readonly rpcId?: string }).rpcId).toBe('rpc-new')
    expect(dispatches()).toBe(1)
    read.close()
  })

  it('makes every retry wait for the limit installation the first request is still doing', async () => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    let enforcing = 0
    const { read, dispatches } = service({
      childIds: ['session-child-1'],
      enforce: async () => {
        enforcing += 1
        await held
        return () => {}
      },
    })
    const request = forkRequest({ rpcId: 'rpc-barrier', atSeq: 16 })

    const first = read.answer('share-1', request, creator)
    while (enforcing === 0) await settleMacrotasks()
    let secondSettled = false
    const second = read.answer('share-1', request, creator).then((answer) => {
      secondSettled = true
      return answer
    })
    await settleMacrotasks()
    // Nothing is recorded while installation runs, and the retry is still waiting on that same work.
    expect(secondSettled).toBe(false)
    release()

    expect(childOf(await first)).toBe('session-child-1')
    expect(childOf(await second)).toBe('session-child-1')
    expect(dispatches()).toBe(1)
    read.close()
  })

  it('never forks again when the child could not be given read-only limits', async () => {
    const { read, forks, dispatches } = service({
      childIds: ['session-child-1', 'session-child-2'],
      enforce: () => Promise.reject(new Error('fixture-install-failed')),
    })
    const request = forkRequest({ rpcId: 'rpc-enforce', atSeq: 16 })

    const failed = await read.answer('share-1', request, creator)
    const retry = await read.answer('share-1', request, creator)

    // The child exists — the owner created it — but it is not a fork the viewer got.
    expect(failed.status).toBe(503)
    expect((failed.body as { readonly error?: string }).error).toBe('fork-enforcement-failed')
    expect(retry.status).toBe(503)
    expect((retry.body as { readonly error?: string }).error).toBe('fork-enforcement-failed')
    // The retry reuses that same record instead of creating a second child.
    expect(dispatches()).toBe(1)
    expect(forks.find('session-child-1')?.boundary).toBe(16)
    expect(forks.find('session-child-2')).toBeUndefined()
    read.close()
  })
})
