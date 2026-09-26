/** Interpreted retired content must fail before migration publication or recoverable native-tail suppression. */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionFormatUnsupportedError, SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { generationLogPath } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'

const id = SessionId('retired-content-admission')
const wrapper = { type: 'tool-result', toolCallId: 'retired-call', content: [{ type: 'text', text: 'result' }] }
const modes = (['none', 'zstd'] as const).flatMap(compression =>
  (['read', 'write'] as const).map(access => ({ compression, access })))

describe.each(modes)('retired content in JSONL ($compression, $access)', ({ compression, access }) => {
  async function stored(version: 3 | 4, opaque: boolean, corruptPrefix: boolean) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-retired-content-'))
    const ctx = new Context()
    onTestFinished(async () => {
      try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
    })
    const event = { type: opaque ? 'future/opaque' : 'user/message', seq: 0, time: 1,
      ...(opaque ? { ignorable: true } : { surfaceOp: 'append' }),
      data: { id: 'user', role: 'user', source: { kind: 'user' }, content: [wrapper] },
    }
    const header = { type: 'session', version, id, createdAt: 1, delegationDepth: 0, isSeeded: false }
    const lines = [JSON.stringify(header) + '\n', ...(corruptPrefix ? ['{invalid json}\n'] : []), JSON.stringify(event) + '\n']
    const bytes = compression === 'none' ? Buffer.from(lines.join(''))
      : Buffer.concat(await Promise.all(lines.map(compressZstdFrame)))
    const path = generationLogPath(root, undefined, id, version, compression)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
    await ctx.plugin(JsonlSessionPersistence, { root, compression })
    return { ctx, path, bytes, event }
  }

  it.each([{ version: 3, corruptPrefix: false }, { version: 4, corruptPrefix: false }, { version: 4, corruptPrefix: true }] as const)
  ('refuses V$version content with corruptPrefix=$corruptPrefix and preserves the only generation', async ({ version, corruptPrefix }) => {
    const { ctx, path, bytes } = await stored(version, false, corruptPrefix)
    const opened = ctx.sessionPersistence.open(id, access).then(async (handle) => { await handle.close() })
    await expect(opened).rejects.toBeInstanceOf(version === 3 ? SessionFormatUnsupportedError : SessionPersistenceCorruptionError)
    await expect(opened).rejects.toThrow(/released tool-result wrapper/)
    expect(await readFile(path)).toEqual(bytes)
    expect((await readdir(dirname(path))).filter(name => name !== 'session.lock')).toEqual([basename(path)])
  })

  it.each([3, 4] as const)('preserves an unknown ignorable V%s payload without interpreting its content', async (version) => {
    const { ctx, path, bytes, event } = await stored(version, true, false)
    const handle = await ctx.sessionPersistence.open(id, access)
    const expected = version === 3 ? { ...event, type: 'plugin:future/opaque' } : event
    try { expect((await handle.read()).events).toEqual([expected]) } finally { await handle.close() }
    expect(await readFile(path)).toEqual(bytes)
  })
})
