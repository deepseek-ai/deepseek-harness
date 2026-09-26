import { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionFormatUnsupportedError, SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { generationLogPath } from '../src/format.ts'
import { prepareCatalogFacts } from '../src/catalog-migration.ts'
import { compressZstdFrame } from '../src/zstd.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe.each(['none', 'zstd'] as const)('historical catalog publication (%s)', (compression) => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'dsh-catalog-migration-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root, compression })
    const parent = SessionId('parent')
    const header = { type: 'session', version: 3, id: parent, createdAt: 1, isSeeded: false, delegationDepth: 0 }
    async function write(id: string, events: unknown[], child = false, version = 3) {
      const path = generationLogPath(root, undefined, SessionId(id), version, compression)
      await mkdir(dirname(path), { recursive: true })
      const meta: Record<string, unknown> = { ...header, id, version, ...(child ? { origin: 'subagent', parentSession: parent, createdAt: 2, delegationDepth: 1 } : {}) }
      if (version < 2) delete meta['isSeeded']
      const first = JSON.stringify(meta) + '\n'
      const body = events.map(row => JSON.stringify(row) + '\n').join('')
      await writeFile(path, compression === 'none' ? first + body
        : Buffer.concat([await compressZstdFrame(first), ...(body.length === 0 ? [] : [await compressZstdFrame(body)])]))
      return path
    }
    await write(parent, [])
    const descriptor = { type: 'subagent/descriptor', seq: 0, time: 2, data: { version: 3, mode: 'continuable', provider: 'spawn', label: 'old child' } }
    async function read() {
      const handle = await ctx.sessionPersistence.open(parent, 'read')
      try { return (await handle.read()).events } finally { await handle.close() }
    }
    return { root, ctx, parent, header, descriptor, write, read }
  }

  it.each(['read', 'write'] as const)('refuses foreign native V4 delivery through %s access', async (access) => {
    const f = await fixture()
    await f.write(f.parent, [
      { type: 'feedback/record', seq: 0, time: 1, data: {} },
      { type: 'session-log-deepseek/delivery-accepted', seq: 1, time: 2,
        data: { sessionId: 'other', sessionFormatVersion: 4, throughSeq: 0 } },
    ], false, 4)
    await expect(f.ctx.sessionPersistence.open(f.parent, access)).rejects.toThrow('wrong Session')
  })

  it.each(compression === 'none' ? ['json'] as const : ['json', 'magic', 'checksum', 'lines'] as const)(
    'opens the parent when another Session header has corrupt %s', async (damage) => {
      const f = await fixture()
      await f.write('child', [f.descriptor], true)
      const path = await f.write('unrelated', [])
      let damaged: Buffer
      if (damage === 'json') {
        damaged = compression === 'none' ? Buffer.from('{broken header\n') : await compressZstdFrame('{broken header\n')
      } else if (damage === 'lines') {
        damaged = await compressZstdFrame('{}\n{}\n')
      } else {
        damaged = await readFile(path)
        const offset = damage === 'magic' ? 0 : damaged.length - 1
        damaged[offset] = damaged[offset]! ^ 0xFF
      }
      await writeFile(path, damaged)
      expect((await f.ctx.sessionPersistence.list()).map(row => row.header.id).sort()).toEqual(['child', f.parent])
      const expected = [{ type: 'subagent/catalog', data: { childId: 'child', mode: 'continuable', label: 'old child' } }]
      expect(await f.read()).toMatchObject(expected)
      const writer = await f.ctx.sessionPersistence.open(f.parent, 'write')
      try { expect((await writer.read()).events).toMatchObject(expected) } finally { await writer.close() }
      expect(await readFile(generationLogPath(f.root, undefined, f.parent, 4, compression))).not.toHaveLength(0)
      for (const access of ['read', 'write'] as const) {
        await expect(f.ctx.sessionPersistence.open(SessionId('unrelated'), access)).rejects.toThrow()
      }
      expect(await readFile(path)).toEqual(damaged)
      await expect(readFile(generationLogPath(f.root, undefined, SessionId('unrelated'), 4, compression)))
        .rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it('invalidates lightweight revisions on child membership and contents while retaining stable tokens', async () => {
    const f = await fixture()
    const revision = async () => (await f.ctx.sessionPersistence.stat(f.parent))!.revision
    const first = await revision()
    expect(await revision()).toBe(first)
    await f.write('child', [f.descriptor], true)
    const added = await revision()
    expect(added).not.toBe(first)
    expect((await f.ctx.sessionPersistence.list()).find(row => row.header.id === f.parent)?.revision).toBe(added)
    await f.write('child', [f.descriptor, { type: 'feedback/record', seq: 1, time: 3, data: {} }], true)
    expect(await revision()).not.toBe(added)
  })

  it('reports malformed native catalog data without migration terminology', async () => {
    const f = await fixture()
    await f.write(f.parent, [{ type: 'subagent/catalog', seq: 0, time: 1,
      data: { version: 0, childId: 'child', childCreatedAt: 2, mode: 'invalid' } }], false, 4)
    const error = await f.read().catch((error: unknown) => error)
    expect(error).toBeInstanceOf(SessionPersistenceCorruptionError)
    expect((error as Error).message).not.toContain('migration requires')
  })

  it('keeps current revisions independent of unrelated historical logs and write ownership', async () => {
    const f = await fixture()
    await f.write(f.parent, [], false, 4)
    const first = (await f.ctx.sessionPersistence.stat(f.parent))!.revision
    await f.write('child', [f.descriptor], true)
    expect((await f.ctx.sessionPersistence.stat(f.parent))!.revision).toBe(first)
    expect((await f.ctx.sessionPersistence.list()).find(row => row.header.id === f.parent)?.revision).toBe(first)
    const writer = await f.ctx.sessionPersistence.open(f.parent, 'write')
    await writer.close()
    expect((await f.ctx.sessionPersistence.stat(f.parent))!.revision).toBe(first)
  })

  it('invalidates historical revisions when selected children disappear or gain an opaque successor', async () => {
    const f = await fixture()
    const path = await f.write('child', [f.descriptor], true)
    const first = (await f.ctx.sessionPersistence.stat(f.parent))!.revision
    await rm(path)
    const removed = (await f.ctx.sessionPersistence.stat(f.parent))!.revision
    expect(removed).not.toBe(first)
    await f.write('child', [], true, 5)
    expect((await f.ctx.sessionPersistence.stat(f.parent))!.revision).not.toBe(removed)
    expect((await f.ctx.sessionPersistence.list()).find(row => row.header.id === f.parent)?.revision).not.toBe(removed)
  })

  it('isolates a corrupt child catalog and reports its path', async () => {
    const f = await fixture()
    const warn = vi.spyOn(f.ctx.logger, 'warn')
    const catalog = { type: 'subagent/catalog', seq: 0, time: 1,
      data: { version: 0, childId: 'grandchild', childCreatedAt: 3, mode: 'one-shot' } }
    const path = await f.write('child', [catalog, { ...catalog, seq: 1 }], true, 4)
    expect(await f.read()).toMatchObject([{ type: 'subagent/catalog', data: { childId: 'child', mode: 'unknown' } }])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(path))
    await expect(f.ctx.sessionPersistence.open(SessionId('child'), 'read')).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
  })

  it.each(['read', 'write'] as const)('isolates malformed child JSON during parent %s access', async (access) => {
    const f = await fixture()
    const childPath = await f.write('child', [], true)
    const first = JSON.stringify({ ...f.header, id: 'child', origin: 'subagent', parentSession: f.parent, delegationDepth: 1 }) + '\n'
    const body = '{broken\n' + JSON.stringify({ type: 'turn/end', seq: 1, time: 2,
      data: { turn: 1, reason: { kind: 'completed' } } }) + '\n'
    await writeFile(childPath, compression === 'none' ? first + body
      : Buffer.concat([await compressZstdFrame(first), await compressZstdFrame(body)]))
    const original = await readFile(childPath)
    await f.write('healthy', [f.descriptor], true)
    const parent = await f.ctx.sessionPersistence.open(f.parent, access)
    try { expect((await parent.read()).events).toMatchObject([
      { type: 'subagent/catalog', data: { childId: 'child', mode: 'unknown' } },
      { type: 'subagent/catalog', data: { childId: 'healthy', mode: 'continuable' } },
    ]) } finally { await parent.close() }
    await expect(f.ctx.sessionPersistence.open(SessionId('child'), access)).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
    expect(await readFile(childPath)).toEqual(original)
    await expect(readFile(generationLogPath(f.root, undefined, SessionId('child'), 4, compression))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves opaque inherited catalogs through read preparation and write publication', async () => {
    const f = await fixture()
    const parentPath = generationLogPath(f.root, undefined, f.parent, 3, compression)
    const first = JSON.stringify({ ...f.header, isSeeded: true, parentSession: 'ancestor' }) + '\n'
    const events = [
      { type: 'subagent/catalog', seq: 0, time: 1, data: { version: 99 } },
      { type: 'session/end-seed', seq: 1, time: 2, data: { inherited: true } },
      { type: 'subagent/catalog', seq: 2, time: 3, data: null },
      { type: 'session/end-seed', seq: 3, time: 4, data: { inherited: true } },
    ]
    const body = events.map(event => JSON.stringify(event) + '\n').join('')
    await writeFile(parentPath, compression === 'none' ? first + body
      : Buffer.concat([await compressZstdFrame(first), await compressZstdFrame(body)]))
    const original = await readFile(parentPath)
    expect(await f.read()).toEqual(events)
    const writer = await f.ctx.sessionPersistence.open(f.parent, 'write')
    try { expect((await writer.read()).events).toEqual(events) } finally { await writer.close() }
    expect(await f.read()).toEqual(events)
    expect(await readFile(parentPath)).toEqual(original)
  })

  it.skipIf(compression !== 'zstd')('isolates invalid compressed child frames', async () => {
    const f = await fixture()
    const childPath = await f.write('child', [], true)
    await writeFile(childPath, Buffer.concat([await readFile(childPath), Buffer.alloc(8)]))
    expect(await f.read()).toMatchObject([{ type: 'subagent/catalog', data: { childId: 'child', mode: 'unknown' } }])
    await expect(f.ctx.sessionPersistence.open(SessionId('child'), 'read')).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
  })

  it.each([false, true])('keeps a complete parent catalog when child metadata is unavailable (corrupt=%s)', async (corrupt) => {
    const f = await fixture()
    const catalog = { type: 'subagent/catalog', seq: 0, time: 2,
      data: { version: 0, childId: 'child', childCreatedAt: 2, mode: 'one-shot', label: 'failed startup' } }
    const parentPath = await f.write(f.parent, [catalog])
    const childPath = await f.write('child', corrupt ? [{ type: 'future/required', seq: 0, time: 2, data: {} }] : [], true)
    const original = await Promise.all([readFile(parentPath), readFile(childPath)])
    expect(await f.read()).toEqual([catalog])
    const writer = await f.ctx.sessionPersistence.open(f.parent, 'write')
    await writer.close()
    expect(await f.read()).toEqual([catalog])
    expect(await Promise.all([readFile(parentPath), readFile(childPath)])).toEqual(original)
  })

  it.each([1, 2, 3])('backfills a missing catalog from descriptor v%i', async (version) => {
    const f = await fixture()
    const data = version === 1 ? { version, provider: 'spawn', label: 'old child' }
      : { ...f.descriptor.data, version }
    await f.write('child', [{ ...f.descriptor, data }], true)
    expect(await f.read()).toMatchObject([{ type: 'subagent/catalog', data: {
      childId: 'child', childCreatedAt: 2, mode: 'continuable', label: 'old child',
    } }])
    const writer = await f.ctx.sessionPersistence.open(f.parent, 'write')
    await writer.close()
  })

  it.each(['missing', 'unknown', 'multiple'] as const)('publishes the parent without invented %s child discovery information', async (kind) => {
    const f = await fixture()
    const events = kind === 'missing' ? [] : kind === 'unknown'
      ? [{ ...f.descriptor, data: { version: 99, extension: { retained: true } } }]
      : [f.descriptor, { ...f.descriptor, seq: 1, data: { ...f.descriptor.data, label: 'second descriptor' } }]
    const childPath = await f.write('child', events, true)
    const parentPath = generationLogPath(f.root, undefined, f.parent, 3, compression)
    const original = await Promise.all([readFile(parentPath), readFile(childPath)])
    expect(await f.read()).toMatchObject([{ type: 'subagent/catalog', data: { childId: 'child', mode: 'unknown' } }])
    const writer = await f.ctx.sessionPersistence.open(f.parent, 'write')
    try { expect((await writer.read()).events).toMatchObject([{ type: 'subagent/catalog', data: { childId: 'child', mode: 'unknown' } }]) } finally { await writer.close() }
    expect(await f.read()).toMatchObject([{ type: 'subagent/catalog', data: { childId: 'child', mode: 'unknown' } }])
    const child = await f.ctx.sessionPersistence.open(SessionId('child'), 'read')
    try { expect((await child.read()).events).toEqual(events) } finally { await child.close() }
    expect(await Promise.all([readFile(parentPath), readFile(childPath)])).toEqual(original)
    expect((await readdir(dirname(parentPath))).filter(name => name !== 'session.lock').sort())
      .toEqual(compression === 'none' ? ['session.v3.jsonl', 'session.v4.jsonl'] : ['session.v3.jsonl.zstd', 'session.v4.jsonl.zstd'])
  })

  it.each([false, true])('omits an unsupported child generation (prepared=%s)', async (prepared) => {
    const f = await fixture()
    await f.write('child', [f.descriptor], true)
    if (prepared) expect(await f.read()).toHaveLength(1)
    await f.write('child', [], true, 5)
    expect(await f.read()).toEqual([])
    const writer = await f.ctx.sessionPersistence.open(f.parent, 'write')
    await writer.close()
    await expect(f.ctx.sessionPersistence.open(SessionId('child'), 'read')).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
  })

  it('opens the parent independently of an unrelated future generation', async () => {
    const f = await fixture()
    await f.write('future-root', [], false, 5)
    expect((await f.ctx.sessionPersistence.list()).map(row => row.header.id)).toEqual([f.parent])
    expect(await f.read()).toEqual([])
  })

  it('retains unknown child identity without migrating unsupported contents', async () => {
    const f = await fixture()
    await f.write('child', [{ type: 'future/required', seq: 0, time: 2, data: {} }], true)
    expect(await f.read()).toMatchObject([{ type: 'subagent/catalog', data: { childId: 'child', mode: 'unknown' } }])
    await expect(f.ctx.sessionPersistence.open(SessionId('child'), 'read')).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
  })

  it('retains unknown child identity and reports invalid descriptor fields', async () => {
    const f = await fixture()
    const warn = vi.spyOn(f.ctx.logger, 'warn')
    const path = await f.write('child', [{ ...f.descriptor, data: { version: 2, provider: 'spawn', mode: 'unknown' } }], true)
    expect(await f.read()).toMatchObject([{ type: 'subagent/catalog', data: { childId: 'child', mode: 'unknown' } }])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(path))
  })

  it.each(['read', 'write'] as const)('rejects duplicate own catalogs through a current %s open', async (access) => {
    const f = await fixture()
    const catalog = { type: 'subagent/catalog', seq: 0, time: 2,
      data: { version: 0, childId: 'child', childCreatedAt: 2, mode: 'one-shot' } }
    await f.write(f.parent, [catalog, { ...catalog, seq: 1 }], false, 4)
    await expect(f.ctx.sessionPersistence.open(f.parent, access)).rejects.toThrow('duplicate catalog child')
  })

  it('recollects a changed child within the same read open', async () => {
    const f = await fixture()
    await f.write('child', [f.descriptor], true)
    expect(await f.read()).toHaveLength(1)
    await f.write('child', [f.descriptor, { type: 'feedback/record', seq: 1, time: 3, data: { text: 'appended' } }], true)
    expect(await f.read()).toHaveLength(1)
    const writer = await f.ctx.sessionPersistence.open(f.parent, 'write')
    await writer.close()
  })

  it('detects children added after preparation instead of publishing incomplete membership', async () => {
    const f = await fixture()
    expect(await f.read()).toEqual([])
    await f.write('child', [f.descriptor], true)
    await expect(f.ctx.sessionPersistence.open(f.parent, 'write')).rejects.toThrow(generationLogPath(f.root, undefined, SessionId('child'), 3, compression))
    expect(await f.read()).toHaveLength(1)
    const writer = await f.ctx.sessionPersistence.open(f.parent, 'write')
    await writer.close()
  })

  it('recollects newly available discovery fields before publishing a prepared parent', async () => {
    const f = await fixture()
    const childPath = await f.write('child', [], true)
    expect(await f.read()).toMatchObject([{ type: 'subagent/catalog', data: { childId: 'child', mode: 'unknown' } }])
    await f.write('child', [f.descriptor], true)
    await expect(f.ctx.sessionPersistence.open(f.parent, 'write')).rejects.toThrow(childPath)
    const parentPath = generationLogPath(f.root, undefined, f.parent, 3, compression)
    expect((await readdir(dirname(parentPath))).filter(name => name !== 'session.lock'))
      .toEqual([compression === 'none' ? 'session.v3.jsonl' : 'session.v3.jsonl.zstd'])
    expect(await f.read()).toMatchObject([{ type: 'subagent/catalog', data: { childId: 'child', label: 'old child' } }])
    const writer = await f.ctx.sessionPersistence.open(f.parent, 'write')
    await writer.close()
  })

  it('reads current children without recursive migration and preserves current parent fast reads', async () => {
    const f = await fixture()
    await f.write('child', [f.descriptor], true, 4)
    expect(await f.read()).toHaveLength(1)
    await f.write(f.parent, [], false, 4)
    await f.write('child', [], true, 4)
    expect(await f.read()).toEqual([])
  })

  it('refuses publication when a related child disappears', async () => {
    const f = await fixture()
    const path = await f.write('child', [f.descriptor], true)
    const header = { ...f.header, id: SessionId('child'), origin: 'subagent', parentSession: f.parent, createdAt: 2, delegationDepth: 1 } as SessionHeader
    const prepare = () => prepareCatalogFacts(f.parent, [{ path, header }], compression, new AbortController().signal)
    const prepared = await prepare()
    await rm(path)
    await expect(prepared.validate()).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(prepare()).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects changed header identities and invalid source selection', async () => {
    const f = await fixture()
    const path = await f.write('child', [f.descriptor], true)
    const header = { ...f.header, id: SessionId('wrong-child'), origin: 'subagent', parentSession: f.parent } as SessionHeader
    const signal = new AbortController().signal
    await expect(prepareCatalogFacts(f.parent, [{ path, header }], compression, signal)).rejects.toThrow('changed')
    await expect(prepareCatalogFacts(f.parent, [{ path: path + '.foreign', header }], compression, signal)).rejects.toThrow('unrecognized historical child generation')
    const controller = new AbortController()
    controller.abort(new Error('cancelled child collection'))
    await expect(prepareCatalogFacts(f.parent, [{ path, header }], compression, controller.signal)).rejects.toThrow('cancelled child collection')
  })

  it.each([0, 1, 2])('composes a V%i parent and child through all preceding edges', async (version) => {
    const f = await fixture()
    const initial = generationLogPath(f.root, undefined, f.parent, 3, compression)
    await rm(initial)
    const parentPath = await f.write(f.parent, [], false, version)
    const childPath = await f.write('child', [f.descriptor], true, version)
    const before = await Promise.all([readFile(parentPath), readFile(childPath)])
    expect(await f.read()).toMatchObject([{ type: 'subagent/catalog', seq: 0, data: { childId: 'child', mode: 'continuable', label: 'old child' } }])
    const writer = await f.ctx.sessionPersistence.open(f.parent, 'write')
    await writer.close()
    expect(await Promise.all([readFile(parentPath), readFile(childPath)])).toEqual(before)
    expect((await readdir(dirname(parentPath))).filter(name => name !== 'session.lock')).toHaveLength(2)
  })

  it('lists historical headers, prepares read-only membership, and publishes an unchanged-prefix successor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-catalog-migration-'))
    roots.push(root)
    const parent = SessionId('parent')
    const child = SessionId('child')
    const header = { type: 'session', version: 3, id: parent, createdAt: 1, isSeeded: false, delegationDepth: 0 }
    const childHeader = { ...header, id: child, createdAt: 2, origin: 'subagent', parentSession: parent, delegationDepth: 1 }
    const descriptor = { type: 'subagent/descriptor', seq: 0, time: 2, data: { version: 3, mode: 'one-shot', provider: 'spawn', label: 'old child' } }
    const sourcePaths: string[] = []
    for (const [meta, events] of [[header, []], [childHeader, [descriptor]]] as const) {
      const path = generationLogPath(root, undefined, meta.id, 3, compression)
      sourcePaths.push(path)
      await mkdir(dirname(path), { recursive: true })
      const first = Buffer.from(JSON.stringify(meta) + '\n')
      const body = Buffer.from(events.map(event => JSON.stringify(event) + '\n').join(''))
      await writeFile(path, compression === 'none' ? Buffer.concat([first, body])
        : Buffer.concat([await compressZstdFrame(first), ...(body.length === 0 ? [] : [await compressZstdFrame(body)])]))
    }
    const original = await Promise.all(sourcePaths.map(path => readFile(path)))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root, compression })
    expect((await ctx.sessionPersistence.list()).map(row => row.header.id).sort()).toEqual([child, parent])
    const reader = await ctx.sessionPersistence.open(parent, 'read')
    let expected
    try {
      expect(reader.header.version).toBe(4)
      expected = (await reader.read()).events
      expect(expected).toEqual([{ type: 'subagent/catalog', seq: 0, time: 1, data: {
        version: 0, childId: child, childCreatedAt: 2, mode: 'one-shot', label: 'old child',
      } }])
      expect(await readdir(dirname(sourcePaths[0]!))).toEqual([compression === 'none' ? 'session.v3.jsonl' : 'session.v3.jsonl.zstd'])
    } finally { await reader.close() }
    const writer = await ctx.sessionPersistence.open(parent, 'write')
    try { expect((await writer.read()).events).toEqual(expected) } finally { await writer.close() }
    expect(await Promise.all(sourcePaths.map(path => readFile(path)))).toEqual(original)
    const reopened = await ctx.sessionPersistence.open(parent, 'read')
    try { expect((await reopened.read()).events).toEqual(expected) } finally { await reopened.close() }
  })

  it('recollects a repaired child before publishing a prepared parent', async () => {
    const f = await fixture()
    await f.write('child', [{ type: 'future/required', seq: 0, time: 2, data: {} }], true)
    expect(await f.read()).toMatchObject([{ type: 'subagent/catalog', data: { childId: 'child', mode: 'unknown' } }])
    await f.write('child', [f.descriptor], true)
    expect(await f.read()).toMatchObject([{ type: 'subagent/catalog', data: { childId: 'child' } }])
    const writer = await f.ctx.sessionPersistence.open(f.parent, 'write')
    await writer.close()
  })

  it('keeps published unknown membership while a repaired child opens independently', async () => {
    const f = await fixture()
    await f.write('child', [{ type: 'future/required', seq: 0, time: 2, data: {} }], true)
    const writer = await f.ctx.sessionPersistence.open(f.parent, 'write')
    await writer.close()
    const current = generationLogPath(f.root, undefined, f.parent, 4, compression)
    const published = await readFile(current)
    await f.write('child', [f.descriptor], true)
    const child = await f.ctx.sessionPersistence.open(SessionId('child'), 'read')
    try { expect((await child.read()).events).toEqual([f.descriptor]) } finally { await child.close() }
    expect(await f.read()).toMatchObject([{ data: { childId: 'child', mode: 'unknown' } }])
    expect(await readFile(current)).toEqual(published)
  })

  it('completes only the opened parent catalog and defers its child catalog', async () => {
    const f = await fixture()
    const childPath = await f.write('child', [f.descriptor], true)
    const grandchildPath = await f.write('grandchild', [{ type: 'future/required', seq: 0, time: 2, data: {} }], true)
    // Reparent the physical fixture so only opening the child can inspect this damaged log.
    const first = JSON.stringify({ ...f.header, id: 'grandchild', origin: 'subagent', parentSession: 'child', createdAt: 3, delegationDepth: 2 }) + '\n'
    const body = JSON.stringify({ type: 'future/required', seq: 0, time: 3, data: {} }) + '\n'
    await writeFile(grandchildPath, compression === 'none' ? first + body : Buffer.concat([await compressZstdFrame(first), await compressZstdFrame(body)]))
    const warn = vi.spyOn(f.ctx.logger, 'warn')
    const source = await readFile(childPath)
    const writer = await f.ctx.sessionPersistence.open(f.parent, 'write')
    try { expect((await writer.read()).events).toMatchObject([{ type: 'subagent/catalog', data: { childId: 'child' } }]) } finally { await writer.close() }
    expect(warn).not.toHaveBeenCalled()
    expect(await readFile(childPath)).toEqual(source)
    await expect(readFile(generationLogPath(f.root, undefined, SessionId('child'), 4, compression))).rejects.toMatchObject({ code: 'ENOENT' })
    const child = await f.ctx.sessionPersistence.open(SessionId('child'), 'write')
    await child.close()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(grandchildPath))
  })
})
