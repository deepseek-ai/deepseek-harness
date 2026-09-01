import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolTasks from '@deepseek-ai/dsh-tool-jobs'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Full-loop integration: a scripted mock model drives the REAL bash tool
 * through the agent loop, exercising the same execution paths a live model would
 * (tool/call + tool/result session events, the generic `ctx.jobs` runtime,
 * agent.inject completion notices).
 */
async function harness(adapter: MockAdapter, sessionRoot?: string, dshHome?: string) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  // AgentLoop declares the registry as a required injection.
  await ctx.plugin(SessionProjectionRegistry)
  if (sessionRoot !== undefined) {
    await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot, compression: 'none' })
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(ToolTasks)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(BashEnvPlugin, dshHome === undefined ? {} : { dshHome })
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  await ctx.plugin(ToolBash)
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

const dirs: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function events(agent: Agent): readonly SessionEvent[] {
  return agent.session.snapshotEvents()
}

/** Find a session event by type, narrowed; throws when absent. */
function findEvent<T extends SessionEvent['type']>(
  log: readonly SessionEvent[],
  type: T,
  position: 'first' | 'last' = 'first',
): Extract<SessionEvent, { type: T }> {
  const found = position === 'first'
    ? log.find(event => event.type === type)
    : log.findLast(event => event.type === type)
  if (!found) throw new Error(`no ${type} event in the session log`)
  return found as Extract<SessionEvent, { type: T }>
}

function resultText(event: SessionEvent): string {
  if (event.type !== 'tool/result') return ''
  return event.data.message.content[0].content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Poll until `predicate` holds (background settlement races turn end). */
async function pollUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`condition not met within ${timeoutMs}ms`)
}

describe('bash tool through the agent loop', () => {
  it('first-turn bash receives session identity before the lazy JSONL file materializes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-bash-session-env-'))
    dirs.push(root)
    const dshHome = join(root, 'dsh-home')
    vi.stubEnv('DSH_STALE_PARENT', 'stale')
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'bash', {
        command: 'printf \'%s\\n%s\\n%s\\n%s\\n%s\\n\' "$DSH_HOME" "$DSH_SHELL" "$DSH_SESSION_ID" "$DSH_SESSION_JSONL" "${DSH_STALE_PARENT-unset}"; if [ -e "$DSH_SESSION_JSONL" ]; then printf \'present\\n\'; else printf \'absent\\n\'; fi',
        description: 'inspect session environment',
      }),
      textResponse('Session environment inspected.'),
    ])
    const ctx = await harness(adapter, root, dshHome)
    const handle = await ctx.agents.create({
      sessionId: SessionId('session-env-id'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const agent = handle.agent
    const location = ctx.sessionPersistence.locate(agent.session.header)
    expect(location?.kind).toBe('jsonl')

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'inspect the current session' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const result = findEvent(events(agent), 'tool/result')
    expect(resultText(result)).toBe(`${dshHome}\n1\nsession-env-id\n${location?.path}\nunset\nabsent\n`)
    await ctx.sessions.flush(agent.session)
    expect(existsSync(location!.path)).toBe(true)
    const header = JSON.parse(readFileSync(location!.path, 'utf8').split('\n')[0]!) as { type: string; id: string }
    expect(header).toMatchObject({ type: 'session', id: 'session-env-id' })
    await handle.dispose()
  })

  it('foreground: model calls bash, sees the result, replies', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'bash', { command: 'echo integration-ok', description: 'test command' }, 'Running it.'),
      textResponse('The command printed integration-ok.'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('it-fg'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run echo integration-ok' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const log = events(agent)
    const toolCall = findEvent(log, 'tool/call')
    expect(toolCall.data.name).toBe('bash')

    const toolResult = findEvent(log, 'tool/result')
    expect(toolResult.data.message.content[0].isError).toBe(false)
    expect(resultText(toolResult)).toBe('integration-ok\n')

    // The second model call saw the tool result in its derived history.
    const lastRequest = adapter.requests.at(-1)
    const toolResultBlocks = (lastRequest?.messages ?? [])
      .flatMap(message => message.content)
      .filter(block => block.type === 'tool-result')
    expect(toolResultBlocks).toHaveLength(1)

    const finalMessage = findEvent(log, 'assistant/message', 'last')
    expect(finalMessage.data.message.content.some(
      block => block.type === 'text' && block.text.includes('integration-ok'),
    )).toBe(true)
  })

  it('foreground: non-zero exit is reported in the result text, not as isError', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'bash', { command: 'exit 9', description: 'test command' }),
      textResponse('It failed with code 9.'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('it-exit'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run exit 9' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const toolResult = findEvent(events(agent), 'tool/result')
    expect(toolResult.data.message.content[0].isError).toBe(false)
    expect(resultText(toolResult)).toContain('[exit code: 9]')
  })

  it('background: start ack → completion wakes the idle agent → job_output collects it', async () => {
    // The command blocks on a sentinel this test creates only after the agent
    // has gone idle, so settlement cannot fold into the still-running turn.
    // Without that fence a fast command can settle before step 2's pre-step
    // claim, which folds the notice into a turn whose scripted reply is final:
    // the turn then closes with an empty next-step inbox and the collection
    // entries are never reached.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-bg-'))
    dirs.push(dir)
    const sentinel = join(dir, 'release')
    // The job id is deterministic (a fresh LocalJobRegistry counts per kind from 1),
    // so the script can name `bash-1` without threading a generated id.
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'bash', {
        command: `while [ ! -f ${JSON.stringify(sentinel)} ]; do sleep 0.02; done; echo bg-ok`,
        description: 'test command',
        run_in_background: true,
      }),
      textResponse('Started it in the background.'),
      toolCallResponse('call-2', 'job_output', { job_id: 'bash-1' }),
      textResponse('Background job finished.'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('it-bg'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run echo bg-ok in the background' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const firstResult = findEvent(events(agent), 'tool/result')
    expect(firstResult.data.message.content[0].isError).toBe(false)
    expect(resultText(firstResult)).toBe('started background job bash-1')
    // The turn closed with the task still running, so the notice cannot exist yet.
    const isNotice = (e: SessionEvent): e is SessionEvent<'user/message'> =>
      e.type === 'user/message' && e.data.source.kind === 'plugin'
    expect(events(agent).some(isNotice)).toBe(false)

    // Releasing the command now settles it against a provably idle owner. No
    // second user message: the wake alone opens the turn that collects it.
    writeFileSync(sentinel, '')
    const lastResultText = (): string => {
      const found = events(agent).findLast(event => event.type === 'tool/result')
      return found === undefined ? '' : resultText(found)
    }
    await pollUntil(() => events(agent).some(isNotice) && lastResultText().includes('bg-ok'))
    // Two turns: the user's, then the one the completion opened by itself.
    expect(events(agent).filter(event => event.type === 'turn/start')).toHaveLength(2)

    // The notice carries the gated command as its label, so this pins the id,
    // the terminal status, and the producer identity; the verbatim notice text
    // and its bounding are pinned in the tool-jobs unit tests.
    const notice = events(agent).find(isNotice)!
    const noticeText = notice.data.content
      .filter(block => block.type === 'text').map(block => block.text).join('')
    expect(noticeText).toContain('background job bash-1 (bash: ')
    expect(noticeText).toContain('finished [status: completed, exit code: 0]')
    expect(notice.data.source).toMatchObject({
      kind: 'plugin',
      plugin: 'tool-jobs',
      form: 'notice',
    })
    const readResult = findEvent(events(agent), 'tool/result', 'last')
    expect(readResult.data.message.content[0].isError).toBe(false)
    expect(resultText(readResult)).toContain('bg-ok')
    expect(resultText(readResult)).toContain('[status: completed, exit code: 0]')
  })
})
