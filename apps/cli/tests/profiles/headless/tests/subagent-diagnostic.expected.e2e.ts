/**
 * Assembled-app regression: a persisted `origin: 'subagent'` child whose log
 * carries no descriptor event is surfaced by `list_agents` as a
 * `[diagnostic: corrupt]` row instead of being silently dropped.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { normalizeSessionSnapshot, type NormalizeContext } from '@deepseek-ai/dsh-session-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, SESSION_FORMAT_VERSION, SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { describe, expect, it } from 'vitest'

const fixtureDir = fileURLToPath(new URL('./expected/subagent-diagnostic', import.meta.url))
const replayOverride = join(fixtureDir, 'replay.override.json')
const parentExpected = join(fixtureDir, 'parent.expected.jsonl')
const configPath = fileURLToPath(new URL('../subagent-diagnostic-snapshot.patch.yml', import.meta.url))
const binScript = fileURLToPath(new URL('../../../../../../packages/test-support/loader-smoke/tests/fixtures/headless-driver.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../../../tsconfig.json', import.meta.url))
const parentId = SessionId('subagent-diagnostic-parent')
const childId = SessionId('subagent-diagnostic-child')
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'
const task = 'Call list_agents once and report what it shows.'

/**
 * Seed a completed parent turn plus one cold child that durably classifies
 * as a subagent (`origin`) but never appended its descriptor event — the
 * publication-window death the diagnostic row exists for.
 */
async function seedDescriptorlessChild(root: string, cwd: string): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const parentMeta: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: parentId,
    createdAt: 1,
    isSeeded: false,
    cwd,
    delegationDepth: 0,
  }
  const parentEvents: SessionEvent[] = [
    { type: 'turn/start', seq: SessionSeq(0), time: 10, data: { turn: 1 } },
    { type: 'user/message', seq: SessionSeq(1), time: 11, data: createUserMessage({ content: [{ type: 'text', text: 'Start a background job.' }], source: { kind: 'user' } }), surfaceOp: 'append' },
    { type: 'turn/end', seq: SessionSeq(2), time: 12, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const childMeta: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: childId,
    createdAt: 2,
    isSeeded: false,
    cwd,
    parentSession: parentId,
    origin: 'subagent',
    delegationDepth: 1,
  }
  const childEvents: SessionEvent[] = [
    { type: 'turn/start', seq: SessionSeq(0), time: 20, data: { turn: 1 } },
    { type: 'turn/end', seq: SessionSeq(1), time: 21, data: { turn: 1, reason: { kind: 'interrupted' } } },
  ]
  try {
    const parentHandle = await ctx.sessionPersistence.create(parentMeta)
    await parentHandle.append(parentEvents)
    await parentHandle.close()
    const childHandle = await ctx.sessionPersistence.create(childMeta)
    await childHandle.append(childEvents)
    await childHandle.close()
  } finally {
    await ctx.fiber.dispose()
  }
}

describe('descriptor-less cold child diagnostic snapshot', () => {
  it('surfaces the unreadable child as a corrupt diagnostic through the assembled headless app', async () => {
    let cwd = ''
    const result = await runLoaderSmoke({
      label: 'subagent diagnostic headless stream-json snapshot',
      tempDirPrefix: 'dsh-subagent-diag-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, task],
      tsconfigPath,
      env: {
        DSH_SNAPSHOT_FILE: replayOverride,
        DSH_SNAPSHOT_OVERRIDE: replayOverride,
      },
      prepare: async (runCwd) => {
        cwd = runCwd
        await seedDescriptorlessChild(join(runCwd, '.sessions'), runCwd)
      },
      inspect: async (runCwd) => {
        const sessionsDir = join(runCwd, '.sessions')
        const files = (await readdir(sessionsDir, { recursive: true })).filter(file => file.endsWith('.jsonl'))
        const logs = await Promise.all(files.map(async file => readFile(join(sessionsDir, file), 'utf8')))
        const parent = logs.find(content => content.includes('"subagent-diagnostic-parent"'))
        if (parent === undefined) throw new Error('missing persisted parent log')

        // THE model-visible fact: the descriptor-less child is reported, not
        // silently dropped, and its reason is the corrupt classification.
        expect(parent).toContain(`${childId} [diagnostic: corrupt]`)

        const context: NormalizeContext = { sessionIds: [parentId, childId], cwd }
        const normalizedParent = normalizeSessionSnapshot(parent, context)
        if (refreshing) {
          await writeFile(parentExpected, normalizedParent)
        }
        expect(normalizedParent).toBe(await readFile(parentExpected, 'utf8'))
      },
    })

    expect(result.stderr).toBe('')
    const records = result.stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(records.at(-1)).toMatchObject({
      type: 'result',
      sessionId: parentId,
      output: 'The stored subagent is unreadable. PARENT_DONE',
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
