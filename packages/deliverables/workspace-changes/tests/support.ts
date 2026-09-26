/** Shared fixtures: temporary git repositories, logged turns, and event readers. */
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type { WorkspaceChangesSummary } from '../src/types.ts'

let callNumber = 0

/** Run git synchronously inside a fixture repository. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** A temporary directory removed by the returned cleanup. */
export async function scratchDir(prefix: string, cleanups: Array<() => Promise<unknown>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Open a turn with its first step. */
export function startTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
}

/** Log one settled tool call with an optional result `meta`. */
export function toolCall(session: Session, turn: number, name: string, args: unknown, result: { meta?: unknown; isError?: boolean } = {}) {
  const callId = ToolCallId(`call-${++callNumber}`)
  const serialized = JSON.stringify(args)
  session.append('assistant/message', {
    stream: [], turn, step: 1,
    message: createAssistantMessage({
      content: [{ type: 'tool-call', id: callId, name, arguments: serialized }],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
  const source = session.append('tool/call', { turn, step: 1, callId, name, arguments: serialized })
  return session.append('tool/result', {
    turn, step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'ok' }], isError: result.isError ?? false }),
    ...result.meta === undefined ? {} : { meta: result.meta as never },
  }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
}

/**
 * Apply a file-tool mutation the way the runtime does: announce it through
 * `tools/pre-execute` so the recorder captures the path, apply it, then log
 * the settled call.
 */
export async function mutate(
  ctx: Context, session: Session, turn: number, name: string, args: unknown, apply: () => Promise<void>,
  result: { meta?: unknown; isError?: boolean } = {},
) {
  await ctx.waterfall('tools/pre-execute', { agent: { session }, name, arguments: args } as never, () => Promise.resolve(undefined as never))
  await apply()
  return toolCall(session, turn, name, args, result)
}

/** Close the step and the turn. */
export function endTurn(session: Session, turn: number, reason: 'completed' | 'blocked' = 'completed'): void {
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: reason } })
}

/** Wait for the plugin's queued git work through the same waterfall tool execution uses. */
export async function settle(ctx: Context, session: Session): Promise<void> {
  await ctx.waterfall('tools/pre-execute', { agent: { session } } as never, () => Promise.resolve(undefined as never))
}

/** The summaries the Host still serves for one session's `workspace/changes` events, in log order. */
export function changes(ctx: Context, session: Session): WorkspaceChangesSummary[] {
  return session.snapshotEvents()
    .filter(event => event.type === 'workspace/changes')
    .map(event => ctx.workspaceChanges.summary(session.id, event.seq))
    .filter(summary => summary !== undefined)
}
