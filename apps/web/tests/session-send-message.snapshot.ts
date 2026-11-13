/** An enabled Web session_send_message restores an ordinary Session elsewhere and attributes the real sender. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { prepareSessionSnapshotFixtureForComparison } from '@deepseek-ai/dsh-llm-replay'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  fixtureContext, formatSystemPromptSnapshot, formatToolSchemasSnapshot, normalizeSessionSnapshots,
  normalizedSystemPrompts, normalizedToolSchemas, redactSessionSnapshotIds, refreshFixtureReplacements,
  scrubSessionSnapshot, stabilizeFixtureMessageIds, stabilizeRefreshLog, tokenizeSessionFixtureCwd,
} from '@deepseek-ai/dsh-session-snapshot'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  launchWebScaffold, normalizeWebSessionVolatiles, rawSessionLog, readPersistedEvents,
  recordedSessionFixturePath, selectedSessionFixture, webSnapshotMode,
} from './scaffold.ts'
import { REPO_ROOT } from './support.ts'

const DIR = fileURLToPath(new URL('../../../snapshots/web/session-send-message', import.meta.url))
const OVERLAY = join(REPO_ROOT, 'apps/cli/config/examples/session-control.overlay.yml')
const MODE = webSnapshotMode()
const TARGET = brandString<SessionId>('snapshot-independent-recipient')
const SUBAGENT_TARGET = brandString<SessionId>('snapshot-unavailable-child')

it.skipIf(MODE === 'record')('delivers Web Session messages through the Session controller', async () => {
  const paths = await Promise.all(['session.v4.jsonl', 'session.1.v4.jsonl']
    .map(file => selectedSessionFixture(join(DIR, file))))
  let expected = await Promise.all(paths.map(path => readFile(path, 'utf8')))
  const scaffold = await launchWebScaffold({
    replayFixture: paths[0]!,
    replayChildFixtures: [paths[1]!],
    replayOverride: join(DIR, 'replay.override.json'),
    compareReplaySession: false,
    extraOverlayPath: OVERLAY,
  })
  try {
    const { ctx } = scaffold
    const sessions: Session[] = []
    ctx.on('session/created', (session) => { if (!sessions.includes(session)) sessions.push(session) })
    const { sessionId } = await ctx.sessionController.create({ cwd: scaffold.workspaceCwd })
    const sender = ctx.agents.get(sessionId)
    if (sender === undefined) throw new Error('created sender has no Agent')

    // A cold recipient in another directory proves the controller restores it on first delivery.
    const targetCwd = join(scaffold.workspaceCwd, '.agents', 'independent-recipient')
    await mkdir(targetCwd, { recursive: true })
    const recipient = await ctx.agents.create({ sessionId: TARGET, agentOptions: sender.options, meta: { cwd: targetCwd } })
    await ctx.sessions.flush(recipient.agent.session)
    await recipient.dispose()
    expect(ctx.agents.get(TARGET)).toBeUndefined()

    // An attached child of another root is unavailable through ordinary Session routing.
    const subagentTarget = ctx.sessions.create(SUBAGENT_TARGET, {
      meta: { cwd: targetCwd, origin: 'subagent', parentSession: TARGET },
    })
    const subagentEvents = subagentTarget.snapshotEvents()

    const results: { isError: boolean; text: string }[] = []
    ctx.on('tools/execute', async (exec, next) => {
      if (exec.name !== 'session_send_message') return next()
      const result = await next()
      const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
      results.push({ isError: result.isError, text })
      if (result.isError) return result
      // Settle the recipient before the sender's next step so both logs keep one order.
      const target = ctx.agents.get(TARGET)
      if (target === undefined) throw new Error('accepted recipient has no live Agent')
      await target.whenIdle()
      await ctx.sessions.flush(target.session)
      if (results.length === 2) await ctx.workspaceRegistry.archiveSession(TARGET)
      return result
    })

    sender.followup(createUserMessage({
      content: [{
        type: 'text',
        text: `Recipient Session: ${TARGET}\nSend FIRST and SECOND to the recipient with session_send_message, `
          + `then attempt THIRD after it is archived and FOURTH to subagent Session ${SUBAGENT_TARGET}. `
          + 'Reply with exactly SESSION_CONTROL_OK.',
      }],
      source: { kind: 'user' },
    }))
    await sender.whenIdle()
    await ctx.sessions.flush(sender.session)

    expect(results.map(result => result.isError)).toEqual([false, false, true, true])
    const receipts = results.slice(0, 2).map(result => (JSON.parse(result.text) as { message_id: string }).message_id)
    expect(new Set(receipts).size).toBe(2)
    expect(results[2]!.text).toContain('is archived; unarchive it before sending a message')
    expect(results[3]!.text).toBe(`Error: session "${SUBAGENT_TARGET}" is not available to session_send_message`)
    expect(subagentTarget.snapshotEvents()).toEqual(subagentEvents)
    expect(ctx.agents.get(SUBAGENT_TARGET)).toBeUndefined()

    // The restored recipient is a new Session object for the original identity.
    const target = sessions.findLast(session => session.id === TARGET)
    if (target === undefined || target === recipient.agent.session) throw new Error('recipient Session was not restored')
    expect(target.header).toMatchObject({ cwd: targetCwd })
    expect(target.header.origin).toBeUndefined()
    const delivered = target.snapshotEvents().flatMap(event => event.type === 'user/message'
      && event.data.source.kind === 'agent-message' ? [event.data] : [])
    expect(delivered.map(message => message.id)).toEqual(receipts)
    for (const message of delivered) {
      expect(message.source).toEqual({ kind: 'agent-message', form: 'relay', senderSessionId: sender.id })
    }

    const ordered = [sender.session, target]
    for (const session of ordered) {
      expect(await readPersistedEvents(scaffold, session.id)).toEqual(session.snapshotEvents())
    }
    const raw = ordered.map(session => normalizeWebSessionVolatiles(rawSessionLog(session), scaffold.workspaceCwd, 'workspace'))
    const context = { sessionIds: ordered.map(session => String(session.id)), cwd: scaffold.workspaceCwd }
    const prompts = normalizedSystemPrompts(raw[0]!, context).map(prompt => prompt
      .split(REPO_ROOT).join('{{sourceRoot}}').split(scaffold.baseUrl).join('{{webUrl}}'))
    const schemas = normalizedToolSchemas(raw[0]!, context)
    const promptSnapshot = formatSystemPromptSnapshot(prompts[0]!, prompts.slice(1))
    const schemaSnapshot = formatToolSchemasSnapshot(schemas[0] as unknown[], schemas.slice(1))
    for (const tools of normalizedToolSchemas(raw[1]!, context)) expect(tools).toEqual(schemas[0])

    if (MODE === 'refresh') {
      const replacements = refreshFixtureReplacements(raw.map((content, index) => ({
        id: ordered[index]!.id, createdAt: ordered[index]!.header.createdAt, content,
      })), expected)
      expected = redactSessionSnapshotIds(stabilizeFixtureMessageIds(raw.map((log, index) =>
        tokenizeSessionFixtureCwd(scrubSessionSnapshot(stabilizeRefreshLog(
          prepareSessionSnapshotFixtureForComparison(log), expected[index]!, replacements, context,
        )), scaffold.workspaceCwd).split(scaffold.harnessHome).join('{{harnessHome}}')), expected))
      await Promise.all([
        ...expected.map((log, index) => writeFile(recordedSessionFixturePath(paths[index]!, ordered[index]!.header.version), log)),
        writeFile(join(DIR, 'system-prompt.expected.md'), promptSnapshot),
        writeFile(join(DIR, 'tool-schemas.expected.json'), schemaSnapshot),
      ])
    }
    expect(normalizeSessionSnapshots(raw, context))
      .toEqual(normalizeSessionSnapshots(expected, fixtureContext(expected[0]!)))
    expect(promptSnapshot).toBe(await readFile(join(DIR, 'system-prompt.expected.md'), 'utf8'))
    expect(schemaSnapshot).toBe(await readFile(join(DIR, 'tool-schemas.expected.json'), 'utf8'))
  } finally {
    await scaffold.close()
  }
})
