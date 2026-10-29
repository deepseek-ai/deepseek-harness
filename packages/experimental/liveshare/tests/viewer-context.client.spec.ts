// @vitest-environment jsdom
/** The viewer page's own read of the share: what it states, and what it grants. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { viewerCapabilities } from '../src/client/viewer-capabilities.ts'
import { readViewerContext, viewerContextFacts } from '../src/client/viewer-context.ts'
import { noteViewerStatusFacts, viewerStatus, viewerStatusFacts } from '../src/client/viewer-status.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  viewerContextFacts.set({})
  viewerCapabilities.set({ mode: 'view' })
  viewerStatusFacts.set({})
  viewerStatus.set('connecting')
})

/**
 * Serve the two Relay reads one page makes.
 * @param context - Body for `/__liveshare/context`, or undefined to fail that read.
 * @param health - Body for `/health`, or undefined to fail that read.
 * @returns Every URL the page asked for, in order.
 */
function serve(context: unknown, health: unknown): string[] {
  const asked: string[] = []
  vi.stubGlobal('fetch', vi.fn((input: unknown) => {
    const url = String(input)
    asked.push(url)
    if (url.includes('/__liveshare/context')) {
      return context === undefined
        ? Promise.reject(new Error('unavailable'))
        : Promise.resolve(Response.json(context))
    }
    if (url.endsWith('/health')) {
      return health === undefined
        ? Promise.reject(new Error('unavailable'))
        : Promise.resolve(Response.json(health))
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`))
  }))
  return asked
}

/** Deterministic settlement control for overlapping endpoint responses. */
function deferred<T>() {
  let settle!: (value: T) => void
  const promise = new Promise<T>((resolve) => { settle = resolve })
  return { promise, settle }
}

/**
 * The endpoints the retired per-viewer approval flow served.
 *
 * The page no longer asks any of them; a build that still did would put a reader back in front of a
 * decision nothing can make.
 */
const RETIRED_ENDPOINTS: readonly string[] = [
  'request-access', 'request-status', 'decide-access', 'grant-access', 'revoke-access', '/__liveshare/approval',
]

describe('viewer context read', () => {
  it('states the share\u2019s answer and clears what an earlier read stated', async () => {
    noteViewerStatusFacts({ reason: 'share-stopped', unconfirmed: true })
    const asked = serve({ capabilities: { sessionMode: 'view', online: true } }, undefined)
    await readViewerContext('', 'share-1')
    expect(viewerStatusFacts.getSnapshot().reason).toBeUndefined()
    expect(viewerStatus.getSnapshot()).toBe('ready')
    expect(viewerCapabilities.getSnapshot()).toEqual({ mode: 'view' })
    expect(asked).toEqual(['/__liveshare/context?shareId=share-1', '/health'])
  })

  it.each([{}, { capabilities: null }, { capabilities: [] }, { capabilities: 'unknown' }].map(context => [context]))(
    'confirms nothing when the context carries no capabilities: %j', async (context) => {
      serve(context, undefined)
      await readViewerContext('', 'share-1')
      expect(viewerStatus.getSnapshot()).toBe('connecting')
      expect(viewerStatusFacts.getSnapshot().unconfirmed).toBe(true)
      expect(viewerCapabilities.getSnapshot()).toEqual({ mode: 'view', unconfirmed: true })
    },
  )

  it.each([null, []].map(body => [body]))(
    'states an unreadable context body as unreachable: %j', async (body) => {
      serve(body, undefined)
      await readViewerContext('', 'share-1')
      expect(viewerStatus.getSnapshot()).toBe('unavailable')
      expect(viewerCapabilities.getSnapshot()).toEqual({ mode: 'view', unconfirmed: true })
    },
  )

  it('drops an older refusal that arrives after a newer readable read', async () => {
    const olderContext = deferred<Response>()
    let contexts = 0
    vi.stubGlobal('fetch', vi.fn((input: unknown) => {
      const url = String(input)
      if (!url.includes('/__liveshare/context')) return Promise.resolve(Response.json({ release_id: 'r1' }))
      contexts += 1
      return contexts === 1
        ? olderContext.promise
        : Promise.resolve(Response.json({ capabilities: { sessionMode: 'view', sessionModeReason: 'mode-view' } }))
    }))
    const older = readViewerContext('', 'share-1')
    await readViewerContext('', 'share-1')
    expect(viewerStatus.getSnapshot()).toBe('ready')
    expect(viewerStatusFacts.getSnapshot().reason).toBe('mode-view')
    // The older read settles as a refusal: it states what that read found, which no longer holds.
    olderContext.settle(new Response('', { status: 404 }))
    await older
    expect(viewerStatus.getSnapshot()).toBe('ready')
    expect(viewerStatusFacts.getSnapshot().notFound).toBe(false)
  })

  it('publishes nothing from page reads that settle after cancellation', async () => {
    const response = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(() => response.promise))
    const lifetime = new AbortController()
    const read = readViewerContext('', 'share-1', lifetime.signal)
    lifetime.abort()
    response.settle(Response.json({ capabilities: { sessionMode: 'write', online: true } }))
    await read
    expect(viewerStatusFacts.getSnapshot()).toEqual({})
    expect(viewerCapabilities.getSnapshot()).toEqual({ mode: 'view' })
  })

  it('states the owner and build facts and publishes what the share grants', async () => {
    const asked = serve(
      {
        ownerSubjectId: 'feishu:tenant:ou_9f2c4d',
        dshVersion: '0.1.5-rc.2+build',
        capabilities: { readOnly: true, fork: { allowed: true } },
      },
      { release_id: '20260911-143800-6a72b8' },
    )
    await readViewerContext('/team/liveshare', 'e8HUU7dYsW7Y')
    expect(asked).toEqual([
      '/team/liveshare/__liveshare/context?shareId=e8HUU7dYsW7Y',
      '/team/liveshare/health',
    ])
    expect(viewerContextFacts.getSnapshot()).toEqual({
      ownerSubjectId: 'feishu:tenant:ou_9f2c4d',
      dshVersion: '0.1.5-rc.2+build',
      relay: '20260911-143800-6a72b8',
    })
    // The older branch-only answer is the view tier: branching is a switch, not a tier.
    expect(viewerCapabilities.getSnapshot().mode).toBe('view')
  })

  it('never asks a retired admission endpoint', async () => {
    const asked = serve({ capabilities: { sessionMode: 'view', online: true } }, { release_id: 'r1' })
    await readViewerContext('', 'share-1')
    for (const url of asked) {
      for (const gone of RETIRED_ENDPOINTS) expect(url, gone).not.toContain(gone)
    }
  })

  it('grants nothing and states nothing when the share cannot be read', async () => {
    serve(undefined, undefined)
    await readViewerContext('', 'gone')
    expect(viewerContextFacts.getSnapshot()).toEqual({})
    // A reader whose page cannot reach the Relay keeps the read-only posture: no assumed grant.
    expect(viewerCapabilities.getSnapshot().mode).toBe('view')
  })

  it('falls back to the git sha for the Relay build when it reports no release', async () => {
    // The owner name also arrives under `capabilities` from the older answer, and the Relay states
    // its own build as a sha when it has no release id.
    serve({ capabilities: { ownerDisplayName: 'Owner' } }, { git_sha: 'relay-build-7' })
    await readViewerContext('', 'share-1')
    expect(viewerContextFacts.getSnapshot()).toEqual({
      owner: 'Owner',
      relay: 'relay-build-7',
    })
  })

  it.each([401, 403])('closes what the page held on a %s answer without waiting for the build facts', async (status) => {
    serve({ capabilities: { sessionMode: 'fork-readonly' } }, { release_id: 'r1' })
    await readViewerContext('', 'share-1')
    expect(viewerCapabilities.getSnapshot().mode).toBe('view')

    // The share refuses while the build facts never answer. The abilities answer stands on its own, so
    // the refusal closes them — no reason invented, and nothing waiting on `/health`.
    const asked: string[] = []
    let answerBuild: (() => void) | undefined
    const buildHeld = new Promise<void>((resolve) => { answerBuild = resolve })
    vi.stubGlobal('fetch', vi.fn((input: unknown) => {
      const url = String(input)
      asked.push(url)
      return url.includes('/__liveshare/context')
        ? Promise.resolve(new Response('', { status }))
        : buildHeld.then(() => Response.json({ release_id: 'r2' }))
    }))
    const read = readViewerContext('', 'share-1')
    await vi.waitFor(() => { expect(viewerCapabilities.getSnapshot().mode).toBe('view') })
    expect(asked).toContain('/health')
    let settled = false
    void read.then(() => { settled = true })
    // A turn of the queue: the abilities answer closed the page, and this read is still waiting on the
    // build facts rather than on the answer that mattered.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    answerBuild?.()
    await read
    expect(viewerContextFacts.getSnapshot().relay).toBe('r2')
  })

  it('drops an older answer that arrives after a newer read', async () => {
    let answerGrant: (() => void) | undefined
    const grantedHeld = new Promise<void>((resolve) => { answerGrant = resolve })
    let shareReads = 0
    vi.stubGlobal('fetch', vi.fn((input: unknown) => {
      const url = String(input)
      if (!url.includes('/__liveshare/context')) return Promise.resolve(Response.json({ release_id: 'r1' }))
      shareReads += 1
      // The first ask grants branching but answers late; the second narrows the share right away.
      return shareReads === 1
        ? grantedHeld.then(() => Response.json({ capabilities: { sessionMode: 'fork-readonly' } }))
        : Promise.resolve(Response.json({
          capabilities: { sessionMode: 'view', sessionModeReason: 'mode-view' },
        }))
    }))
    const older = readViewerContext('', 'share-1')
    const newer = readViewerContext('', 'share-1')
    await newer
    expect(viewerCapabilities.getSnapshot()).toEqual({ mode: 'view', reason: 'mode-view' })

    // The older, slower answer states what the share said when that read was asked: it must not
    // restore an ability the newer answer took away.
    answerGrant?.()
    await older
    expect(viewerCapabilities.getSnapshot()).toEqual({ mode: 'view', reason: 'mode-view' })
  })
})
