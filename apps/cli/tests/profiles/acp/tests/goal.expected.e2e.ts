import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  fixtureContext,
  normalizeSessionSnapshot,
  normalizeSessionSnapshots,
  normalizeStdout,
  runScenario,
  type AgentUnderTest,
  type InputScript,
  type NormalizeContext,
} from '@deepseek-ai/dsh-session-snapshot'
import { foldGoal } from '@deepseek-ai/dsh-goal'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'

// This lifecycle proof has goal-specific timestamp normalization and semantic
// assertions, so it owns a separate snapshot root from the generic suite.
const scenarioDir = join(dirname(fileURLToPath(import.meta.url)), 'goal-expected/goal-round-driver')
const fixtureFile = join(scenarioDir, 'session.jsonl')
const overrideFile = join(scenarioDir, 'replay.override.json')
const stdoutExpected = join(scenarioDir, 'stdout.expected.jsonl')
const sessionExpected = join(scenarioDir, 'session.expected.jsonl')
const wrapupDir = join(dirname(fileURLToPath(import.meta.url)), 'goal-expected/goal-wrapup')
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'

const agent: AgentUnderTest = {
  binScript: fileURLToPath(new URL('../../../../src/bin.ts', import.meta.url)),
  configPath: fileURLToPath(new URL('../../../../../../snapshots/acp/escalation-approved/cordis.yml', import.meta.url)),
  profile: 'acp',
  tsconfigPath: fileURLToPath(new URL('../../../../../../tsconfig.json', import.meta.url)),
}

interface JsonObject {
  [key: string]: unknown
}

/** Parse non-empty records from one JSONL artifact. */
function parseJsonl(content: string): JsonObject[] {
  return content.split('\n').filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as JsonObject)
}

/** Zero durable goal timestamps inside metadata records and rendered XML JSON. */
function normalizeGoalTimestamps(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/("(?:createdAt|updatedAt|clearedAt)":)\d+/g, '$10')
  }
  if (Array.isArray(value)) return value.map(normalizeGoalTimestamps)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      ['createdAt', 'updatedAt', 'clearedAt'].includes(key) && typeof item === 'number'
        ? 0
        : normalizeGoalTimestamps(item),
    ]))
  }
  return value
}

/** Normalize one persisted goal log after the shared snapshot scrubbers. */
function normalizeGoalLog(content: string, context: NormalizeContext): string {
  return normalizeGoalTimestamps(normalizeSessionSnapshot(content, context)) as string
}

/** Compare one current normalized goal log with its generation-aware committed fixture. */
async function expectGoalLog(actual: string, expectedPath: string): Promise<void> {
  const expected = await readFile(expectedPath, 'utf8')
  expect(normalizeSessionSnapshots([actual], fixtureContext(actual)).map(parseJsonl))
    .toEqual(normalizeSessionSnapshots([expected], fixtureContext(expected)).map(parseJsonl))
}

describe('same-session goal snapshot through the ACP automation driver', () => {
  it('runs exact automatic rounds in the shipped application and persists cancellation', async () => {
    const input = JSON.parse(await readFile(join(scenarioDir, 'input.json'), 'utf8')) as InputScript
    const result = await runScenario(input, {
      agent,
      mode: 'replay',
      fixtureFile,
      overrideFile,
      configPath: agent.configPath,
    })

    expect(result.stderr).toBe('')
    expect(result.sessionLogs).toHaveLength(1)
    const log = result.sessionLogs[0]
    if (log === undefined) throw new Error('goal snapshot did not persist its session')
    const records = parseJsonl(log.content)
    const events = records.slice(1) as unknown as SessionEvent[]
    const calls = events.filter(event => event.type === 'tool/call').map(event => event.data.name)
    expect(calls).toEqual(['create_goal', 'get_goal'])
    const rounds = events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'goal'
      && event.data.source.round > 0
      ? [event.data.source.round]
      : [])
    expect(rounds).toEqual([1, 2])
    expect(foldGoal(events)).toMatchObject({
      goal: {
        objective: 'Finish the ACP goal-round-driver snapshot proof',
        phase: 'paused',
        revision: 2,
        maxGoalRounds: 2,
      },
      roundsStarted: 2,
    })

    const context: NormalizeContext = {
      sessionIds: [result.sessionId, log.id].filter((id): id is string => id !== undefined),
      cwd: result.cwd,
    }
    const stdout = normalizeStdout(result.rawStdout, context)
    const session = normalizeGoalLog(log.content, context)
    if (refreshing) {
      await Promise.all([
        writeFile(stdoutExpected, stdout),
        writeFile(sessionExpected, session),
      ])
    }
    expect(stdout).toBe(await readFile(stdoutExpected, 'utf8'))
    await expectGoalLog(session, sessionExpected)
  })

  it('injects the wrap-up instruction after an autonomous completion and delivers a closing message', async () => {
    const input = JSON.parse(await readFile(join(wrapupDir, 'input.json'), 'utf8')) as InputScript
    const result = await runScenario(input, {
      agent,
      mode: 'replay',
      fixtureFile: join(wrapupDir, 'session.jsonl'),
      overrideFile: join(wrapupDir, 'replay.override.json'),
      configPath: agent.configPath,
    })

    expect(result.stderr).toBe('')
    expect(result.sessionLogs).toHaveLength(1)
    const log = result.sessionLogs[0]
    if (log === undefined) throw new Error('goal wrap-up snapshot did not persist its session')
    const records = parseJsonl(log.content)
    const events = records.slice(1) as unknown as SessionEvent[]
    const calls = events.filter(event => event.type === 'tool/call').map(event => event.data.name)
    expect(calls).toEqual(['create_goal', 'update_goal'])
    expect(foldGoal(events)).toMatchObject({
      goal: {
        objective: 'Finish the ACP goal wrap-up snapshot proof',
        phase: 'complete',
        revision: 2,
      },
      roundsStarted: 1,
    })
    // The wrap-up instruction is one plugin-sourced context injected after the
    // terminal tool result, and the model still answers inside the same turn.
    const wrapups = events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin' && event.data.source.plugin === 'tool-goal')
    expect(wrapups).toHaveLength(1)
    const wrapupText = wrapups.map(event => event.type === 'user/message' ? event.data.content : [])[0]
    expect(JSON.stringify(wrapupText)).toContain('<goal_complete>')
    const closing = events.filter(event => event.type === 'assistant/message')
      .flatMap(event => event.data.message.content)
      .filter(block => block.type === 'text' && block.text.startsWith('GOAL WRAP-UP'))
    expect(closing).toHaveLength(1)
    const roundTurnEnds = events.filter(event => event.type === 'turn/end' && event.data.turn === 2)
    expect(roundTurnEnds).toHaveLength(1)
    expect(roundTurnEnds[0]?.data).toMatchObject({ turn: 2, reason: { kind: 'completed' } })

    const context: NormalizeContext = {
      sessionIds: [result.sessionId, log.id].filter((id): id is string => id !== undefined),
      cwd: result.cwd,
    }
    const stdout = normalizeStdout(result.rawStdout, context)
    const session = normalizeGoalLog(log.content, context)
    const wrapupStdoutExpected = join(wrapupDir, 'stdout.expected.jsonl')
    const wrapupSessionExpected = join(wrapupDir, 'session.expected.jsonl')
    if (refreshing) {
      await Promise.all([
        writeFile(wrapupStdoutExpected, stdout),
        writeFile(wrapupSessionExpected, session),
      ])
    }
    expect(stdout).toBe(await readFile(wrapupStdoutExpected, 'utf8'))
    await expectGoalLog(session, wrapupSessionExpected)
  })
})
