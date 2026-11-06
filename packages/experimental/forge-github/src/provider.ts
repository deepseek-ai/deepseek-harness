/** GitHub implementation of the forge provider contract. */

import { changeRequestKey } from '@deepseek-ai/dsh-experimental-forge'
import type {
  ChangeRequestKey, ChangeRequestRef, ChangeRequestSnapshot, ForgeActionFailure, ForgeFailure, ForgeProvider, ForgeReadiness,
  ForgeRepository, ForgeReviewRequest, ForgeReviewResult, MergeRequest,
} from '@deepseek-ai/dsh-experimental-forge'
import { GhOutputLimitError, GhTimeoutError, GhUnavailableError } from './gh.ts'
import type { GhOutput, GhRunner } from './gh.ts'
import { readComparison } from './compare.ts'
import {
  CHECKS_QUERY, hasGraphqlFields, HEAD_QUERY, mapCheckPageResponse, mapHeadResponse, mapPullRequestCommitsResponse,
  mapSnapshotResponse, mapThreadPageResponse, PULL_REQUEST_COMMITS_QUERY, snapshotQuery, THREADS_QUERY,
} from './graphql.ts'
import type { PageResult, SnapshotPages } from './graphql.ts'
import { checkedRepository, isCommit, parsePullRequestUrl, parseRemoteUrl } from './urls.ts'
import { submitGitHubReview } from './review.ts'

const AUTHENTICATION = /gh auth login|authentication|bad credentials|HTTP 401/i

/** Status code `gh api` appends to the message of a failed request. */
const HTTP_STATUS = /\(HTTP (\d{3})\)/

/**
 * GitHub's error code for an answer over its size limits, such as a file over
 * the contents API limit: `gh api` returns it in the JSON error body.
 */
const TOO_LARGE = /\btoo_large\b/

/** HTTP status GitHub answers when it refuses to render a diff over its limits. */
const NOT_ACCEPTABLE = '406'

/** Bounds on what one read retains or counts. */
export interface GitHubLimits {
  /** Maximum combined JSON bytes retained by an explicit check read. */
  readonly maxOutputBytes: number
  /** Most review threads counted per pull request in one status read. */
  readonly maxReviewThreads: number
}

/** Reads GitHub and GitHub Enterprise pull requests through a `gh` runner. */
export class GitHubProvider implements ForgeProvider {
  readonly forge = 'github'
  private readonly hosts: ReadonlySet<string>

  async submitReview(ref: ChangeRequestRef, request: ForgeReviewRequest, signal: AbortSignal): Promise<ForgeReviewResult> {
    const failure = this.hostFailure(ref.repository.host)
    if (failure !== undefined) return { ok: false, code: 'failed', message: failure.message }
    return await submitGitHubReview(this.gh, ref, request, signal)
  }

  /**
   * @param gh - runner that executes `gh` on the host.
   * @param hosts - host names this provider serves, such as `github.com` and Enterprise hosts.
   * @param limits - bounds on retained check bytes and counted review threads.
   */
  constructor(private readonly gh: GhRunner, hosts: readonly string[], private readonly limits: GitHubLimits) {
    this.hosts = new Set(hosts.map(host => host.toLowerCase()))
  }

  repositoryFromRemote(url: string): ForgeRepository | undefined {
    const location = parseRemoteUrl(url)
    if (location === undefined || !this.hosts.has(location.host)) return undefined
    return { forge: this.forge, ...location }
  }

  changeRequestFromUrl(url: string): ChangeRequestRef | undefined {
    const parsed = parsePullRequestUrl(url)
    if (parsed === undefined || !this.hosts.has(parsed.host)) return undefined
    return { repository: { forge: this.forge, host: parsed.host, owner: parsed.owner, name: parsed.name }, number: parsed.number }
  }

  changeRequestUrl(ref: ChangeRequestRef): string {
    const { host, owner, name } = ref.repository
    return `https://${host}/${owner}/${name}/pull/${ref.number}`
  }

  async fetch(
    refs: readonly ChangeRequestRef[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<ChangeRequestKey, ChangeRequestSnapshot | ForgeFailure>> {
    const byHost = new Map<string, ChangeRequestRef[]>()
    const results = new Map<ChangeRequestKey, ChangeRequestSnapshot | ForgeFailure>()
    for (const ref of refs) {
      const failure = this.hostFailure(ref.repository.host)
      if (failure !== undefined) {
        results.set(changeRequestKey(ref), failure)
        continue
      }
      const group = byHost.get(ref.repository.host)
      if (group === undefined) byHost.set(ref.repository.host, [ref])
      else group.push(ref)
    }
    for (const [host, group] of byHost) {
      for (const [key, result] of await this.fetchHost(host, group, signal)) results.set(key, result)
    }
    return results
  }

  async fetchChecks(ref: ChangeRequestRef, signal: AbortSignal): Promise<ChangeRequestSnapshot | ForgeFailure> {
    const failure = this.hostFailure(ref.repository.host)
    if (failure !== undefined) return failure
    try {
      const results = await this.fetchHost(ref.repository.host, [ref], signal, true)
      // oxlint-disable-next-line typescript/no-non-null-assertion -- fetchHost returns one result for each requested ref.
      return results.get(changeRequestKey(ref))!
    } catch (error) {
      if (signal.aborted) throw signal.reason
      return processFailure(error)
    }
  }

  async findByHead(repository: ForgeRepository, branch: string, signal: AbortSignal): Promise<readonly ChangeRequestRef[]> {
    const failure = this.hostFailure(repository.host)
    if (failure !== undefined) throw new Error(failure.message)
    const output = await this.gh([
      'api', 'graphql', '--hostname', repository.host,
      '-f', `query=${HEAD_QUERY}`, '-f', `owner=${repository.owner}`, '-f', `name=${repository.name}`, '-f', `branch=${branch}`,
    ], signal)
    const body = parseJson(output.stdout)
    if (!hasGraphqlFields(body)) throw new Error(`forge-github: head branch lookup failed: ${responseFailure(output, body).message}`)
    return mapHeadResponse(body, repository, branch)
  }

  /**
   * Mark a draft pull request ready for review with `gh pr ready`; one that
   * is already ready stays ready.
   */
  async markReady(ref: ChangeRequestRef, signal: AbortSignal): Promise<ForgeActionFailure | undefined> {
    const { host, owner, name } = checkedRepository(ref)
    const failure = this.hostFailure(host)
    if (failure !== undefined) return { code: 'failed', message: failure.message }
    return await this.act(['pr', 'ready', String(ref.number), '--repo', `${host}/${owner}/${name}`], signal)
  }

  /**
   * Merge a pull request through the REST merge endpoint with the expected
   * head commit, so GitHub refuses with 409 once new commits arrived. Unlike
   * `gh pr merge`, it never enables auto-merge, never joins a merge queue, and
   * never deletes the head branch.
   */
  async merge(ref: ChangeRequestRef, request: MergeRequest, signal: AbortSignal): Promise<ForgeActionFailure | undefined> {
    const { host, owner, name } = checkedRepository(ref)
    const failure = this.hostFailure(host)
    if (failure !== undefined) return { code: 'failed', message: failure.message }
    if (!isCommit(request.headSha)) throw new Error(`forge-github: invalid head commit ${JSON.stringify(request.headSha)}`)
    return await this.act([
      'api', '--hostname', host, '--method', 'PUT', `repos/${owner}/${name}/pulls/${ref.number}/merge`,
      '-f', `merge_method=${request.method}`, '-f', `sha=${request.headSha}`,
    ], signal)
  }

  /**
   * Read the pull request's diff at `headSha`. One GraphQL read names the
   * current head and the base commit GitHub recorded with it; a head other
   * than `headSha` returns `stale`. Otherwise the compare endpoint reads the
   * patch from the merge base of that base commit and `headSha`, as the pull
   * request's own diff does, with both ends fixed.
   */
  async diff(ref: ChangeRequestRef, headSha: string, signal: AbortSignal): Promise<string | ForgeFailure> {
    const { host, owner, name } = checkedRepository(ref)
    const failure = this.hostFailure(host)
    if (failure !== undefined) return failure
    if (!isCommit(headSha)) throw new Error(`forge-github: invalid head commit ${JSON.stringify(headSha)}`)
    const output = await this.read([
      'api', 'graphql', '--hostname', host,
      '-f', `query=${PULL_REQUEST_COMMITS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${ref.number}`,
    ], signal)
    if (typeof output !== 'string') return output
    const commits = mapPullRequestCommitsResponse(parseJson(output))
    if (commits === undefined) return { code: 'unavailable', message: 'unexpected GitHub response to the pull request commit read' }
    if (commits.head.toLowerCase() !== headSha.toLowerCase()) {
      return { code: 'stale', message: `the pull request head moved from ${headSha} to ${commits.head}` }
    }
    return await readComparison(async (args, operation) => await this.read(args, operation), ref.repository, commits.base, headSha, signal)
  }

  /** Read one file at a commit through the contents API in its raw form. */
  async fileText(ref: ChangeRequestRef, commit: string, path: string, signal: AbortSignal): Promise<string | ForgeFailure> {
    const { host, owner, name } = checkedRepository(ref)
    const failure = this.hostFailure(host)
    if (failure !== undefined) return failure
    if (!isCommit(commit)) throw new Error(`forge-github: invalid commit ${JSON.stringify(commit)}`)
    return await this.read([
      'api', '--hostname', host, '-H', 'Accept: application/vnd.github.raw+json',
      `repos/${owner}/${name}/contents/${encodedPath(path)}?ref=${commit}`,
    ], signal)
  }

  fileUrl(ref: ChangeRequestRef, commit: string, path: string): string {
    const { host, owner, name } = ref.repository
    return `https://${host}/${owner}/${name}/blob/${commit}/${encodedPath(path)}`
  }

  async readiness(host: string, signal: AbortSignal): Promise<ForgeReadiness> {
    const failure = this.hostFailure(host)
    if (failure !== undefined) return { state: 'unavailable', message: failure.message }
    try {
      const output = await this.gh(['auth', 'status', '--hostname', host], signal)
      if (output.exitCode === 0) return { state: 'ready', message: null }
      return { state: 'unauthenticated', message: firstLine(output.stderr) ?? firstLine(output.stdout) ?? `gh is not signed in to ${host}` }
    } catch (error) {
      if (error instanceof GhUnavailableError) return { state: 'unavailable', message: error.message }
      throw error
    }
  }

  /**
   * Run one reading `gh` command, returning its output. A refusal, a `gh` that
   * cannot start, output over `maxOutputBytes`, and a run past `timeoutMs` become failures.
   */
  private async read(args: readonly string[], signal: AbortSignal): Promise<string | ForgeFailure> {
    let output: GhOutput | GhUnavailableError
    try {
      output = await this.attempt(args, signal)
    } catch (error) {
      if (error instanceof GhOutputLimitError) return { code: 'too-large', message: error.message }
      if (error instanceof GhTimeoutError) return { code: 'unavailable', message: error.message }
      throw error
    }
    if (output instanceof GhUnavailableError) return { code: 'unavailable', message: output.message }
    if (output.exitCode === 0) return output.stdout
    const { message, status } = refusal(output)
    if (AUTHENTICATION.test(output.stderr)) return { code: 'unauthenticated', message }
    if (status === NOT_ACCEPTABLE || TOO_LARGE.test(output.stderr) || TOO_LARGE.test(output.stdout)) return { code: 'too-large', message }
    return { code: status === '404' || /could not resolve to a pullrequest/i.test(output.stderr) ? 'not-found' : 'unavailable', message }
  }

  /** Run one changing `gh` command; a refusal or a `gh` that cannot start becomes a failure. */
  private async act(args: readonly string[], signal: AbortSignal): Promise<ForgeActionFailure | undefined> {
    const output = await this.attempt(args, signal)
    if (output instanceof GhUnavailableError) return { code: 'failed', message: output.message }
    if (output.exitCode === 0) return undefined
    const { message, status } = refusal(output)
    if (status === '409') return { code: 'stale', message }
    if (AUTHENTICATION.test(output.stderr)) return { code: 'unauthenticated', message }
    return { code: 'failed', message }
  }

  /** Run one `gh` command; a `gh` that cannot start resolves to its error, and every other rejection passes on. */
  private async attempt(args: readonly string[], signal: AbortSignal): Promise<GhOutput | GhUnavailableError> {
    try {
      return await this.gh(args, signal)
    } catch (error) {
      if (error instanceof GhUnavailableError) return error
      throw error
    }
  }

  private hostFailure(host: string): ForgeFailure | undefined {
    return this.hosts.has(host.toLowerCase()) ? undefined : {
      code: 'unavailable', message: `forge-github: host ${JSON.stringify(host)} is not configured`,
    }
  }

  private async fetchHost(
    host: string,
    refs: readonly ChangeRequestRef[],
    signal: AbortSignal,
    completeChecks = false,
  ): Promise<ReadonlyMap<ChangeRequestKey, ChangeRequestSnapshot | ForgeFailure>> {
    const query = snapshotQuery(refs, this.limits.maxReviewThreads)
    const output = await this.gh(['api', 'graphql', '--hostname', host, '-f', `query=${query.document}`], signal)
    const body = parseJson(output.stdout)
    // A complete check read retains every response it reads, so all of them share one byte budget.
    let bytes = Buffer.byteLength(output.stdout)
    const tooLarge: ForgeFailure = { code: 'too-large', message: 'GitHub check details exceed the output size limit' }
    const overBudget = (page: GhOutput): boolean => {
      if (!completeChecks) return false
      bytes += Buffer.byteLength(page.stdout)
      return bytes > this.limits.maxOutputBytes
    }
    const continuation = async <T>(
      variables: readonly string[], map: (value: unknown) => PageResult<T>,
    ): Promise<PageResult<T>> => {
      const page = await this.continuation(host, variables, signal)
      if (!('stdout' in page)) return { ok: false, failure: page }
      if (overBudget(page)) return { ok: false, failure: tooLarge }
      const value = parseJson(page.stdout)
      return hasGraphqlFields(value) ? map(value) : { ok: false, failure: responseFailure(page, value) }
    }
    const threads: SnapshotPages['threads'] = async (id, cursor, first) => await continuation(
      ['-f', `query=${THREADS_QUERY}`, '-f', `id=${id}`, '-f', `cursor=${cursor}`, '-F', `first=${first}`], mapThreadPageResponse)
    if (!completeChecks && hasGraphqlFields(body)) return await mapSnapshotResponse(body, query, { threads })
    if (bytes > this.limits.maxOutputBytes) return new Map([...query.targets.values()].map(ref => [changeRequestKey(ref), tooLarge]))
    if (hasGraphqlFields(body)) {
      return await mapSnapshotResponse(body, query, { threads, checks: async (id, cursor) => await continuation(
        ['-f', `query=${CHECKS_QUERY}`, '-f', `id=${id}`, '-f', `cursor=${cursor}`], mapCheckPageResponse) })
    }
    const failure = responseFailure(output, body)
    return new Map([...query.targets.values()].map(ref => [changeRequestKey(ref), failure] as const))
  }

  /**
   * Run one continuation query of a snapshot read.
   * @param host - host the snapshot was read from.
   * @param variables - `gh api graphql` field flags, the query first.
   * @param signal - cancellation of the snapshot read.
   * @returns the output, or the failure of a `gh` that cannot start, times out, or prints over its limit.
   * @throws with `signal.reason` when the read is cancelled.
   */
  private async continuation(host: string, variables: readonly string[], signal: AbortSignal): Promise<GhOutput | ForgeFailure> {
    signal.throwIfAborted()
    try {
      return await this.gh(['api', 'graphql', '--hostname', host, ...variables], signal)
    } catch (error) {
      if (signal.aborted) throw signal.reason
      return processFailure(error)
    }
  }
}

/**
 * Report a `gh` invocation that did not run to an exit code.
 * @param error - what the runner threw.
 * @returns `too-large` for output over its limit, `unavailable` for a `gh` that cannot start or times out.
 * @throws `error` when it is any other failure.
 */
function processFailure(error: unknown): ForgeFailure {
  if (error instanceof GhOutputLimitError) return { code: 'too-large', message: error.message }
  if (error instanceof GhUnavailableError || error instanceof GhTimeoutError) return { code: 'unavailable', message: error.message }
  throw error
}

/** Why `gh` refused: GitHub's message, else its first diagnostic line, with the HTTP status it names. */
function refusal(output: GhOutput): { readonly message: string; readonly status: string | undefined } {
  return {
    message: hostMessage(output.stdout) ?? firstLine(output.stderr) ?? `gh exited with ${output.exitCode}`,
    status: HTTP_STATUS.exec(output.stderr)?.[1],
  }
}

/** The `message` of the JSON error body `gh api` prints for a failed request. */
function hostMessage(stdout: string): string | undefined {
  const body = parseJson(stdout)
  if (typeof body !== 'object' || body === null || !('message' in body) || typeof body.message !== 'string') return undefined
  return body.message.trim().length > 0 ? body.message : undefined
}

/** A repository path with each segment percent-encoded, for an API path or a web URL. */
function encodedPath(path: string): string {
  return path.split('/').map(segment => encodeURIComponent(segment)).join('/')
}

function responseFailure(output: GhOutput, body: unknown): ForgeFailure {
  const detail = typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string'
    ? firstLine(body.message) : undefined
  const message = firstLine(output.stderr) ?? detail
    ?? (output.exitCode === 0 ? 'unexpected GitHub response' : `gh exited with ${output.exitCode}`)
  return { code: AUTHENTICATION.test(message) ? 'unauthenticated' : 'unavailable', message }
}

function parseJson(text: string): unknown {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    void error // gh prints diagnostics instead of JSON when a request fails before GitHub answers.
    return undefined
  }
  return value
}

function firstLine(text: string): string | undefined {
  return text.split('\n').map(line => line.trim()).find(line => line.length > 0)
}
