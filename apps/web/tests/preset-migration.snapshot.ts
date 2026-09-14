/** Cold V2 restoration mounts the shipped PTC preset and publishes only a V3 successor. */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { generationLogPath } from '../../../packages/session/session-persistence-jsonl/src/format.ts'
import { scanZstdFrames } from '../../../packages/session/session-persistence-jsonl/src/zstd.ts'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { normalizeSessionSnapshots } from '@deepseek-ai/dsh-session-snapshot'
import { launchWebScaffold, webSnapshotMode } from './scaffold.ts'

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
      const successor = join(dirname(predecessor), 'session.v3.jsonl.zstd')
      await mkdir(dirname(predecessor), { recursive: true })
      await writeFile(predecessor, source)

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

      const publishedBytes = await readFile(successor)
      const published = Buffer.concat(scanZstdFrames(publishedBytes).frames
        .map(({ start, end }) => zstdDecompressSync(publishedBytes.subarray(start, end)))).toString('utf8')
      const expected = [
        { ...header, version: 3, agentPreset: 'ptc' },
        ...rows.map(row => row['type'] === 'agent-preset/selected'
          && (row['data'] as { agentPreset: string }).agentPreset === 'code'
          ? { ...row, data: { agentPreset: 'ptc' } }
          : row),
        // Agent activation closes its restored prefix with a fresh seed marker.
        { type: 'session/end-seed', seq: rows.length, time: 0, data: {} },
      ].map(row => JSON.stringify(row)).join('\n') + '\n'
      const context = { sessionIds: [id], cwd: scaffold.workspaceCwd }
      expect(normalizeSessionSnapshots([published], context)).toEqual(normalizeSessionSnapshots([expected], context))
      expect(await readFile(predecessor)).toEqual(source)
      expect((await readdir(dirname(predecessor))).filter(name => name.endsWith('.jsonl.zstd')).sort())
        .toEqual(['session.v2.jsonl.zstd', 'session.v3.jsonl.zstd'])
    } finally {
      await scaffold.close()
    }
  })
})
