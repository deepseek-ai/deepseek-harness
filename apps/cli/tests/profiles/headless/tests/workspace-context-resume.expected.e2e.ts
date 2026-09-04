/**
 * Assembled-app regression for persisted workspace-instruction resume state.
 * @module workspace-context-resume-snapshot
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import {
  fixtureContext,
  normalizeSessionSnapshot,
  normalizeSessionSnapshots,
  type NormalizeContext,
} from '@deepseek-ai/dsh-session-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionSeq,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { logPath } from '../../../../../../packages/session/session-persistence-jsonl/src/format.ts'
import { renderWorkspaceContext } from '@deepseek-ai/dsh-agent-instructions'
import { resolveConfig, workspaceBaselineIdentity } from '@deepseek-ai/dsh-agent-instructions/src/config.ts'
import { describe, expect, it } from 'vitest'

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'expected/workspace-context-resume/offline-edit')
const replayFixture = join(fixtureDir, 'replay.jsonl')
const replayOverride = join(fixtureDir, 'replay.override.json')
const sessionExpected = join(fixtureDir, 'session.expected.jsonl')
const precedenceExpected = join(dirname(fixtureDir), 'precedence-change/session.expected.jsonl')
const configPath = fileURLToPath(new URL('../workspace-context-resume-snapshot.patch.yml', import.meta.url))
const binScript = fileURLToPath(new URL('../../../../../../packages/test-support/loader-smoke/tests/fixtures/headless-driver.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../../../tsconfig.json', import.meta.url))
const sessionId = SessionId('workspace-context-resume')
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'
const oldInstruction = 'Old workspace instruction.'
const newInstruction = 'New workspace instruction after offline edit.'

/** Compare one current normalized Session with its generation-aware committed fixture. */
async function expectSession(actual: string, expectedPath: string): Promise<void> {
  const expected = await readFile(expectedPath, 'utf8')
  const parse = (content: string): Record<string, unknown>[] => content.split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>)
  expect(normalizeSessionSnapshots([actual], fixtureContext(actual)).map(parse))
    .toEqual(normalizeSessionSnapshots([expected], fixtureContext(expected)).map(parse))
}

interface SeedBaselineOptions {
  files?: Array<{ name: string; content: string }>
  instructionFileCandidates?: string[]
}

async function seedVisibleBaseline(
  root: string,
  cwd: string,
  options: SeedBaselineOptions = {},
): Promise<string> {
  const ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const meta: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 1,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
  }
  const files = options.files ?? [{ name: 'AGENTS.md', content: oldInstruction }]
  const baseline = renderWorkspaceContext(files.map(file => ({
    absolutePath: join(cwd, file.name),
    displayPath: file.name,
    content: file.content,
  })), { maxBytes: 65536 })
  const config = resolveConfig({
    dshHome: join(cwd, '.dsh'),
    maxBytes: 65536,
    ...options.instructionFileCandidates === undefined
      ? {}
      : { instructionFileCandidates: options.instructionFileCandidates },
  })
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: SessionSeq(0), time: 10, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: SessionSeq(1),
      time: 11,
      data: createUserMessage({ content: [{ type: 'text', text: 'Remember the workspace instruction.' }], source: { kind: 'user' } }),
      surfaceOp: 'append',
    },
    {
      type: 'user/message',
      seq: SessionSeq(2),
      time: 12,
      data: createUserMessage({
        content: [{ type: 'text', text: baseline.text }],
        source: {
          kind: 'agent-instructions',
          form: 'instructions',
          baseline: true,
          baselineIdentity: workspaceBaselineIdentity(config, cwd, cwd),
          changes: files.map(file => ({
            action: 'set',
            scope: `.\0${file.name}`,
            path: file.name,
            digest: createHash('sha1').update(file.content).digest('hex'),
          })),
        },
      }),
      surfaceOp: 'append',
    },
    { type: 'turn/end', seq: SessionSeq(3), time: 13, data: { turn: 1, reason: { kind: 'completed' } } },
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

describe('agent-instructions resume snapshot', () => {
  it('appends an offline replacement without duplicating the visible baseline', async () => {
    let cwd = ''
    let sessionPath = ''
    const result = await runLoaderSmoke({
      label: 'agent-instructions resume headless stream-json snapshot',
      tempDirPrefix: 'dsh-workspace-context-resume-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, 'Acknowledge the current workspace instruction.'],
      tsconfigPath,
      env: {
        DSH_SNAPSHOT_FILE: replayFixture,
        DSH_SNAPSHOT_OVERRIDE: replayOverride,
      },
      prepare: async (runCwd) => {
        cwd = runCwd
        await mkdir(join(runCwd, '.git'), { recursive: true })
        await writeFile(join(runCwd, 'AGENTS.md'), `${newInstruction}\n`)
        sessionPath = await seedVisibleBaseline(join(runCwd, '.sessions'), runCwd)
      },
      inspect: async () => {
        const normalization: NormalizeContext = { sessionIds: [sessionId], cwd }
        const session = normalizeSessionSnapshot(await readFile(sessionPath, 'utf8'), normalization)
        if (refreshing) await writeFile(sessionExpected, session)
        await expectSession(session, sessionExpected)

        const records = session.trimEnd().split('\n').map(line => JSON.parse(line) as {
          type?: string
          data?: {
            source?: { kind?: string; baseline?: boolean; changes?: Array<Record<string, unknown>> }
            content?: Array<{ type?: string; text?: string }>
          }
        })
        const workspaceEvents = records.filter(record => record.type === 'user/message'
          && record.data?.source?.kind === 'agent-instructions')
        expect(workspaceEvents.filter(record => record.data?.source?.baseline === true)).toHaveLength(1)
        expect(workspaceEvents.filter(record => record.data?.source?.baseline !== true)).toHaveLength(1)
        expect(workspaceEvents.at(-1)?.data?.source?.changes).toMatchObject([{
          action: 'replace', scope: '.\0AGENTS.md', path: 'AGENTS.md',
        }])
        expect(JSON.stringify(workspaceEvents.at(-1)?.data?.content)).toContain(newInstruction)

        const files = await readdir(join(cwd, '.sessions'), { recursive: true })
        expect(files.filter(file => file.endsWith('.jsonl'))).toHaveLength(1)
      },
    })

    expect(result.stderr).toBe('')
    const records = result.stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(records.at(-1)).toMatchObject({
      type: 'result',
      sessionId,
      output: 'RESUME_DONE',
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('supersedes an incompatible baseline when precedence changed offline', async () => {
    let cwd = ''
    let sessionPath = ''
    const result = await runLoaderSmoke({
      label: 'agent-instructions precedence-change resume snapshot',
      tempDirPrefix: 'dsh-workspace-context-precedence-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, 'Acknowledge the current workspace instruction.'],
      tsconfigPath,
      env: {
        DSH_SNAPSHOT_FILE: replayFixture,
        DSH_SNAPSHOT_OVERRIDE: replayOverride,
      },
      prepare: async (runCwd) => {
        cwd = runCwd
        await mkdir(join(runCwd, '.git'), { recursive: true })
        await writeFile(join(runCwd, 'AGENTS.md'), 'Current AGENTS rule.\n')
        await writeFile(join(runCwd, 'CLAUDE.md'), 'Current CLAUDE rule.\n')
        sessionPath = await seedVisibleBaseline(join(runCwd, '.sessions'), runCwd, {
          files: [
            { name: 'CLAUDE.md', content: 'Old CLAUDE rule.' },
            { name: 'AGENTS.md', content: 'Old AGENTS rule.' },
          ],
          instructionFileCandidates: ['CLAUDE.md', 'AGENTS.md'],
        })
      },
      inspect: async () => {
        const normalization: NormalizeContext = { sessionIds: [sessionId], cwd }
        const session = normalizeSessionSnapshot(await readFile(sessionPath, 'utf8'), normalization)
        if (refreshing) {
          await mkdir(dirname(precedenceExpected), { recursive: true })
          await writeFile(precedenceExpected, session)
        }
        await expectSession(session, precedenceExpected)

        const records = session.trimEnd().split('\n').map(line => JSON.parse(line) as {
          type?: string
          data?: {
            source?: { kind?: string; baseline?: boolean }
            content?: Array<{ type?: string; text?: string }>
          }
        })
        const baselines = records.filter(record => record.type === 'user/message'
          && record.data?.source?.kind === 'agent-instructions'
          && record.data.source.baseline === true)
        expect(baselines).toHaveLength(2)
        const replacement = JSON.stringify(baselines.at(-1)?.data?.content)
        expect(replacement).toContain('replaces all earlier workspace instruction baselines')
        expect(replacement.indexOf('Instructions from: AGENTS.md'))
          .toBeLessThan(replacement.indexOf('Instructions from: CLAUDE.md'))
      },
    })

    expect(result.stderr).toBe('')
    expect(result.stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>).at(-1))
      .toMatchObject({
        type: 'result',
        sessionId,
        output: 'RESUME_DONE',
      })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
