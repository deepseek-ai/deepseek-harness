/**
 * Assembled-app regression: a parent-only read-only override is seeded into
 * its child log and confines a real write under a wider deployment default.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { normalizeSessionSnapshot, type NormalizeContext } from '@deepseek-ai/dsh-session-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, SESSION_FORMAT_VERSION, SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { describe, expect, it } from 'vitest'

const fixtureDir = fileURLToPath(new URL('./expected/subagent-inheritance', import.meta.url))
const replayOverride = join(fixtureDir, 'replay.override.json')
const childReplay = join(fixtureDir, 'child.replay.jsonl')
const parentExpected = join(fixtureDir, 'parent.expected.jsonl')
const childExpected = join(fixtureDir, 'child.expected.jsonl')
const configPath = fileURLToPath(new URL('../subagent-inheritance-snapshot.patch.yml', import.meta.url))
const binScript = fileURLToPath(new URL('../../../../../../packages/test-support/loader-smoke/tests/fixtures/headless-driver.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../../../tsconfig.json', import.meta.url))
const sessionId = SessionId('subagent-inheritance-parent')
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'
const task = 'Delegate the write probe to a subagent.'

/** Seed a completed parent turn with its read-only policy and current LLM selection. */
async function seedReadOnlyParent(root: string, cwd: string): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const meta: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 1,
    isSeeded: false,
    cwd,
    delegationDepth: 0,
  }
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: SessionSeq(0), time: 10, data: { turn: 1 } },
    { type: 'user/message', seq: SessionSeq(1), time: 11, data: createUserMessage({ content: [{ type: 'text', text: 'Tighten this session to read-only.' }], source: { kind: 'user' } }), surfaceOp: 'append' },
    { type: 'sandbox/mode', seq: SessionSeq(2), time: 12, data: { mode: 'read-only' } },
    {
      type: 'request/header',
      seq: SessionSeq(3),
      time: 13,
      data: {
        header: {
          config: {
            provider: 'deepseek-official',
            model: 'deepseek-v4-flash',
            reasoningEffort: ReasoningEffortId('low'),
          },
        },
        reason: 'initial',
      },
    },
    { type: 'turn/end', seq: SessionSeq(4), time: 14, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  try {
    const handle = await ctx.sessionPersistence.create(meta)
    await handle.append(events)
    await handle.close()
  } finally {
    await ctx.fiber.dispose()
  }
}

describe('parent-only override inheritance snapshot', () => {
  it('confines a delegated child through the assembled headless app', async () => {
    let cwd = ''
    const result = await runLoaderSmoke({
      label: 'subagent inheritance headless stream-json snapshot',
      tempDirPrefix: 'dsh-subagent-inherit-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, task],
      tsconfigPath,
      env: {
        // The primary fixture path must exist for llm-replay's config guard;
        // the override sidecar fully replaces the derived parent script.
        DSH_SNAPSHOT_FILE: replayOverride,
        DSH_SNAPSHOT_OVERRIDE: replayOverride,
        DSH_SNAPSHOT_CHILD_FILES: childReplay,
      },
      prepare: async (runCwd) => {
        cwd = runCwd
        await seedReadOnlyParent(join(runCwd, '.sessions'), runCwd)
      },
      inspect: async (runCwd) => {
        // THE physical fact: the child's write never reached the disk. Under
        // the deployment default (workspace-write) alone it would succeed.
        await expect(readFile(join(runCwd, 'inherited.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

        // Collect both persisted logs (parent resumed turn + child run).
        const sessionsDir = join(runCwd, '.sessions')
        const files = (await readdir(sessionsDir, { recursive: true })).filter(file => file.endsWith('.jsonl'))
        const logs = await Promise.all(files.map(async file => readFile(join(sessionsDir, file), 'utf8')))
        const headerOf = (content: string): Record<string, unknown> =>
          JSON.parse(content.split('\n')[0] ?? '{}') as Record<string, unknown>
        const parent = logs.find(content => content.includes('"subagent-inheritance-parent"'))
        const child = logs.find(content => typeof headerOf(content).parentSession === 'string')
        if (parent === undefined || child === undefined) throw new Error('missing persisted parent or child log')

        const childRecords = child.trimEnd().split('\n').map(
          line => JSON.parse(line) as Record<string, unknown>,
        )
        expect(childRecords[1]).toMatchObject({
          type: 'sandbox/mode',
          seq: SessionSeq(0),
          data: { mode: 'read-only', source: 'delegation' },
        })

        const runtimeContexts = (content: string): string[] => content.trimEnd().split('\n').flatMap((line) => {
          const record = JSON.parse(line) as {
            type?: string
            data?: { source?: { kind?: string; plugin?: string }; content?: Array<{ type?: string; text?: unknown }> }
          }
          if (record.type !== 'user/message'
            || record.data?.source?.kind !== 'plugin'
            || record.data.source.plugin !== '@deepseek-ai/dsh-system-prompt') return []
          return record.data.content?.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []) ?? []
        })
        const policyContexts = [...runtimeContexts(parent), ...runtimeContexts(child)]
        expect(policyContexts).toHaveLength(2)
        for (const context of policyContexts) {
          expect(context).toContain('Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode.')
          expect(context).toContain('Do not refuse a required modification from this policy alone')
          expect(context).not.toContain('write and edit tools')
          expect(context).not.toContain('one-shot bash commands')
          expect(context).not.toContain('terminal sessions')
        }

        const context: NormalizeContext = { sessionIds: [sessionId, String(headerOf(child).id)], cwd }
        const normalizedParent = normalizeSessionSnapshot(parent, context)
        const normalizedChild = normalizeSessionSnapshot(child, context)
        if (refreshing) {
          await writeFile(parentExpected, normalizedParent)
          await writeFile(childExpected, normalizedChild)
        }
        expect(normalizedParent).toBe(await readFile(parentExpected, 'utf8'))
        expect(normalizedChild).toBe(await readFile(childExpected, 'utf8'))
        // The child's real write was denied by the real fence.
        expect(normalizedChild).toContain('file access denied under read-only mode')
      },
    })

    expect(result.stderr).toBe('')
    const records = result.stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(records.at(-1)).toMatchObject({
      type: 'result',
      sessionId,
      output: 'The delegated child was denied by the sandbox. PARENT_DONE',
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
