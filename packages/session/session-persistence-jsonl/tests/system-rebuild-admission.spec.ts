/** Deferred system replacements survive native reads under the released step rules. */
import { Context } from '@deepseek-ai/cordis'
import { KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { assertReleasedV4Relationships } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import type { SessionFormatEvent, SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { generationLogPath } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'

const id = SessionId('native-system-rebuild')
const header = { version: SESSION_FORMAT_VERSION, id, createdAt: 1, delegationDepth: 0, isSeeded: false }
const modes = (['none', 'zstd'] as const).flatMap(compression => (['read', 'write'] as const).map(access => ({ compression, access })))
const system = (name: string, text: string, retired = false): SessionFormatJsonObject => ({
  id: name, role: 'system', content: [{ type: 'text', text }],
  source: { kind: 'system-prompt', sections: [{
    name: 'A', order: 0, state: retired ? 'retired' : 'active', ...retired ? { noticeIndex: [0] } : { contentIndex: 0 },
  }] },
})
const user = (name: string): SessionFormatJsonObject => ({ id: name, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: name }] })

function history(): SessionFormatEvent[] {
  const reset = { id: 'rebuilt', role: 'system', content: [], source: { kind: 'system-prompt', reset: true, sections: [] } }
  const cleared = { ...reset, source: { kind: 'system-prompt', sections: [] } }
  const rows = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'system/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: system('A0', 'A applies') } },
    { type: 'user/message', surfaceOp: 'append', data: user('old input') },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'step/start', data: { turn: 2, step: 1 } },
    { type: 'system/message', surfaceOp: 'append', data: { turn: 2, step: 1, message: system('A1', 'A changes') } },
    { type: 'system/message', surfaceOp: 'append', data: { turn: 2, step: 1, message: system('retire-A', 'A retired', true) } },
    { type: 'user/message', surfaceOp: 'append', data: user('retained tail') },
    { type: 'step/end', data: { turn: 2, step: 1 } },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
    { type: 'compaction/start', data: { compactionId: 'compact', turn: null } },
    { type: 'compaction/summary', data: { compactionId: 'compact', summary: [{ type: 'text', text: 'summary' }], shadowedRange: { start: 3, end: 3 }, shadowedSeqs: [3], shadowedTokenCount: 10, provider: 'test', model: 'test' } },
    { type: 'user/message', surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, sourceEventSeqs: [3, 13, 14], data: { ...user('summary'), source: { kind: 'compact-checkpoint', compactionId: 'compact' } } },
    { type: 'compaction/end', data: { compactionId: 'compact', turn: null } },
    { type: 'turn/start', data: { turn: 3 } },
    { type: 'step/start', data: { turn: 3, step: 1 } },
    { type: 'system/message', data: { turn: 3, step: 1, message: { ...cleared, id: 'clear-update' } }, surfaceOp: { op: 'replace', startSeq: 8, endSeq: 8 }, sourceEventSeqs: [8] },
    { type: 'system/message', data: { turn: 3, step: 1, message: { ...cleared, id: 'clear-retirement' } }, surfaceOp: { op: 'replace', startSeq: 9, endSeq: 9 }, sourceEventSeqs: [9] },
    { type: 'system/message', data: { turn: 3, step: 1, message: reset }, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2] },
    { type: 'step/end', data: { turn: 3, step: 1 } },
    { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
  ] satisfies SessionFormatJsonObject[]
  return rows.map((row, seq) => ({ ...row, seq, time: seq + 1 }))
}

describe.each(modes)('deferred system replacements ($compression, $access)', ({ compression, access }) => {
  async function stored(events: readonly SessionFormatEvent[]) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-current-system-'))
    const ctx = new Context()
    onTestFinished(async () => {
      try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
    })
    const lines = [{ ...header, type: 'session' }, ...events].map(value => JSON.stringify(value) + '\n')
    const bytes = compression === 'none' ? Buffer.from(lines.join('')) : Buffer.concat(await Promise.all(lines.map(compressZstdFrame)))
    const path = generationLogPath(root, undefined, id, SESSION_FORMAT_VERSION, compression)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
    await ctx.plugin(JsonlSessionPersistence, { root, compression })
    return { ctx, path, bytes }
  }

  it('reopens individual system replacements under the released step rules', async () => {
    const events = history()
    expect(() => {
      assertReleasedV4Relationships({ header, events, inheritedEventCount: 0 }, KNOWN_SESSION_EVENT_TYPES)
    }).not.toThrow()
    const { ctx, path, bytes } = await stored(events)
    const handle = await ctx.sessionPersistence.open(id, access)
    try { expect((await handle.read()).events).toEqual(events) } finally { await handle.close() }
    expect(await readFile(path)).toEqual(bytes)
    const restore = sessionFormatCatalog.createRestore({ ...header, type: 'session' }, { recovery: 'strict', validation: 'current' })
    for (const event of events) restore.decodeRow(event)
    expect(restore.finish().events).toEqual(events)
  })

  it('accepts every interrupted cleanup prefix and rejects a replacement outside its step', async () => {
    const events = history()
    for (let end = 19; end <= events.length; end++) {
      expect(() => {
        assertReleasedV4Relationships({ header, events: events.slice(0, end), inheritedEventCount: 0 }, KNOWN_SESSION_EVENT_TYPES)
      }).not.toThrow()
    }
    const idleWrite = [...events.slice(0, 17), { ...events[19]!, seq: 17, time: 18 }]
    const { ctx, path, bytes } = await stored(idleWrite)
    await expect(ctx.sessionPersistence.open(id, access)).rejects.toThrow(/open turn and step/)
    expect(await readFile(path)).toEqual(bytes)
  })
})
