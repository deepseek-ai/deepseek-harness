/** GitLab implementation of the forge provider contract, read and written through the GitLab CLI on the host. */

import { changeRequestKey } from '@deepseek-ai/dsh-experimental-forge'
import type {
  AutoMergeRequest, BranchUpdateRequest, ChangeRequestActivity, ChangeRequestDescription, ChangeRequestIssue, ChangeRequestKey,
  ChangeRequestRef, ChangeRequestSnapshot, ForgeActionFailure, ForgeCommitList, ForgeFailure, ForgeProvider, ForgeReadiness,
  ForgeRepository, ForgeRerunRequest, ForgeReviewData, ForgeReviewerCandidate, ForgeReviewersRequest, ForgeReviewRequest,
  ForgeReviewResult, ForgeReviewWrite, ForgeReviewWriteResult, ForgeViewerCapability, ForgeViewerFilter, ForgeViewerList,
  ForgeViewerQuery, MergeRequest,
} from '@deepseek-ai/dsh-experimental-forge'
import { z } from 'zod'
import { readActivity, withListedCommitNames } from './activity.ts'
import { GitLabApi } from './api.ts'
import { readCommits } from './commits.ts'
import { readDescription } from './description.ts'
import { comparePatch, fileTextOf, isCommit, mergeBaseOf, newestVersion, textPatch, versionFileDiffs, versionPatch } from './diff.ts'
import type { GlabRunner } from './glab.ts'
import { gitLabReviewerCandidates, requestGitLabReviews, rerunGitLabChecks, setGitLabAutoMerge, updateGitLabBranch } from './overview.ts'
import { pool } from './pool.ts'
import type { VersionFile } from './position.ts'
import { readReviewThreads } from './review.ts'
import type { PositionFile } from './review.ts'
import {
  closingIssuesOf, JOB_PAGE, jobsPageSchema, JOBS_QUERY, needsMergeCheck, POLL_JOBS, projectSchema, snapshotOf, statusQuery,
  statusViewer,
} from './status.ts'
import type { JobNode, StatusParts } from './status.ts'
import { checkedProject, encodedPath, mergeRequestPath, parseMergeRequestUrl, parseRemoteUrl, repositoryOf } from './urls.ts'
import { countViewerLists, readInvolvedList, readViewerList, readViewerName, VIEWER_FILTERS, VIEWER_PAGE } from './viewer.ts'
import { submitGitLabReview, writeGitLabReview } from './writes.ts'
import type { VersionFiles } from './writes.ts'

/** Closing issues one snapshot lists, as many as the GitHub provider lists. */
const CLOSING_ISSUES = 25

/** Open merge requests a head lookup returns. */
const HEAD_LOOKUP = 20

/** Bounds of the provider's reads and caches. */
export interface GitLabLimits {
  /** Maximum combined JSON bytes one check read or review read keeps. */
  readonly maxOutputBytes: number
  /** Most review threads one review read returns. */
  readonly maxReviewThreads: number
  /** Most commits one commit listing returns. */
  readonly maxCommits: number
  /** Most merge requests one status query reads. */
  readonly statusBatchSize: number
  /** Most `glab` processes one status fetch runs at once. */
  readonly maxConcurrentRequests: number
  /** Most bytes of diff version patches kept for the hunks of outdated threads and the positions of new comments. */
  readonly maxCachedVersionBytes: number
}

/** The issues a merge request closes, kept until its update time changes. */
interface ClosingIssues {
  readonly updatedAt: string
  readonly issues: readonly ChangeRequestIssue[]
  readonly truncated: boolean
}

/** Changed files of one diff by their path on either side. */
type FilePatches = ReadonlyMap<string, VersionFile>

/** The per-file patches of one diff, kept for outdated threads and comment positions. */
interface CachedFiles {
  readonly bytes: number
  readonly files: FilePatches
}


/** Reads and writes GitLab.com and self-managed GitLab merge requests through a `glab` runner. */
export class GitLabProvider implements ForgeProvider {
  readonly forge = 'gitlab'
  readonly hosts: readonly string[]
  readonly label = 'GitLab'
  readonly changeRequestNoun = 'merge-request'
  readonly viewer: ForgeViewerCapability
  private readonly served: ReadonlySet<string>
  private readonly api: GitLabApi
  /** Username of the signed-in user by host, as the latest viewer read on the host named it. */
  private readonly viewers = new Map<string, string>()
  /** Closing issues by merge request; one entry per merge request this provider polled. */
  private readonly closing = new Map<ChangeRequestKey, ClosingIssues>()
  /** Diff version patches by merge request and version, least recently read first. */
  private readonly versions = new Map<string, CachedFiles>()
  /** Cache fills in flight, so concurrent threads on one file read it once. */
  private readonly filling = new Map<string, Promise<FilePatches | undefined>>()
  private versionBytes = 0

  /**
   * @param glab - runner that executes `glab` on the host.
   * @param hosts - host names this provider serves, such as `gitlab.com` and self-managed hosts.
   * @param limits - read and cache bounds.
   */
  constructor(glab: GlabRunner, hosts: readonly string[], private readonly limits: GitLabLimits) {
    this.api = new GitLabApi(glab)
    this.hosts = [...new Set(hosts.map(host => host.toLowerCase()))]
    this.served = new Set(this.hosts)
    this.viewer = { hosts: this.hosts, filters: VIEWER_FILTERS, maxItems: VIEWER_PAGE }
  }

  /**
   * Read one list of the signed-in user's open merge requests through one GraphQL request; the `involved` list names
   * the user in its request.
   * @see readViewerList
   * @see readInvolvedList
   * @see GitLabProvider.asViewer
   * @throws when the limit is not a positive integer no greater than {@link VIEWER_PAGE}.
   */
  async listForViewer(query: ForgeViewerQuery, signal: AbortSignal): Promise<ForgeViewerList | ForgeFailure> {
    const { host, filter, limit } = query
    const failure = this.hostFailure(host)
    if (failure !== undefined) return failure
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > VIEWER_PAGE) {
      throw new Error(`forge-gitlab: viewer list limit must be a positive integer no greater than ${VIEWER_PAGE}`)
    }
    if (filter === 'involved') return await this.asViewer(host, async me => await readInvolvedList(this.api, query, me, signal), signal)
    const list = await readViewerList(this.api, filter, query, signal)
    if (!('code' in list)) this.viewers.set(host, list.viewer)
    return list
  }

  /**
   * Count the signed-in user's open merge requests in every list through one GraphQL request, which names the user.
   * @see countViewerLists
   * @see GitLabProvider.asViewer
   */
  async countForViewer(host: string, signal: AbortSignal): Promise<ReadonlyMap<ForgeViewerFilter, number> | ForgeFailure> {
    const failure = this.hostFailure(host)
    if (failure !== undefined) return failure
    const counted = await this.asViewer(host, async me => await countViewerLists(this.api, host, me, signal), signal)
    return 'code' in counted ? counted : counted.counts
  }

  /**
   * Read a merge request's description and labels through GraphQL.
   * @see readDescription
   */
  async readDescription(ref: ChangeRequestRef, signal: AbortSignal): Promise<ChangeRequestDescription | ForgeFailure> {
    const failure = this.hostFailure(ref.repository.host)
    if (failure !== undefined) return failure
    return await readDescription(this.api, ref, signal)
  }

  /**
   * Read a merge request's latest notes through GraphQL and its state changes through REST. An activity that names a
   * commit also reads the commit listing, which gives each commit it lists its full object name; when GitLab does not
   * answer the listing, the commits keep the abbreviated names of GitLab's notes.
   * @see readActivity
   * @see withListedCommitNames
   */
  async readActivity(ref: ChangeRequestRef, signal: AbortSignal): Promise<ChangeRequestActivity | ForgeFailure> {
    const failure = this.hostFailure(ref.repository.host)
    if (failure !== undefined) return failure
    const activity = await readActivity(this.api, ref, signal)
    if ('code' in activity || !activity.items.some(item => item.kind === 'commit')) return activity
    const listed = await readCommits(this.api, ref, this.limits.maxCommits, signal)
    return 'code' in listed ? activity : { ...activity, items: withListedCommitNames(activity.items, listed.commits) }
  }

  /**
   * Add a comment through one REST request that creates a note. The comment is saved once GitLab answers with the
   * note's id; an accepted request whose answer names no note is `unknown`. GitLab runs the quick actions in `body`,
   * such as `/close`, and removes them from the note.
   */
  async addComment(ref: ChangeRequestRef, body: string, signal: AbortSignal): Promise<ForgeActionFailure | undefined> {
    const refused = this.writable(ref, null)
    if (refused !== undefined) return refused
    const written = await this.api.write(ref.repository.host, [
      '-X', 'POST', `${mergeRequestPath(ref)}/notes`, '--input', '-', '-H', 'Content-Type: application/json',
    ], signal, JSON.stringify({ body }))
    if (!written.ok) return written.failure
    return z.object({ id: z.number() }).safeParse(written.body).success ? undefined
      : { code: 'unknown', message: 'unexpected GitLab response to the comment' }
  }

  repositoryFromRemote(url: string): ForgeRepository | undefined {
    const location = parseRemoteUrl(url)
    return location === undefined || !this.served.has(location.host) ? undefined : repositoryOf(location)
  }

  changeRequestFromUrl(url: string): ChangeRequestRef | undefined {
    const parsed = parseMergeRequestUrl(url)
    return parsed === undefined || !this.served.has(parsed.host) ? undefined : { repository: repositoryOf(parsed), number: parsed.number }
  }

  changeRequestUrl(ref: ChangeRequestRef): string {
    const { host, owner, name } = ref.repository
    return `https://${host}/${owner}/${name}/-/merge_requests/${ref.number}`
  }

  async fetch(
    refs: readonly ChangeRequestRef[], signal: AbortSignal,
  ): Promise<ReadonlyMap<ChangeRequestKey, ChangeRequestSnapshot | ForgeFailure>> {
    const results = new Map<ChangeRequestKey, ChangeRequestSnapshot | ForgeFailure>()
    const chunks: ChangeRequestRef[][] = []
    const byHost = new Map<string, ChangeRequestRef[]>()
    for (const ref of refs) {
      const failure = this.hostFailure(ref.repository.host)
      if (failure !== undefined) results.set(changeRequestKey(ref), failure)
      else byHost.set(ref.repository.host, [...byHost.get(ref.repository.host) ?? [], ref])
    }
    for (const group of byHost.values()) {
      const size = this.limits.statusBatchSize
      for (let index = 0; index < group.length; index += size) chunks.push(group.slice(index, index + size))
    }
    await pool(chunks, this.limits.maxConcurrentRequests, async (chunk) => {
      for (const [key, result] of await this.status(chunk, POLL_JOBS, signal)) results.set(key, result)
    })
    return results
  }

  async fetchChecks(ref: ChangeRequestRef, signal: AbortSignal): Promise<ChangeRequestSnapshot | ForgeFailure> {
    const failure = this.hostFailure(ref.repository.host)
    if (failure !== undefined) return failure
    // oxlint-disable-next-line typescript/no-non-null-assertion -- status returns one result for each requested ref.
    return (await this.status([ref], JOB_PAGE, signal, true)).get(changeRequestKey(ref))!
  }

  async findByHead(repository: ForgeRepository, branch: string, signal: AbortSignal): Promise<readonly ChangeRequestRef[]> {
    const failure = this.hostFailure(repository.host)
    if (failure !== undefined) throw new Error(failure.message)
    const project = encodeURIComponent(checkedProject({ repository, number: 1 }))
    const [settings, listing] = await Promise.all([
      this.api.rest(repository.host, `projects/${project}`, signal),
      this.api.rest(repository.host, `projects/${project}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}`
        + `&order_by=created_at&sort=desc&per_page=${HEAD_LOOKUP}`, signal),
    ])
    if (!settings.ok) throw new Error(`forge-gitlab: head branch lookup failed: ${settings.failure.message}`)
    if (!listing.ok) throw new Error(`forge-gitlab: head branch lookup failed: ${listing.failure.message}`)
    const defaults = z.object({ default_branch: z.string().nullable() }).safeParse(settings.body)
    const requests = z.array(z.object({ iid: z.number(), source_project_id: z.number(), target_project_id: z.number() }))
      .safeParse(listing.body)
    if (!defaults.success || !requests.success) throw new Error('forge-gitlab: unexpected GitLab response to the head branch lookup')
    if (defaults.data.default_branch === branch) return []
    return requests.data.filter(request => request.source_project_id === request.target_project_id)
      .map(request => ({ repository, number: request.iid }))
  }

  async readiness(host: string, signal: AbortSignal): Promise<ForgeReadiness> {
    const failure = this.hostFailure(host)
    if (failure !== undefined) return { state: 'unavailable', message: failure.message, signIn: null }
    const read = await this.api.rest(host, 'user', signal)
    if (read.ok) return { state: 'ready', message: null, signIn: null }
    if (read.failure.code === 'unauthenticated') {
      return { state: 'unauthenticated', message: read.failure.message, signIn: { command: `glab auth login --hostname ${host}` } }
    }
    return { state: 'unavailable', message: read.failure.message, signIn: null }
  }

  /** Mark a draft merge request ready through the GraphQL `mergeRequestSetDraft` mutation; a ready one stays ready. */
  async markReady(ref: ChangeRequestRef, signal: AbortSignal): Promise<ForgeActionFailure | undefined> {
    const refused = this.writable(ref, null)
    if (refused !== undefined) return refused
    const query = 'mutation($path: ID!, $iid: String!) { mergeRequestSetDraft(input: { projectPath: $path, iid: $iid, draft: false }) { errors } }'
    const written = await this.api.mutate(ref.repository.host, query, { path: checkedProject(ref), iid: String(ref.number) }, 'mergeRequestSetDraft', signal)
    return 'ok' in written ? undefined : written
  }

  /**
   * Merge through the REST merge endpoint with `sha` set to the confirmed head, so GitLab refuses with HTTP 409 once
   * the head moved; the method chooses squashing, and the merge request's own setting decides whether GitLab deletes the
   * head branch.
   */
  async merge(ref: ChangeRequestRef, request: MergeRequest, signal: AbortSignal): Promise<ForgeActionFailure | undefined> {
    const refused = this.writable(ref, request.headSha)
    if (refused !== undefined) return refused
    const written = await this.api.write(ref.repository.host, [
      '-X', 'PUT', `${mergeRequestPath(ref)}/merge`, '-f', `sha=${request.headSha}`, '-F', `squash=${request.method === 'squash'}`,
    ], signal)
    if (written.ok) return undefined
    return written.status === 409 ? { code: 'stale', message: written.failure.message } : written.failure
  }

  /**
   * Turn the automatic merge on through the GraphQL `mergeRequestAccept` mutation at the confirmed head, or off through
   * REST `cancel_auto_merge`.
   * @see setGitLabAutoMerge
   */
  async setAutoMerge(ref: ChangeRequestRef, request: AutoMergeRequest, signal: AbortSignal): Promise<ForgeActionFailure | undefined> {
    return this.writable(ref, request.enabled ? request.headSha : null) ?? await setGitLabAutoMerge(this.api, ref, request, signal)
  }

  /**
   * Publish a comment or a complete review through discussions and draft notes after a check of the head.
   * @see submitGitLabReview
   */
  async submitReview(ref: ChangeRequestRef, request: ForgeReviewRequest, signal: AbortSignal): Promise<ForgeReviewResult> {
    const refused = this.writable(ref, request.headSha)
    if (refused !== undefined) return { ok: false, code: 'failed', message: refused.message }
    return await submitGitLabReview(this.api, this.filesOf(ref, signal), ref, request, signal)
  }

  /**
   * Write to the discussions or the draft notes of a merge request after a check of the head.
   * @see writeGitLabReview
   */
  async writeReview(ref: ChangeRequestRef, write: ForgeReviewWrite, signal: AbortSignal): Promise<ForgeReviewWriteResult> {
    const refused = this.writable(ref, write.headSha)
    if (refused !== undefined) return { ok: false, code: 'failed', message: refused.message }
    return await writeGitLabReview(this.api, this.filesOf(ref, signal), ref, write, signal)
  }

  /**
   * Retry the failed jobs of the head pipeline once none of its jobs is pending.
   * @see rerunGitLabChecks
   */
  async rerunChecks(ref: ChangeRequestRef, request: ForgeRerunRequest, signal: AbortSignal): Promise<ForgeActionFailure | undefined> {
    const read = async (): Promise<ChangeRequestSnapshot | ForgeFailure> => await this.fetchChecks(ref, signal)
    return this.writable(ref, request.headSha) ?? await rerunGitLabChecks(this.api, read, ref, request, signal)
  }

  async requestReviews(
    ref: ChangeRequestRef, request: ForgeReviewersRequest, signal: AbortSignal,
  ): Promise<ForgeActionFailure | undefined> {
    return this.writable(ref, null) ?? await requestGitLabReviews(this.api, ref, request, signal)
  }

  async reviewerCandidates(
    ref: ChangeRequestRef, query: string, signal: AbortSignal,
  ): Promise<readonly ForgeReviewerCandidate[] | ForgeFailure> {
    const failure = this.hostFailure(ref.repository.host)
    if (failure !== undefined) return failure
    return await gitLabReviewerCandidates(this.api, ref, query, signal)
  }

  async updateBranch(ref: ChangeRequestRef, request: BranchUpdateRequest, signal: AbortSignal): Promise<ForgeActionFailure | undefined> {
    return this.writable(ref, request.headSha) ?? await updateGitLabBranch(this.api, ref, request, signal)
  }

  /**
   * Read the patch of the newest diff version, which GitLab records for every push, once it is at `headSha`; `base` is
   * not needed because the version names its own merge base.
   */
  async diff(ref: ChangeRequestRef, headSha: string, signal: AbortSignal): Promise<string | ForgeFailure> {
    const failure = this.hostFailure(ref.repository.host)
    if (failure !== undefined) return failure
    if (!isCommit(headSha)) throw new Error(`forge-gitlab: invalid head commit ${JSON.stringify(headSha)}`)
    const version = await newestVersion(this.api, ref, headSha, signal)
    if ('code' in version) return version
    return await versionPatch(this.api, ref, version, async (commit, path) => await fileTextOf(this.api, ref, commit, path, signal), signal)
  }

  async fileText(ref: ChangeRequestRef, commit: string, path: string, signal: AbortSignal): Promise<string | ForgeFailure> {
    const failure = this.hostFailure(ref.repository.host)
    if (failure !== undefined) return failure
    if (!isCommit(commit)) throw new Error(`forge-gitlab: invalid commit ${JSON.stringify(commit)}`)
    return await fileTextOf(this.api, ref, commit, path, signal)
  }

  fileUrl(ref: ChangeRequestRef, commit: string, path: string): string {
    const { host, owner, name } = ref.repository
    return `https://${host}/${owner}/${name}/-/blob/${commit}/${encodedPath(path)}`
  }

  async commits(ref: ChangeRequestRef, signal: AbortSignal): Promise<ForgeCommitList | ForgeFailure> {
    const failure = this.hostFailure(ref.repository.host)
    if (failure !== undefined) return failure
    return await readCommits(this.api, ref, this.limits.maxCommits, signal)
  }

  async compare(ref: ChangeRequestRef, base: string, head: string, signal: AbortSignal): Promise<string | ForgeFailure> {
    const failure = this.hostFailure(ref.repository.host)
    if (failure !== undefined) return failure
    if (!isCommit(base) || !isCommit(head)) throw new Error(`forge-gitlab: invalid commits ${JSON.stringify(`${base}..${head}`)}`)
    const readText = async (commit: string, path: string): Promise<string | ForgeFailure> =>
      await fileTextOf(this.api, ref, commit, path, signal)
    return await comparePatch(this.api, ref, base, head, readText, signal)
  }

  async mergeBase(ref: ChangeRequestRef, base: string, head: string, signal: AbortSignal): Promise<string | ForgeFailure> {
    const failure = this.hostFailure(ref.repository.host)
    if (failure !== undefined) return failure
    if (!isCommit(base) || !isCommit(head)) throw new Error(`forge-gitlab: invalid commits ${JSON.stringify(`${base}..${head}`)}`)
    return await mergeBaseOf(this.api, ref, base, head, signal)
  }

  async readReview(ref: ChangeRequestRef, headSha: string, signal: AbortSignal): Promise<ForgeReviewData | ForgeFailure> {
    const failure = this.hostFailure(ref.repository.host)
    if (failure !== undefined) return failure
    return await readReviewThreads(this.api, ref, headSha, this.limits, async file => await this.positionPatch(ref, file, signal), signal)
  }

  /**
   * Run a read that names the signed-in user of `host` in its request: with the username the latest viewer read on the
   * host returned, which one request reads first when there is none. An answer that names another user, as after
   * `glab` signed in as someone else, replaces the kept username, and the read runs once more with it.
   * @param host - host the read is on.
   * @param read - the read for one username, whose result names the user GitLab answered as.
   * @param signal - cancellation of the username read.
   * @returns the result of the last read, or why GitLab named no user.
   */
  private async asViewer<Result extends { readonly viewer: string }>(
    host: string, read: (me: string) => Promise<Result | ForgeFailure>, signal: AbortSignal,
  ): Promise<Result | ForgeFailure> {
    let me = this.viewers.get(host)
    if (me === undefined) {
      const named = await readViewerName(this.api, host, signal)
      if (typeof named !== 'string') return named
      me = named
      this.viewers.set(host, me)
    }
    const result = await read(me)
    if ('code' in result || result.viewer === me) return result
    this.viewers.set(host, result.viewer)
    return await read(result.viewer)
  }

  /**
   * Read the status of merge requests on one host with one GraphQL query, halving the batch while GitLab refuses it as
   * too complex, then read each one's closing issues unless its update time is the one they were read at.
   */
  private async status(
    refs: readonly ChangeRequestRef[], jobs: number, signal: AbortSignal, allJobs = false,
  ): Promise<ReadonlyMap<ChangeRequestKey, ChangeRequestSnapshot | ForgeFailure>> {
    const results = new Map<ChangeRequestKey, ChangeRequestSnapshot | ForgeFailure>()
    // oxlint-disable-next-line typescript/no-non-null-assertion -- callers pass at least one ref, all on one host.
    const host = refs[0]!.repository.host
    const variables: Record<string, unknown> = { jobs }
    refs.forEach((ref, index) => { variables[`p${index}`] = checkedProject(ref); variables[`i${index}`] = String(ref.number) })
    const read = await this.api.graphql(host, statusQuery(refs.length), variables, signal)
    if (!read.ok) {
      if (read.failure.code === 'too-large' && refs.length > 1) {
        const half = Math.ceil(refs.length / 2)
        for (const part of [refs.slice(0, half), refs.slice(half)]) {
          for (const [key, result] of await this.status(part, jobs, signal, allJobs)) results.set(key, result)
        }
        return results
      }
      for (const ref of refs) results.set(changeRequestKey(ref), read.failure)
      return results
    }
    const data = z.record(z.string(), z.unknown()).parse(read.body)
    const viewer = statusViewer(data)
    for (const [index, ref] of refs.entries()) {
      const key = changeRequestKey(ref)
      const project = projectSchema.safeParse(data[`m${index}`])
      if (!project.success) results.set(key, { code: 'unavailable', message: 'unexpected GitLab response to the status read' })
      else if (project.data === null || project.data.mergeRequest === null) results.set(key, { code: 'not-found', message: `merge request ${ref.number} was not found` })
      else {
        const parts = { ref, fastForwardOnly: project.data.mergeRequestsFfOnlyEnabled, viewer, node: project.data.mergeRequest }
        results.set(key, await this.snapshot(parts, allJobs, signal))
      }
    }
    return results
  }

  /**
   * Complete one merge request's snapshot with the rest of its jobs, when asked for, and its closing issues, asking GitLab
   * to check its conflicts when it has not since a change.
   */
  private async snapshot(
    parts: Pick<StatusParts, 'ref' | 'fastForwardOnly' | 'viewer' | 'node'>, allJobs: boolean, signal: AbortSignal,
  ): Promise<ChangeRequestSnapshot | ForgeFailure> {
    const { ref, node } = parts
    const jobs: JobNode[] = [...node.headPipeline?.jobs?.nodes ?? []]
    let page = node.headPipeline?.jobs?.pageInfo
    let bytes = Buffer.byteLength(JSON.stringify(node))
    while (allJobs && page?.hasNextPage === true) {
      const cursor = page.endCursor
      if (cursor == null) return { code: 'unavailable', message: 'GitLab job pagination did not advance' }
      const variables = { path: checkedProject(ref), iid: String(ref.number), cursor }
      const read = await this.api.graphql(ref.repository.host, JOBS_QUERY, variables, signal)
      if (!read.ok) return read.failure
      bytes += Buffer.byteLength(JSON.stringify(read.body))
      if (bytes > this.limits.maxOutputBytes) return { code: 'too-large', message: `the checks of merge request ${ref.number} exceed maxOutputBytes` }
      const parsed = jobsPageSchema.safeParse(read.body)
      const next = parsed.success ? parsed.data.project?.mergeRequest : undefined
      if (next == null || next.headPipeline?.jobs == null) return { code: 'unavailable', message: 'unexpected GitLab response to the job read' }
      if (next.diffRefs?.headSha !== node.diffRefs?.headSha) return { code: 'unavailable', message: 'the merge request head moved while its checks were read' }
      jobs.push(...next.headPipeline.jobs.nodes)
      page = next.headPipeline.jobs.pageInfo
    }
    // A REST read asks GitLab to check the merge request again, whose outcome a later poll reads; the snapshot reports unknown.
    if (needsMergeCheck(node)) await this.api.rest(ref.repository.host, mergeRequestPath(ref), signal)
    const closing = await this.closingIssues(ref, node.updatedAt, signal)
    return snapshotOf({
      ...parts, jobs, jobsTruncated: page?.hasNextPage ?? false, closingIssues: closing.issues, closingIssuesTruncated: closing.truncated,
    })
  }

  /**
   * The issues a merge request closes. GitLab derives them from its description and commit messages, and changing
   * either changes its update time, so a list read at the same update time is reused. A failed read keeps the last
   * list, or none, marked truncated.
   */
  private async closingIssues(ref: ChangeRequestRef, updatedAt: string, signal: AbortSignal): Promise<ClosingIssues> {
    const key = changeRequestKey(ref)
    const kept = this.closing.get(key)
    if (kept?.updatedAt === updatedAt) return kept
    const read = await this.api.rest(ref.repository.host, `${mergeRequestPath(ref)}/closes_issues?per_page=${CLOSING_ISSUES + 1}`, signal)
    const listed = read.ok ? closingIssuesOf(read.body, CLOSING_ISSUES) : undefined
    if (listed === undefined) return { updatedAt, issues: kept?.issues ?? [], truncated: true }
    const entry = { updatedAt, issues: listed.issues, truncated: listed.truncated }
    this.closing.set(key, entry)
    return entry
  }

  /**
   * One file's patch in the diff a thread position names: from the diff version when GitLab keeps its files, else by
   * comparing the file's text at the position's merge base and head, where a missing file reads as empty. Both never
   * change, so they are kept, least recently read dropped first, until they pass `maxCachedVersionBytes`.
   */
  private async positionPatch(ref: ChangeRequestRef, file: PositionFile, signal: AbortSignal): Promise<string | null> {
    if (file.version !== null) {
      const files = await this.versionFiles(ref, file.version, signal)
      const patch = (files?.get(file.newPath) ?? files?.get(file.oldPath))?.diff
      if (patch !== undefined && patch !== '') return patch
    }
    const files = await this.cached(`${changeRequestKey(ref)}:${file.baseSha}..${file.headSha}:${file.newPath}`, async () => {
      const text = async (commit: string, path: string): Promise<string | undefined> => {
        const read = await fileTextOf(this.api, ref, commit, path, signal)
        return typeof read === 'string' ? read : read.code === 'not-found' ? '' : undefined
      }
      const [before, after] = await Promise.all([text(file.baseSha, file.oldPath), text(file.headSha, file.newPath)])
      if (before === undefined || after === undefined) return undefined
      const diff = textPatch(`a/${file.oldPath}`, `b/${file.newPath}`, before, after)
      return new Map([[file.newPath, { oldPath: file.oldPath, newPath: file.newPath, diff }]])
    })
    return files?.get(file.newPath)?.diff ?? null
  }

  /**
   * The changed files of one diff version by their path on either side, which never change, kept with the patches of
   * outdated threads. A file's new path names it over another file's old path, so after `a → b` and `b → c` the path
   * `b` names the first file.
   */
  private async versionFiles(ref: ChangeRequestRef, version: number, signal: AbortSignal): Promise<FilePatches | undefined> {
    return await this.cached(`${changeRequestKey(ref)}@${version}`, async () => {
      const readText = async (commit: string, path: string) => await fileTextOf(this.api, ref, commit, path, signal)
      const files = await versionFileDiffs(this.api, ref, version, readText, signal)
      if (files === undefined) return undefined
      const byOldPath = files.map(file => [file.oldPath, file] as const)
      return new Map<string, VersionFile>([...byOldPath, ...files.map(file => [file.newPath, file] as const)])
    })
  }

  /** Reads the changed files of the merge request's diff versions for comment positions. */
  private filesOf(ref: ChangeRequestRef, signal: AbortSignal): VersionFiles {
    return async version => await this.versionFiles(ref, version, signal)
  }

  /** Read one cache entry, or fill it from `read` unless the read fails; concurrent callers of one key share one fill. */
  private async cached(key: string, read: () => Promise<FilePatches | undefined>): Promise<FilePatches | undefined> {
    const kept = this.versions.get(key)
    if (kept === undefined) {
      const pending = this.filling.get(key)
      if (pending !== undefined) return await pending
      const filled = this.fill(key, read)
      this.filling.set(key, filled)
      try {
        return await filled
      } finally {
        this.filling.delete(key)
      }
    }
    this.versions.delete(key)
    this.versions.set(key, kept)
    return kept.files
  }

  /**
   * Read and keep one cache entry, then drop the least recently read entries over the limit; an entry over the limit by
   * itself serves this read only.
   */
  private async fill(key: string, read: () => Promise<FilePatches | undefined>): Promise<FilePatches | undefined> {
    const files = await read()
    if (files === undefined) return undefined
    // A file listed under both of its paths counts once.
    const entry = { bytes: [...new Set(files.values())].reduce((total, file) => total + Buffer.byteLength(file.diff), 0), files }
    if (entry.bytes > this.limits.maxCachedVersionBytes) return files
    this.versionBytes += entry.bytes
    this.versions.set(key, entry)
    for (const [kept, old] of this.versions) {
      if (this.versionBytes <= this.limits.maxCachedVersionBytes) break
      this.versions.delete(kept)
      this.versionBytes -= old.bytes
    }
    return files
  }

  /**
   * Refuse a write to a host this provider does not serve.
   * @throws when `headSha` is given and is not a full commit object name, which callers check before they write.
   */
  private writable(ref: ChangeRequestRef, headSha: string | null): ForgeActionFailure | undefined {
    const failure = this.hostFailure(ref.repository.host)
    if (failure !== undefined) return { code: 'failed', message: failure.message }
    if (headSha !== null && !isCommit(headSha)) throw new Error(`forge-gitlab: invalid head commit ${JSON.stringify(headSha)}`)
    return undefined
  }

  private hostFailure(host: string): ForgeFailure | undefined {
    return this.served.has(host.toLowerCase()) ? undefined : {
      code: 'unavailable',
      message: `forge-gitlab does not serve ${host}; add it to the provider's hosts setting`,
    }
  }
}
