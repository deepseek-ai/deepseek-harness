/** Recorded Web subagent composition, tool restrictions, and human-message attribution. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SubagentPromptRequestId } from '@deepseek-ai/dsh-subagent'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
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
  const expected = await Promise.all(paths.map(path => readFile(path, 'utf8')))
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

    const childPrompt = fixtureChildInputs(expected[1]!)[0]
    if (childPrompt === undefined) throw new Error('child fixture has no delegated task')
    const activation = await scaffold.ctx.subagents.startActivation({
      provider: 'fork', label: 'Check child reminder refusal', delivery: 'caller',
      signal: new AbortController().signal,
      parent, prompt: childPrompt,
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

    const results = child.snapshotEvents().slice(child.inheritedEventCount)
      .filter(event => event.type === 'tool/result')
    expect(results.map(event => event.data.message.content)).toEqual(Array.from({ length: 4 }, () => [
      { type: 'text', text: '{"code":"subagent_session","message":"A delegated subagent cannot use scheduled tasks."}' },
    ]))
    expect((await scaffold.ctx.schedule.list({ active: true })).items).toEqual([])

    await assertSubagentSessions(scaffold, sessions, paths, expected)
  } finally {
    await scaffold.close()
  }
})

const HUMAN_DIR = fileURLToPath(new URL('../../../snapshots/web/subagent-human-message', import.meta.url))

it.skipIf(MODE === 'record')('distinguishes the delegated task from a direct human message after a Web subagent cold resume', async () => {
  const paths = await Promise.all(['session.v4.jsonl', 'session.1.v4.jsonl']
    .map(file => selectedSessionFixture(join(HUMAN_DIR, file))))
  const expected = await Promise.all(paths.map(path => readFile(path, 'utf8')))
  const scaffold = await launchWebScaffold({
    replayFixture: paths[0]!, replayChildFixtures: [paths[1]!], compareReplaySession: false,
  })
  try {
    const { sessionId } = await scaffold.ctx.sessionController.create({ cwd: scaffold.workspaceCwd })
    const parent = scaffold.ctx.agents.get(sessionId)!
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: fixtureUserPrompts(expected[0]!)[0]! }],
      source: { kind: 'user', rpcId: brandString<SubagentPromptRequestId>('root-question') },
    }))
    await parent.whenIdle()
    let child: Session | undefined
    scaffold.ctx.on('subagent/start', (info) => { child = scaffold.ctx.agents.get(info.id)!.session })
    const inputs = fixtureChildInputs(expected[1]!)
    const activation = await scaffold.ctx.subagents.startActivation({
      provider: 'fork', label: 'Identify direct human messages', delivery: 'caller',
      parent, prompt: inputs[0]!, signal: new AbortController().signal,
    })
    try {
      await activation.result
    } finally {
      await activation.dispose()
    }
    expect(scaffold.ctx.agents.get(activation.childId)).toBeUndefined()
    const settled = Promise.withResolvers<undefined>()
    scaffold.ctx.on('subagent/end', (info) => {
      if (info.id === activation.childId) settled.resolve(undefined)
    })
    const content = inputs[1]!.map((block) => {
      if (block.type !== 'text') throw new Error('human fixture input must be text')
      return block
    })
    const receipt = await scaffold.ctx.subagents.prompt({
      childSessionId: activation.childId,
      requestId: brandString<SubagentPromptRequestId>('human-question'), delivery: 'steer', content,
    }, new AbortController().signal)
    await settled.promise
    await parent.whenIdle()
    await scaffold.ctx.sessions.flush(parent.session)
    if (child === undefined) throw new Error('subagent start did not expose its Session')
    const received = child.deriveMessages().find(message => message.id === receipt.messageId)
    expect(received).toMatchObject({
      source: { kind: 'user', rpcId: 'human-question' },
      content,
    })
    await assertSubagentSessions(scaffold, [parent.session, child], paths, expected)
  } finally {
    await scaffold.close()
  }
})

/** Compare durable parent/child logs and the shared Web request-header pins. */
async function assertSubagentSessions(
  scaffold: Awaited<ReturnType<typeof launchWebScaffold>>,
  sessions: Session[],
  paths: string[],
  expected: string[],
): Promise<void> {
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
}

/** Read the child's admitted inputs, removing the parent prefix when recreating its initial task. */
function fixtureChildInputs(log: string): ContentBlock[][] {
  const events = parseSessionLog(log)
  const start = events.findLastIndex(event => event.type === 'subagent/descriptor')
  return events.slice(start + 1).flatMap(event => event.type === 'agent/inbox/spliced'
    ? event.data.inserted.map(message => message.source.kind === 'agent-message'
      ? message.content.slice(1)
      : [...message.content])
    : [])
}
