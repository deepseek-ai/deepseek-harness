/**
 * Assembled-app regressions for Session-format lifecycle behavior: released v0
 * migrates before resume without changing its source, while a future format or
 * unknown required event fails loud through the real Loader composition.
 * @module session-format-guard-snapshot
 */

import { join, dirname } from 'node:path'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionSeq,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {
  generationLogFilename,
  generationLogPath,
  logPath,
} from '../../../../../../packages/session/session-persistence-jsonl/src/format.ts'
import { describe, expect, it } from 'vitest'

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'expected/workspace-context-resume/offline-edit')
const replayFixture = join(fixtureDir, 'replay.jsonl')
const configPath = fileURLToPath(new URL('../workspace-context-resume-snapshot.patch.yml', import.meta.url))
const binScript = fileURLToPath(new URL('../../../../../../packages/test-support/loader-smoke/tests/fixtures/headless-driver.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../../../tsconfig.json', import.meta.url))
// The resumed-agent fixture in the shared config resumes exactly this id.
const sessionId = SessionId('workspace-context-resume')

/** Persist one session with the given header version and events, returning its log path. */
async function seedSession(root: string, cwd: string, version: number, events: SessionEvent[]): Promise<string> {
  if (version !== SESSION_FORMAT_VERSION) {
    const path = generationLogPath(root, cwd, sessionId, version, 'none')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, [
      JSON.stringify({ type: 'session', version, id: sessionId, createdAt: 1, cwd, delegationDepth: 0 }),
      ...events.map(event => JSON.stringify(event)),
      '',
    ].join('\n'))
    return path
  }
  const ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const meta: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 1,
    cwd,
    isSeeded: false,
  }
  try {
    const handle = await ctx.sessionPersistence.create(meta)
    await handle.append(events)
    await handle.close()
    return logPath(root, meta.cwd, meta.id, 'none')
  } finally {
    await ctx.fiber.dispose()
  }
}

function closedTurn(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

describe('session format guard through the assembled app', () => {
  it('migrates v0 before resume, preserves its source, and appends only to the current generation', async () => {
    let sourcePath = ''
    let source = Buffer.alloc(0)
    let sourceIdentity: { readonly dev: bigint; readonly ino: bigint } | undefined
    await runLoaderSmoke({
      label: 'v0 migration before resume',
      tempDirPrefix: 'dsh-format-migrate-v0-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, 'Continue the migrated session.'],
      tsconfigPath,
      env: { DSH_SNAPSHOT_FILE: replayFixture },
      prepare: async (runCwd) => {
        sourcePath = await seedSession(join(runCwd, '.sessions'), runCwd, 0, closedTurn())
        source = await readFile(sourcePath)
        const identity = await stat(sourcePath, { bigint: true })
        sourceIdentity = { dev: identity.dev, ino: identity.ino }
      },
      inspect: async () => {
        const currentPath = join(
          dirname(sourcePath),
          generationLogFilename(SESSION_FORMAT_VERSION, 'none'),
        )
        const current = await readFile(currentPath, 'utf8')
        const sourceAfter = await stat(sourcePath, { bigint: true })
        const currentIdentity = await stat(currentPath, { bigint: true })
        expect(await readFile(sourcePath)).toEqual(source)
        expect({ dev: sourceAfter.dev, ino: sourceAfter.ino }).toEqual(sourceIdentity)
        expect({ dev: currentIdentity.dev, ino: currentIdentity.ino }).not.toEqual(sourceIdentity)
        expect(JSON.parse(current.split('\n')[0] as string)).toMatchObject({
          version: SESSION_FORMAT_VERSION,
        })
        expect(current.trimEnd().split('\n').length).toBeGreaterThan(closedTurn().length + 1)
        // `session.lock` is the write handle's kernel lock file, published
        // with the first materializing write and kept across release.
        expect((await readdir(dirname(sourcePath))).sort())
          .toEqual(['session.jsonl', 'session.lock', generationLogFilename(SESSION_FORMAT_VERSION, 'none')])
      },
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('refuses to resume a newer-format log, naming the upgrade direction and the raw log path', async () => {
    let sessionPath = ''
    const result = await runLoaderSmoke({
      label: 'newer-format resume refusal',
      tempDirPrefix: 'dsh-format-guard-version-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, 'Try to resume.'],
      tsconfigPath,
      env: { DSH_SNAPSHOT_FILE: replayFixture },
      expectedExitCode: 1,
      prepare: async (runCwd) => {
        sessionPath = await seedSession(join(runCwd, '.sessions'), runCwd, SESSION_FORMAT_VERSION + 99, closedTurn())
      },
    })
    expect(result.stderr).toContain(
      `session "${sessionId}" uses log format v${SESSION_FORMAT_VERSION + 99}, but this harness reads only v${SESSION_FORMAT_VERSION}: the log was written by a newer harness — upgrade the harness to open it`,
    )
    // macOS reports the temp dir via the /private symlink parent; assert the
    // stable path suffix instead of the realpath-dependent prefix.
    expect(result.stderr).toContain('(raw log: ')
    expect(result.stderr).toContain(sessionPath.slice(sessionPath.indexOf('/.sessions/')))
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('refuses to resume a log with an unknown required event type', async () => {
    let sessionPath = ''
    const result = await runLoaderSmoke({
      label: 'unknown-event resume refusal',
      tempDirPrefix: 'dsh-format-guard-event-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, 'Try to resume.'],
      tsconfigPath,
      env: { DSH_SNAPSHOT_FILE: replayFixture },
      expectedExitCode: 1,
      prepare: async (runCwd) => {
        sessionPath = await seedSession(join(runCwd, '.sessions'), runCwd, SESSION_FORMAT_VERSION, [
          ...closedTurn(),
          { type: 'future/event', seq: SessionSeq(2), time: 3, data: { payload: 1 } } as unknown as SessionEvent,
        ])
      },
    })
    expect(result.stderr).toContain(
      `session "${sessionId}" contains event type "future/event" (seq 2) unknown to this harness and not marked ignorable; refusing to interpret the log — it was likely written by a newer harness`,
    )
    // macOS reports the temp dir via the /private symlink parent; assert the
    // stable path suffix instead of the realpath-dependent prefix.
    expect(result.stderr).toContain('(raw log: ')
    expect(result.stderr).toContain(sessionPath.slice(sessionPath.indexOf('/.sessions/')))
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
