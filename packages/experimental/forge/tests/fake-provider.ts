import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import ForgeService, { changeRequestKey } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type {
  ChangeRequestBrief, ChangeRequestKey, ChangeRequestRef, ChangeRequestSnapshot, ForgeActionFailure, ForgeFailure, ForgeProvider,
  ForgeReadiness, ForgeRepository, MergeRequest,
} from '../src/types.ts'

type FetchResult = ReadonlyMap<ChangeRequestKey, ChangeRequestSnapshot | ForgeFailure>
type BriefResult = ReadonlyMap<ChangeRequestKey, ChangeRequestBrief | ForgeFailure>

/** Repository served by the default fake provider. */
export const demo: ForgeRepository = { forge: 'fake', host: 'fake.test', owner: 'Octo', name: 'Demo' }

/** Build a change request reference in `demo` or another repository. */
export function ref(number: number, repository: ForgeRepository = demo): ChangeRequestRef {
  return { repository, number }
}

/** Build an open, mergeable snapshot whose checks passed. */
export function snapshot(target: ChangeRequestRef, overrides: Partial<ChangeRequestSnapshot> = {}): ChangeRequestSnapshot {
  return {
    ref: target,
    url: `https://${target.repository.host}/${target.repository.owner}/${target.repository.name}/change/${target.number}`,
    title: `Change ${target.number}`,
    state: 'open',
    draft: false,
    author: 'octo',
    headBranch: 'topic',
    headSha: 'a'.repeat(40),
    baseBranch: 'main',
    additions: 12,
    deletions: 3,
    mergeability: 'mergeable',
    mergeReady: true,
    mergeMethods: ['squash', 'merge', 'rebase'],
    branchUpdates: [],
    reviewDecision: 'none',
    reviewers: [],
    reviewersTruncated: false,
    canRequestReviews: false,
    checks: [],
    checksRollup: 'success',
    checksTruncated: false,
    canRerunChecks: false,
    unresolvedThreads: 0,
    threadsTruncated: false,
    closingIssues: [],
    closingIssuesTruncated: false,
    updatedAt: '2026-10-09T00:00:00Z',
    closedAt: null,
    ...overrides,
  }
}

/** A scripted provider that records every call. */
export class FakeProvider implements ForgeProvider {
  readonly forge: string
  readonly hosts: readonly string[]
  readonly label = 'Fake'
  readonly changeRequestNoun = 'pull-request'
  readonly fetches: (readonly ChangeRequestRef[])[] = []
  readonly signals: AbortSignal[] = []
  readonly results = new Map<ChangeRequestKey, ChangeRequestSnapshot | ForgeFailure>()
  readonly heads = new Map<string, readonly ChangeRequestRef[]>()
  fetchImpl: ((refs: readonly ChangeRequestRef[], signal: AbortSignal) => Promise<FetchResult>) | undefined
  readinessResult: ForgeReadiness = { state: 'ready', message: null, signIn: null }
  /** Every action in call order, such as `ready 7` or `merge 7 squash <sha>`. */
  readonly actions: string[] = []
  actionResult: ForgeActionFailure | undefined
  /** Patch or file text the reads return. */
  readResult: string | ForgeFailure = ''

  constructor(forge = 'fake', hosts: readonly string[] = [`${forge}.test`]) {
    this.forge = forge
    this.hosts = hosts
  }

  repositoryFromRemote(url: string): ForgeRepository | undefined {
    const match = /^fake:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url)
    if (match === null) return undefined
    const [, host = '', owner = '', name = ''] = match
    return this.serves(host) ? { forge: this.forge, host, owner, name } : undefined
  }

  changeRequestFromUrl(url: string): ChangeRequestRef | undefined {
    const match = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/change\/(\d+)$/.exec(url)
    if (match === null) return undefined
    const [, host = '', owner = '', name = '', number = '0'] = match
    return this.serves(host) ? { repository: { forge: this.forge, host, owner, name }, number: Number(number) } : undefined
  }

  /** Whether `host` is one of `hosts`, compared without case. */
  private serves(host: string): boolean {
    return this.hosts.some(served => served.toLowerCase() === host.toLowerCase())
  }

  changeRequestUrl(target: ChangeRequestRef): string {
    return `https://${target.repository.host}/${target.repository.owner}/${target.repository.name}/change/${target.number}`
  }

  async fetch(refs: readonly ChangeRequestRef[], signal: AbortSignal): Promise<FetchResult> {
    this.fetches.push(refs)
    this.signals.push(signal)
    if (this.fetchImpl !== undefined) return await this.fetchImpl(refs, signal)
    return new Map(refs.map((target) => {
      const key = changeRequestKey(target)
      return [key, this.results.get(key) ?? { code: 'not-found', message: 'missing' }] as const
    }))
  }

  async findByHead(repository: ForgeRepository, branch: string): Promise<readonly ChangeRequestRef[]> {
    return this.heads.get(`${repository.owner}/${repository.name}:${branch}`) ?? []
  }

  async readiness(): Promise<ForgeReadiness> {
    return this.readinessResult
  }

  async markReady(target: ChangeRequestRef): Promise<ForgeActionFailure | undefined> {
    this.actions.push(`ready ${target.number}`)
    return this.actionResult
  }

  async merge(target: ChangeRequestRef, request: MergeRequest): Promise<ForgeActionFailure | undefined> {
    this.actions.push(`merge ${target.number} ${request.method} ${request.headSha}`)
    return this.actionResult
  }

  async diff(target: ChangeRequestRef, headSha: string, _signal: AbortSignal, _base?: string): Promise<string | ForgeFailure> {
    this.actions.push(`diff ${target.number} ${headSha}`)
    return this.readResult
  }

  async fileText(target: ChangeRequestRef, commit: string, path: string): Promise<string | ForgeFailure> {
    this.actions.push(`text ${target.number} ${commit} ${path}`)
    return this.readResult
  }

  fileUrl(target: ChangeRequestRef, commit: string, path: string): string {
    return `https://${target.repository.host}/${target.repository.owner}/${target.repository.name}/file/${commit}/${path}`
  }
}

/** The brief a snapshot holds, without its other fields. */
export function brief(value: ChangeRequestSnapshot): ChangeRequestBrief {
  const { ref: target, url, title, state, draft, mergeability, reviewDecision, checksRollup } = value
  return { ref: target, url, title, state, draft, mergeability, reviewDecision, checksRollup }
}

/** A {@link FakeProvider} that also reads briefs: those of `results`, unless `briefImpl` answers. */
export class BriefProvider extends FakeProvider {
  readonly briefFetches: (readonly ChangeRequestRef[])[] = []
  briefImpl: ((refs: readonly ChangeRequestRef[], signal: AbortSignal) => Promise<BriefResult>) | undefined

  async fetchBriefs(refs: readonly ChangeRequestRef[], signal: AbortSignal): Promise<BriefResult> {
    this.briefFetches.push(refs)
    if (this.briefImpl !== undefined) return await this.briefImpl(refs, signal)
    return new Map(refs.map((target) => {
      const key = changeRequestKey(target)
      const result = this.results.get(key) ?? { code: 'not-found', message: 'missing' }
      return [key, 'code' in result ? result : brief(result)] as const
    }))
  }
}

/** Boot a context with only the forge service. */
export async function forgeContext(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(ForgeService, config)
  return ctx
}

/** Register `provider` from its own plugin fiber, returning that fiber. */
export async function provide(ctx: Context, provider: ForgeProvider): Promise<Fiber> {
  const fiber = ctx.plugin({
    inject: ['forge'],
    apply(child: Context) {
      child.forge.register(provider)
    },
  })
  await fiber
  return fiber
}
