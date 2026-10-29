/**
 * `LIVESHARE_DEBUG_READS` on the owner host: the per-read lines of the viewer-read service are on for
 * exactly the value `1`, and the reads themselves behave identically either way.
 *
 * The viewer-read service writes a line for each stream it opens, each poll of a stream it no longer
 * holds, and each cancel it accepts. Those lines are the only owner-side record that a reader's stream
 * was opened or released, so this pins that the switch gates every one of them — and that a value the
 * service does not recognize leaves the reads working rather than throwing or refusing.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createViewerReadService, type ViewerReadDeps } from '../src/host/viewer-read.ts'
import { READER, readerConnection } from './viewer-read-peers.ts'

const SHARE = 'share-debug-reads'
const OPENED_STREAM = 1
const MISSING_STREAM = 99

/** Values the switch can carry, and how many gated lines each one must produce. */
const SWITCH_CASES = [
  { name: 'the documented value 1', value: '1', gatedLines: 3 },
  { name: 'an unset variable', value: undefined, gatedLines: 0 },
  { name: 'an empty value', value: '', gatedLines: 0 },
  { name: 'a zero', value: '0', gatedLines: 0 },
  { name: 'a boolean word', value: 'true', gatedLines: 0 },
  { name: 'a padded one', value: ' 1', gatedLines: 0 },
] as const

/** The three lines the switch gates, in the order this file provokes them. */
const GATED_LINES = [
  `[liveshare] viewer stream open share=${SHARE} streamId=${String(OPENED_STREAM)} endpoint=session/follow`,
  `[liveshare] viewer stream missing share=${SHARE} streamId=${String(MISSING_STREAM)}`,
  `[liveshare] viewer stream cancel share=${SHARE} streamId=${String(OPENED_STREAM)}`,
] as const

/** A gateway whose one stream yields a single value and then ends. */
function singleValueGateway(): NonNullable<ViewerReadDeps['gateway']> {
  return {
    wireStream: {
      async open(): Promise<AsyncIterable<unknown>> {
        return (async function* () { yield { seq: 0 } })()
      },
      failure(error: unknown): { readonly code: string; readonly message: string; readonly details: object } {
        return { code: String(error), message: String(error), details: {} }
      },
    },
  }
}

afterEach(() => { vi.restoreAllMocks() })

describe('owner LIVESHARE_DEBUG_READS switch', () => {
  it.each(SWITCH_CASES)('logs the gated viewer-read lines for $name', async ({ value, gatedLines }) => {
    const previous = process.env.LIVESHARE_DEBUG_READS
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')) })
    if (value === undefined) delete process.env.LIVESHARE_DEBUG_READS
    else process.env.LIVESHARE_DEBUG_READS = value
    const read = createViewerReadService({
      connection: readerConnection().connection,
      gateway: singleValueGateway(),
      sharedSessionId: () => 'session-1',
    })
    try {
      const opened = await read.answer(SHARE, {
        op: 'stream-open',
        id: OPENED_STREAM,
        endpoint: 'session/follow',
        payload: { args: { request: { address: { kind: 'session', sessionId: 'session-1' } } } },
      }, READER)
      const missing = await read.answer(SHARE, { op: 'stream-next', id: MISSING_STREAM }, READER)
      const cancelled = await read.answer(SHARE, { op: 'stream-cancel', id: OPENED_STREAM }, READER)

      // The switch changes only the logging: every operation keeps its own answer.
      expect(opened.status).toBe(200)
      expect(opened.body).toEqual({ opened: true })
      expect(missing.status).toBe(404)
      expect(cancelled.status).toBe(200)
      expect(cancelled.body).toEqual({ cancelled: true })

      const observed = logs.filter(line => line.startsWith('[liveshare] viewer stream'))
      expect(observed).toHaveLength(gatedLines)
      if (gatedLines > 0) expect(observed).toEqual([...GATED_LINES])
    } finally {
      read.close()
      if (previous === undefined) delete process.env.LIVESHARE_DEBUG_READS
      else process.env.LIVESHARE_DEBUG_READS = previous
    }
  })
})
