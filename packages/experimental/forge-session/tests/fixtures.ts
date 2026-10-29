import { Context } from '@deepseek-ai/cordis'
import ForgeService, { changeRequestKey } from '@deepseek-ai/dsh-experimental-forge'
import type {
  ChangeRequestKey, ChangeRequestRef, ChangeRequestSnapshot, ForgeActionFailure, ForgeFailure, ForgeProvider, ForgeReadiness,
  ForgeRepository,
} from '@deepseek-ai/dsh-experimental-forge'
import { createAssistantMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ForgeSessionService from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** Repository served by {@link FakeProvider}. */
export const demo: ForgeRepository = { forge: 'fake', host: 'fake.test', owner: 'octo', name: 'demo' }

/** Pull request reference in `demo`. */
export function pull(number: number): ChangeRequestRef {
  return { repository: demo, number }
}

/** Canonical URL of a `demo` pull request. */
export function pullUrl(number: number): string {
  return `https://fake.test/octo/demo/pull/${number}`
}

/** Open pull request snapshot with settled checks. */
export function snapshot(ref: ChangeRequestRef, overrides: Partial<ChangeRequestSnapshot> = {}): ChangeRequestSnapshot {
  return {
    ref,
    url: pullUrl(ref.number),
    title: `Change ${ref.number}`,
    state: 'open',
    draft: false,
    author: 'octo',
    headBranch: 'feat',
    headSha: 'a'.repeat(40),
    baseBranch: 'main',
    additions: 12,
    deletions: 3,
    mergeability: 'mergeable',
    mergeReady: true,
    mergeMethods: ['squash', 'merge', 'rebase'],
    reviewDecision: 'none',
    checks: [],
    checksRollup: 'success',
    checksTruncated: false,
    unresolvedThreads: 0,
    updatedAt: '2026-10-09T00:00:00Z',
    closedAt: null,
    ...overrides,
  }
}

/** Provider for `fake.test` remotes (`fake.test:owner/name.git`) and `https://fake.test/owner/name/pull/N` URLs. */
export class FakeProvider implements ForgeProvider {
  readonly forge = 'fake'
  /** Change requests returned by head lookups, keyed by branch. */
  readonly heads = new Map<string, readonly ChangeRequestRef[]>()
  /** Every head lookup in call order. */
  readonly lookups: { readonly repository: ForgeRepository; readonly branch: string; readonly signal: AbortSignal }[] = []
  /** Every fetch batch in call order. */
  readonly fetches: (readonly number[])[] = []
  /** Replaces the head lookup when set. */
  findImpl: ((branch: string, signal: AbortSignal) => Promise<readonly ChangeRequestRef[]>) | undefined

  repositoryFromRemote(url: string): ForgeRepository | undefined {
    const match = /^fake\.test:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url)
    return match === null ? undefined : { ...demo, owner: match[1] ?? '', name: match[2] ?? '' }
  }

  changeRequestFromUrl(url: string): ChangeRequestRef | undefined {
    const match = /^https?:\/\/fake\.test\/([^/]+)\/([^/]+)\/pull\/(\d+)/i.exec(url)
    return match === null ? undefined : { repository: { ...demo, owner: match[1] ?? '', name: match[2] ?? '' }, number: Number(match[3]) }
  }

  changeRequestUrl(ref: ChangeRequestRef): string {
    return `https://fake.test/${ref.repository.owner}/${ref.repository.name}/pull/${ref.number}`
  }

  fetch(refs: readonly ChangeRequestRef[]): Promise<ReadonlyMap<ChangeRequestKey, ChangeRequestSnapshot | ForgeFailure>> {
    this.fetches.push(refs.map(ref => ref.number))
    return Promise.resolve(new Map(refs.map(ref => [changeRequestKey(ref), snapshot(ref)])))
  }

  findByHead(repository: ForgeRepository, branch: string, signal: AbortSignal): Promise<readonly ChangeRequestRef[]> {
    this.lookups.push({ repository, branch, signal })
    if (this.findImpl !== undefined) return this.findImpl(branch, signal)
    return Promise.resolve(this.heads.get(branch) ?? [])
  }

  readiness(): Promise<ForgeReadiness> {
    return Promise.resolve({ state: 'ready', message: null })
  }

  markReady(): Promise<ForgeActionFailure | undefined> {
    return Promise.resolve(undefined)
  }

  merge(): Promise<ForgeActionFailure | undefined> {
    return Promise.resolve(undefined)
  }

  diff(): Promise<string | ForgeFailure> {
    return Promise.resolve('')
  }

  fileText(): Promise<string | ForgeFailure> {
    return Promise.resolve('')
  }

  fileUrl(ref: ChangeRequestRef, commit: string, path: string): string {
    return `https://fake.test/${ref.repository.owner}/${ref.repository.name}/blob/${commit}/${path}`
  }
}

/** Live services and one store-created Session. */
export interface Bench {
  readonly ctx: Context
  readonly provider: FakeProvider
  readonly session: Session
  /** Fiber of the `forgeSession` plugin. */
  readonly service: ReturnType<Context['plugin']>
}

/**
 * Mount the Session store, projections, `forge` with a {@link FakeProvider}, and `forgeSession`.
 * @param config - `forgeSession` configuration.
 * @returns the context, the provider, one live Session, and the service fiber.
 */
export async function bench(config: Config = {}): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ForgeService, { activeIntervalMs: 1_000, idleIntervalMs: 60_000, maxBackoffMs: 60_000, fetchTimeoutMs: 1_000 })
  const provider = new FakeProvider()
  await ctx.plugin({ inject: ['forge'], apply(child: Context) { child.forge.register(provider) } })
  const service = ctx.plugin(ForgeSessionService, config)
  await service
  return { ctx, provider, session: ctx.sessions.create(), service }
}

/** One shell call and the text its result carries. */
export interface ShellCall {
  readonly callId: string
  readonly command: string
  readonly output: string
  readonly tool?: string
  readonly isError?: boolean
}

const turns = new WeakMap<Session, number>()

/**
 * Append one completed turn in which the model runs `calls` in a single step.
 * @param session - live Session receiving the events.
 * @param calls - shell calls with their rendered results.
 */
export function shellTurn(session: Session, calls: readonly ShellCall[]): void {
  const turn = (turns.get(session) ?? 0) + 1
  turns.set(session, turn)
  const step = 1
  const callArguments = (call: ShellCall) => JSON.stringify({ command: call.command })
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step })
  session.append('assistant/message', {
    turn,
    step,
    stream: [],
    message: createAssistantMessage({
      content: calls.map(call => ({ type: 'tool-call' as const, id: ToolCallId(call.callId), name: call.tool ?? 'bash', arguments: callArguments(call) })),
      source: { provider: 'fixture', model: 'fixture' },
    }),
  }, { surfaceOp: 'append' })
  for (const call of calls) {
    session.append('tool/call', { turn, step, callId: ToolCallId(call.callId), name: call.tool ?? 'bash', arguments: callArguments(call) })
  }
  for (const call of calls) {
    session.append('tool/result', {
      turn,
      step,
      message: createToolResultMessage({ callId: ToolCallId(call.callId), content: [{ type: 'text', text: call.output }], isError: call.isError ?? false }),
    }, { surfaceOp: 'append' })
  }
  session.append('step/end', { turn, step })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Rendered `bash` result of a `git push` that created `branch` on the `fake.test:octo/demo.git` remote. */
export function pushOutput(branch: string, remote = 'fake.test:octo/demo.git'): string {
  return [
    `branch '${branch}' set up to track 'origin/${branch}'.`,
    '[stderr]',
    'remote: ',
    `remote: Create a pull request for '${branch}' on Fake by visiting:`,
    `remote:      https://fake.test/octo/demo/pull/new/${branch}`,
    'remote: ',
    `To ${remote}`,
    ` * [new branch]      ${branch} -> ${branch}`,
  ].join('\n')
}
