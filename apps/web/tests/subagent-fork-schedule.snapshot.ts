/** Forked Web agents inherit the standard preset and refuse every reminder tool. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { parseSessionLog, prepareSessionSnapshotFixtureForComparison } from '@deepseek-ai/dsh-llm-replay'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  fixtureContext, normalizeSessionSnapshots, normalizedSystemPrompts, normalizedToolSchemas,
  formatSystemPromptSnapshot, parseToolSchemasSnapshot, redactSessionSnapshotIds, refreshFixtureReplacements,
  scrubSessionSnapshot, stabilizeFixtureMessageIds, stabilizeRefreshLog, tokenizeSessionFixtureCwd,
} from '@deepseek-ai/dsh-session-snapshot'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-subagent'
import {
  fixtureUserPrompts, launchWebScaffold, normalizeWebSessionVolatiles, rawSessionLog, readPersistedEvents,
  recordedSessionFixturePath, selectedSessionFixture, webSnapshotMode,
} from './scaffold.ts'
import { REPO_ROOT } from './support.ts'

const DIR = fileURLToPath(new URL('../../../snapshots/web/subagent-fork-schedule', import.meta.url))
const PIN = join(DIR, '../fresh-round-trip')
const MODE = webSnapshotMode()

it.skipIf(MODE === 'record')('replays inherited schedule tools and refusals in a seeded Web fork', async () => {
  const paths = await Promise.all(['session.v4.jsonl', 'session.1.v4.jsonl']
    .map(file => selectedSessionFixture(join(DIR, file))))
  let expected = await Promise.all(paths.map(path => readFile(path, 'utf8')))
  const scaffold = await launchWebScaffold({
    replayFixture: paths[0]!, replayChildFixtures: [paths[1]!], compareReplaySession: false,
  })
  try {
    const sessions: Session[] = []
    scaffold.ctx.on('session/created', (session) => { sessions.push(session) })
    const { sessionId } = await scaffold.ctx.sessionController.create({ cwd: scaffold.workspaceCwd })
    const parent = scaffold.ctx.agents.get(sessionId)
    if (parent === undefined) throw new Error('created parent has no Agent')
    const prompt = fixtureUserPrompts(expected[0]!)[0]
    if (prompt === undefined) throw new Error('parent fixture has no user prompt')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
    await parent.whenIdle()

    const childPrompt = parseSessionLog(expected[1]!).findLast(event => event.type === 'user/message'
      && event.data.source.kind === 'user')
    if (childPrompt?.type !== 'user/message') throw new Error('child fixture has no user prompt')
    const activation = await scaffold.ctx.subagents.startActivation({
      provider: 'fork', label: 'Check child reminder refusal', delivery: 'caller',
      signal: new AbortController().signal,
      request: { parent, prompt: [...childPrompt.data.content] },
    })
    try {
      await activation.result
    } finally {
      await activation.dispose()
    }
    await scaffold.ctx.sessions.flush(parent.session)
    expect(sessions).toHaveLength(2)
    const child = sessions[1]!
    expect(child.header).toMatchObject({ parentSession: parent.id, isSeeded: true, agentPreset: 'standard' })
    expect(child.inheritedEventCount).toBeGreaterThan(0)
    expect(child.requestHeader()).toEqual(parent.session.requestHeader())

    for (const session of sessions) {
      expect(await readPersistedEvents(scaffold, session.id)).toEqual(session.snapshotEvents())
    }
    const raw = sessions.map(session => normalizeWebSessionVolatiles(rawSessionLog(session), scaffold.workspaceCwd))
    const context = { sessionIds: sessions.map(session => String(session.id)), cwd: scaffold.workspaceCwd }
    const schemas = parseToolSchemasSnapshot(await readFile(join(PIN, 'tool-schemas.expected.json'), 'utf8'))
    const promptPin = await readFile(join(PIN, 'system-prompt.expected.md'), 'utf8')
    for (const log of raw) {
      const headers = normalizedToolSchemas(log, context)
      expect(headers.length).toBeGreaterThan(0)
      for (const tools of headers) expect(tools).toEqual(schemas.initial)
      for (const prompt of normalizedSystemPrompts(log, context)) {
        expect(formatSystemPromptSnapshot(prompt.split(REPO_ROOT).join('{{sourceRoot}}')
          .split(scaffold.baseUrl).join('{{webUrl}}'))).toBe(promptPin)
      }
    }
    const results = child.snapshotEvents().slice(child.inheritedEventCount)
      .filter(event => event.type === 'tool/result')
    expect(results.map(event => event.data.message.content)).toEqual(Array.from({ length: 4 }, () => [
      { type: 'text', text: '{"code":"subagent_session","message":"A delegated subagent cannot use scheduled tasks."}' },
    ]))
    expect((await scaffold.ctx.schedule.list({ active: true })).items).toEqual([])

    if (MODE === 'refresh') {
      const replacements = refreshFixtureReplacements(raw.map((content, index) => ({
        id: sessions[index]!.id, createdAt: sessions[index]!.header.createdAt, content,
      })), expected)
      expected = redactSessionSnapshotIds(stabilizeFixtureMessageIds(raw.map((log, index) =>
        tokenizeSessionFixtureCwd(scrubSessionSnapshot(stabilizeRefreshLog(
          prepareSessionSnapshotFixtureForComparison(log), expected[index]!, replacements, context,
        ))).split(scaffold.harnessHome).join('{{harnessHome}}')), expected))
      await Promise.all(expected.map((log, index) => writeFile(
        recordedSessionFixturePath(paths[index]!, sessions[index]!.header.version), log,
      )))
    }
    expect(normalizeSessionSnapshots(raw, context))
      .toEqual(normalizeSessionSnapshots(expected, fixtureContext(expected[0]!)))
  } finally {
    await scaffold.close()
  }
})
