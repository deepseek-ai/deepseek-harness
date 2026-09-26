/** Cold V2 restoration mounts the shipped PTC preset and publishes only the current successor. */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { generationLogPath } from '../../../packages/session/session-persistence-jsonl/src/format.ts'
import { scanZstdFrames } from '../../../packages/session/session-persistence-jsonl/src/zstd.ts'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { normalizeSessionSnapshots } from '@deepseek-ai/dsh-session-snapshot'
import { launchWebScaffold, webSnapshotMode } from './scaffold.ts'

const childFixturePath = fileURLToPath(new URL('../../../snapshots/web/preset-migration/session.1.v2.jsonl', import.meta.url))
const fixturePath = fileURLToPath(new URL('../../../snapshots/web/preset-migration/session.v2.jsonl', import.meta.url))

describe.skipIf(webSnapshotMode() === 'record')('historical preset restoration through the Web Host', () => {
  it.each([false, true])('resumes code as PTC (selection events=%s)', async (withSelections) => {
    const scaffold = await launchWebScaffold()
    try {
      const id = SessionId('preset-migration')
      const fixture = await readFile(fixturePath, 'utf8')
      const [fixtureHeader, ...fixtureEvents] = fixture.trimEnd().split('\n')
        .map((line): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>)
      const events = withSelections ? fixtureEvents : fixtureEvents.filter(event => event['type'] !== 'agent-preset/selected')
      const header = { ...fixtureHeader, id, cwd: scaffold.workspaceCwd }
      const rows: Record<string, unknown>[] = events.map((event, seq) => ({ ...event, seq, time: seq + 2 }))
      const source = Buffer.concat([header, ...rows].map(row => zstdCompressSync(Buffer.from(JSON.stringify(row) + '\n'))))
      const predecessor = generationLogPath(scaffold.persistenceRoot, scaffold.workspaceCwd, id, 2, 'zstd')
      const successor = generationLogPath(scaffold.persistenceRoot, scaffold.workspaceCwd, id, SESSION_FORMAT_VERSION, 'zstd')
      await mkdir(dirname(predecessor), { recursive: true })
      await writeFile(predecessor, source)

      const childId = SessionId('preset-migration-child')
      const brokenId = SessionId('preset-migration-broken-child')
      const childFixture = (await readFile(childFixturePath, 'utf8')).trimEnd().split('\n')
        .map((line): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>)
      const childRows: Record<string, unknown>[] = childFixture.slice(1).map((row, seq) => ({ ...row, seq, time: seq + 3 }))
      const childHeader = { ...childFixture[0], id: childId, parentSession: id, cwd: scaffold.workspaceCwd }
      const childSource = Buffer.concat([childHeader, ...childRows].map(row => zstdCompressSync(Buffer.from(JSON.stringify(row) + '\n'))))
      const childPath = generationLogPath(scaffold.persistenceRoot, scaffold.workspaceCwd, childId, 2, 'zstd')
      const brokenPath = generationLogPath(scaffold.persistenceRoot, scaffold.workspaceCwd, brokenId, 2, 'zstd')
      await mkdir(dirname(childPath), { recursive: true })
      await mkdir(dirname(brokenPath), { recursive: true })
      await writeFile(childPath, childSource)
      await writeFile(brokenPath, Buffer.concat([
        zstdCompressSync(Buffer.from(JSON.stringify({ ...childHeader, id: brokenId }) + '\n')),
        zstdCompressSync(Buffer.from('{broken\n' + JSON.stringify({ type: 'turn/end', seq: 1, time: 2,
          data: { turn: 1, reason: { kind: 'completed' } } }) + '\n')),
      ]))
      const brokenSource = await readFile(brokenPath)
      const corruptHeaderId = SessionId('preset-migration-corrupt-header')
      const corruptHeaderPath = generationLogPath(scaffold.persistenceRoot, scaffold.workspaceCwd, corruptHeaderId, 2, 'zstd')
      const corruptHeaderSource = Buffer.from('invalid Zstandard header frame')
      await mkdir(dirname(corruptHeaderPath), { recursive: true })
      await writeFile(corruptHeaderPath, corruptHeaderSource)
      const listed = await scaffold.ctx.sessionController.list({}, new AbortController().signal)
      expect(listed.items.map(item => item.sessionId)).toEqual(expect.arrayContaining([id, childId, brokenId]))
      expect(listed.items.map(item => item.sessionId)).not.toContain(corruptHeaderId)

      const reader = await scaffold.ctx.sessionPersistence.open(id, 'read')
      try {
        expect(reader.header.agentPreset).toBe('ptc')
        await reader.read()
      } finally {
        await reader.close()
      }
      await expect(readFile(successor)).rejects.toMatchObject({ code: 'ENOENT' })

      const resolved = await scaffold.ctx.sessionController.resolveAgent(id)
      if ('error' in resolved) throw resolved.error
      expect(scaffold.ctx.agentPresets.composedPreset(resolved.agent.ctx)).toBe('ptc')
      expect(resolved.agent.session.header.agentPreset).toBe('ptc')
      expect(resolved.agent.session.snapshotEvents()
        .filter(event => event.type === 'agent-preset/selected')
        .map(event => event.data.agentPreset)).toEqual(withSelections ? ['ptc', 'standard', 'ptc'] : [])
      expect(await scaffold.ctx.subagents.listChildren(id)).toEqual([
        { id: brokenId, createdAt: childFixture[0]?.['createdAt'], mode: 'unknown' },
        { id: childId, createdAt: childFixture[0]?.['createdAt'], mode: 'one-shot', label: 'historical child' },
      ])

      const childSuccessor = generationLogPath(scaffold.persistenceRoot, scaffold.workspaceCwd, childId, SESSION_FORMAT_VERSION, 'zstd')
      await expect(readFile(childSuccessor)).rejects.toMatchObject({ code: 'ENOENT' })
      const signal = new AbortController().signal
      const address = { kind: 'subagent', parentSessionId: id, childSessionId: childId, mode: 'one-shot' } as const
      const childPage = await scaffold.ctx.sessionController.page({ address, throughSeq: childRows.length - 1 }, signal)
      expect(childPage.records.map(record => record.event.type)).toEqual(childRows.map(row => row['type']))
      await expect(scaffold.ctx.sessionController.page({ address: { ...address, childSessionId: brokenId, mode: 'unknown' }, throughSeq: 1 }, signal))
        .rejects.toThrow()
      await expect(scaffold.ctx.sessionController.page({ address: { kind: 'session', sessionId: id }, throughSeq: rows.length - 1 }, signal))
        .resolves.toMatchObject({ hasMore: false })
      const childWriter = await scaffold.ctx.sessionPersistence.open(childId, 'write')
      await childWriter.close()
      const childPublished = await readFile(childSuccessor)
      const childText = Buffer.concat(scanZstdFrames(childPublished).frames
        .map(({ start, end }) => zstdDecompressSync(childPublished.subarray(start, end)))).toString('utf8')
      expect(childText.trimEnd().split('\n').map((line): unknown => JSON.parse(line))).toEqual([
        { ...childHeader, version: SESSION_FORMAT_VERSION, agentPreset: 'ptc' }, ...childRows,
      ])
      expect(await readFile(childPath)).toEqual(childSource)
      expect(await readFile(brokenPath)).toEqual(brokenSource)
      await expect(readFile(generationLogPath(scaffold.persistenceRoot, scaffold.workspaceCwd, brokenId, SESSION_FORMAT_VERSION, 'zstd')))
        .rejects.toMatchObject({ code: 'ENOENT' })

      await scaffold.ctx.sessions.flush(resolved.agent.session)
      const publishedBytes = await readFile(successor)
      const published = Buffer.concat(scanZstdFrames(publishedBytes).frames
        .map(({ start, end }) => zstdDecompressSync(publishedBytes.subarray(start, end)))).toString('utf8')
      const expected = [
        { ...header, version: SESSION_FORMAT_VERSION, agentPreset: 'ptc' },
        ...rows.map(row => row['type'] === 'agent-preset/selected'
          && (row['data'] as { agentPreset: string }).agentPreset === 'code'
          ? { ...row, data: { agentPreset: 'ptc' } }
          : row),
        { type: 'subagent/catalog', seq: rows.length, time: rows.at(-1)?.['time'], data: {
          version: 1, childId: brokenId, childCreatedAt: childFixture[0]?.['createdAt'], mode: 'unknown',
        } },
        { type: 'subagent/catalog', seq: rows.length + 1, time: rows.at(-1)?.['time'], data: {
          version: 0, childId, childCreatedAt: childFixture[0]?.['createdAt'], mode: 'one-shot', label: 'historical child',
        } },
        // Agent activation closes its restored prefix with a fresh seed marker.
        { type: 'session/end-seed', seq: rows.length + 2, time: 0, data: {} },
        { type: 'permission/preset', seq: rows.length + 3, time: 0, data: { preset: 'workspace-write' } },
        { type: 'sandbox/mode', seq: rows.length + 4, time: 0, data: { mode: 'workspace-write' } },
        { type: 'approval/policy', seq: rows.length + 5, time: 0, data: { policy: 'ask' } },
      ].map(row => JSON.stringify(row)).join('\n') + '\n'
      const context = { sessionIds: [id], cwd: scaffold.workspaceCwd }
      expect(normalizeSessionSnapshots([published], context)).toEqual(normalizeSessionSnapshots([expected], context))
      expect(await readFile(predecessor)).toEqual(source)
      await expect(scaffold.ctx.sessionPersistence.open(corruptHeaderId, 'read')).rejects.toThrow(/invalid frame magic/)
      expect(await readFile(corruptHeaderPath)).toEqual(corruptHeaderSource)
      expect((await readdir(dirname(predecessor))).filter(name => name.endsWith('.jsonl.zstd')).sort())
        .toEqual(['session.v2.jsonl.zstd', `session.v${SESSION_FORMAT_VERSION}.jsonl.zstd`])
    } finally {
      await scaffold.close()
    }
  })
})
