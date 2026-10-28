/** Viewer streams retain Session and actor authority throughout their lifetime. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { forkLineageValue } from '../src/fork-lineage.ts'
import { ForkRegistry } from '../src/host/fork-registry.ts'
import { createViewerReadService, type ViewerReadDeps, type ViewerReadGateway } from '../src/host/viewer-read.ts'
import { readerConnection } from './viewer-read-peers.ts'

const alice = { providerId: 'mock', tenantId: 'tenant', subjectId: 'alice' }
const bob = { ...alice, subjectId: 'bob' }

function gateway(frames: readonly unknown[]): ViewerReadGateway {
  return {
    wireStream: {
      open: async () => (async function* () { yield* frames })(),
      failure: () => ({ code: 'gateway/internal', message: 'failed', details: {} }),
    },
  }
}

/** One reader over the given gateway, closed when the test ends. */
function reader(deps: Omit<ViewerReadDeps, 'connection'>) {
  const readers = readerConnection()
  const read = createViewerReadService({ ...deps, connection: readers.connection })
  onTestFinished(async () => {
    read.close()
    await readers.dispose()
  })
  return read
}

async function collect(read: ReturnType<typeof createViewerReadService>, endpoint: string, actor = alice) {
  expect(await read.answer('share', { op: 'stream-open', id: 1, endpoint, payload: { args: {} } }, actor))
    .toMatchObject({ status: 200 })
  const frames: unknown[] = []
  for (;;) {
    const answer = await read.answer('share', { op: 'stream-next', id: 1 }, actor)
    expect(answer.status).toBe(200)
    const body = answer.body as { values?: unknown[]; end?: boolean }
    if (body.end) return frames
    frames.push(...body.values ?? [])
  }
}

describe('viewer authority', () => {
  it('does not let another actor poll, replace, or cancel a stream', async () => {
    const read = reader({ sharedSessionId: () => 'source', gateway: gateway([{ private: 'alice' }]) })
    const open = { op: 'stream-open' as const, id: 1, endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId: 'source' } } } } }
    expect((await read.answer('share', open, alice)).status).toBe(200)
    expect((await read.answer('share', { op: 'stream-next', id: 1 }, bob)).status).toBe(403)
    expect((await read.answer('share', { op: 'stream-cancel', id: 1 }, bob)).status).toBe(403)
    expect((await read.answer('share', open, bob)).status).toBe(403)
    expect(await read.answer('share', { op: 'stream-next', id: 1 }, alice))
      .toMatchObject({ status: 200, body: { values: [{ private: 'alice' }] } })
  })

  it('adds branch facts to the reader\u2019s own fork in the control frames the controller sent', async () => {
    const files = mkdtempSync(join(tmpdir(), 'liveshare-authority-'))
    onTestFinished(() => { rmSync(files, { recursive: true, force: true }) })
    const forks = new ForkRegistry(join(files, 'forks.json'))
    await forks.record({
      childSessionId: 'alice-fork', shareId: 'share', sourceSessionId: 'source', boundary: 1,
      creator: alice, createdAt: '2026-09-11T00:00:00.000Z',
    })
    const block = { asOfSeq: 0, values: {} }
    const read = reader({ sharedSessionId: () => 'source', forks, gateway: gateway([
      { type: 'baseline', value: { projections: { source: block, 'alice-fork': { asOfSeq: 1, values: { title: 'Mine' } } } } },
      { type: 'projection', sessionId: 'alice-fork', key: 'title', value: 'Renamed', seq: 2 },
    ]) })
    // The fork's facts are not folded from its log, so the baseline that replaces the block the session
    // list published states them again; the shared Session and later updates are relayed unchanged.
    expect(await collect(read, 'session/control')).toEqual([
      { type: 'baseline', value: { projections: {
        source: block,
        'alice-fork': { asOfSeq: 1, values: { title: 'Mine', forkLineage: forkLineageValue('source') } },
      } } },
      { type: 'projection', sessionId: 'alice-fork', key: 'title', value: 'Renamed', seq: 2 },
    ])
  })
})
