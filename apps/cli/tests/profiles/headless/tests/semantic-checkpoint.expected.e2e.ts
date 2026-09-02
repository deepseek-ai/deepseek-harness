import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { normalizeSessionSnapshot, type NormalizeContext } from '@deepseek-ai/dsh-session-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { createUserMessage, ToolCallId , createMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, SESSION_FORMAT_VERSION, SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { logPath } from '../../../../../../packages/session/session-persistence-jsonl/src/format.ts'
import { describe, expect, it } from 'vitest'

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'expected/semantic-checkpoint')
const replayFixture = join(fixtureDir, 'replay.jsonl')
const replayOverride = join(fixtureDir, 'replay.override.json')
const sessionExpected = join(fixtureDir, 'session.expected.jsonl')
const configPath = fileURLToPath(new URL('../semantic-checkpoint-snapshot.patch.yml', import.meta.url))
const binScript = fileURLToPath(new URL('../../../../../../packages/test-support/loader-smoke/tests/fixtures/headless-driver.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../../../tsconfig.json', import.meta.url))
const sessionId = SessionId('semantic-checkpoint-unknown-outcome')
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'
const task = 'Continue safely from the interrupted operation.'

async function seedInterruptedSession(root: string, cwd: string): Promise<string> {
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
    { type: 'user/message', seq: SessionSeq(1), time: 11, data: createUserMessage({
      content: [{ type: 'text', text: 'Perform one side-effecting remote mutation.' }], source: { kind: 'user' },
    }), surfaceOp: 'append' },
    { type: 'step/start', seq: SessionSeq(2), time: 12, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      seq: SessionSeq(3),
      time: 13,
      data: {
        turn: 1,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'tool-call', id: ToolCallId('unknown-outcome-call'), name: 'write_remote', arguments: '{"value":1}' }],
          source: {
            kind: 'model',
            ...{ provider: 'deepseek-official', model: 'deepseek-v4-flash' },
          },
        }),
      },
      surfaceOp: 'append',
    },
    {
      type: 'tool/call',
      seq: SessionSeq(4),
      time: 14,
      data: {
        turn: 1,
        step: 1,
        callId: ToolCallId('unknown-outcome-call'),
        name: 'write_remote',
        arguments: '{"value":1}',
      },
    },
  ]
  try {
    const handle = await ctx.sessionPersistence.create(meta)
    await handle.append(events)
    await handle.close()
    return logPath(root, meta.cwd, meta.id, 'none')
  } finally {
    await ctx.fiber.dispose()
  }
}

describe('semantic checkpoint recovery snapshot', () => {
  it('resumes an unknown tool outcome through the headless stream-json app', async () => {
    let cwd = ''
    let sessionPath = ''
    const result = await runLoaderSmoke({
      label: 'semantic checkpoint headless stream-json snapshot',
      tempDirPrefix: 'dsh-semantic-snapshot-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, task],
      tsconfigPath,
      env: {
        DSH_SNAPSHOT_FILE: replayFixture,
        DSH_SNAPSHOT_OVERRIDE: replayOverride,
      },
      prepare: async (runCwd) => {
        cwd = runCwd
        sessionPath = await seedInterruptedSession(join(runCwd, '.sessions'), runCwd)
      },
      inspect: async () => {
        const normalization: NormalizeContext = { sessionIds: [sessionId], cwd }
        const session = normalizeSessionSnapshot(await readFile(sessionPath, 'utf8'), normalization)
        if (refreshing) await writeFile(sessionExpected, session)
        expect(session).toBe(await readFile(sessionExpected, 'utf8'))
        expect(session).toContain('TOOL_OUTCOME_UNKNOWN')
        expect(session).toContain('Do not retry blindly.')
      },
    })

    expect(result.stderr).toBe('')
    const records = result.stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(records.at(-1)).toMatchObject({
      type: 'result',
      sessionId,
      output: 'I will verify the external state before deciding whether to retry the side-effecting operation.',
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
