/** GitHub implementation of the forge provider contract. */

import { changeRequestKey } from '@deepseek-ai/dsh-experimental-forge'
import type {
  ChangeRequestKey, ChangeRequestRef, ChangeRequestSnapshot, ForgeActionFailure, ForgeCommitList, ForgeFailure, ForgeProvider,
  ForgeReadiness, ForgeRepository, ForgeReviewRequest, ForgeReviewResult, MergeRequest,
} from '@deepseek-ai/dsh-experimental-forge'
import { listCommits } from './commits.ts'
import type { GraphqlReader } from './commits.ts'
import { GhOutputLimitError, GhTimeoutError, GhUnavailableError } from './gh.ts'
import type { GhOutput, GhRunner } from './gh.ts'
import { CHECKS_QUERY, hasGraphqlFields, HEAD_QUERY, mapCheckPageResponse, mapHeadResponse, mapSnapshotResponse, snapshotQuery } from './graphql.ts'
import { checkedRepository, parsePullRequestUrl, parseRemoteUrl } from './urls.ts'
import { submitGitHubReview } from './review.ts'

const AUTHENTICATION = /gh auth login|authentication|bad credentials|HTTP 401/i

/** Status code `gh api` appends to the message of a failed request. */
const HTTP_STATUS = /\(HTTP (\d{3})\)/

/**
 * GitHub's error code for an answer over its size limits, such as a diff over
 * 300 files: `gh pr diff` prints it after the field, and `gh api` returns it in the JSON error body.
 */
const TOO_LARGE = /\btoo_large\b/

/** HTTP status GitHub answers when it refuses to render a diff over its limits. */
const NOT_ACCEPTABLE = '406'

/** A full SHA-1 or SHA-256 object name. */
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

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
   * @param maxOutputBytes - maximum combined JSON bytes retained by an explicit check read.
   * @param maxCommits - most commits one commit listing returns.
   */
  constructor(
    private readonly gh: GhRunner,
    hosts: readonly string[],
    private readonly maxOutputBytes: number,
    private readonly maxCommits: number,
  ) {
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
      if (error instanceof GhUnavailableError || error instanceof GhTimeoutError || error instanceof GhOutputLimitError) {
        return { code: error instanceof GhOutputLimitError ? 'too-large' : 'unavailable', message: error.message }
      }
      throw error
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
    if (!COMMIT.test(request.headSha)) throw new Error(`forge-github: invalid head commit ${JSON.stringify(request.headSha)}`)
    return await this.act([
      'api', '--hostname', host, '--method', 'PUT', `repos/${owner}/${name}/pulls/${ref.number}/merge`,
      '-f', `merge_method=${request.method}`, '-f', `sha=${request.headSha}`,
    ], signal)
  }

  /** Read the pull request's diff with `gh pr diff`, which GitHub computes against the merge base. */
  async diff(ref: ChangeRequestRef, signal: AbortSignal): Promise<string | ForgeFailure> {
    const { host, owner, name } = checkedRepository(ref)
    const failure = this.hostFailure(host)
    if (failure !== undefined) return failure
    return await this.read(['pr', 'diff', String(ref.number), '--repo', `${host}/${owner}/${name}`, '--color', 'never'], signal)
  }

  /** Read one file at a commit through the contents API in its raw form. */
  async fileText(ref: ChangeRequestRef, commit: string, path: string, signal: AbortSignal): Promise<string | ForgeFailure> {
    const { host, owner, name } = checkedRepository(ref)
    const failure = this.hostFailure(host)
    if (failure !== undefined) return failure
    if (!COMMIT.test(commit)) throw new Error(`forge-github: invalid commit ${JSON.stringify(commit)}`)
    return await this.read([
      'api', '--hostname', host, '-H', 'Accept: application/vnd.github.raw+json',
      `repos/${owner}/${name}/contents/${encodedPath(path)}?ref=${commit}`,
    ], signal)
  }

  /** List the pull request's commits through GraphQL, at most `maxCommits`, all read at one head. */
  async commits(ref: ChangeRequestRef, signal: AbortSignal): Promise<ForgeCommitList | ForgeFailure> {
    const failure = this.hostFailure(ref.repository.host)
    if (failure !== undefined) return failure
    return await listCommits(this.graphql, ref, this.maxCommits, signal)
  }

  /** Read the changes between two commits through the compare API in its diff form. */
  async compare(ref: ChangeRequestRef, base: string, head: string, signal: AbortSignal): Promise<string | ForgeFailure> {
    const failure = this.hostFailure(checkedRepository(ref).host)
    if (failure !== undefined) return failure
    return await readComparison(async (args, operation) => await this.read(args, operation), ref.repository, base, head, signal)
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

  /** Run one GraphQL request; a refusal, a body that is not GraphQL, and GraphQL errors become failures. */
  private readonly graphql: GraphqlReader = async (args, signal) => {
    const output = await this.read(args, signal)
    if (typeof output !== 'string') return { ok: false, failure: output }
    const body = parseJson(output)
    if (!hasGraphqlFields(body)) return { ok: false, failure: { code: 'unavailable', message: 'unexpected GitHub response' } }
    const errors = typeof body === 'object' && body !== null && 'errors' in body && Array.isArray(body.errors) ? body.errors : []
    if (errors.length > 0) return { ok: false, failure: responseFailure({ exitCode: 0, stdout: output, stderr: '' }, errors[0]) }
    return { ok: true, body }
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
    const query = snapshotQuery(refs)
    const output = await this.gh(['api', 'graphql', '--hostname', host, '-f', `query=${query.document}`], signal)
    const body = parseJson(output.stdout)
    if (!completeChecks && hasGraphqlFields(body)) return await mapSnapshotResponse(body, query)
    let bytes = Buffer.byteLength(output.stdout)
    const tooLarge: ForgeFailure = { code: 'too-large', message: 'GitHub check details exceed the output size limit' }
    if (bytes > this.maxOutputBytes) return new Map([...query.targets.values()].map(ref => [changeRequestKey(ref), tooLarge]))
    if (hasGraphqlFields(body)) return await mapSnapshotResponse(body, query, async (id, cursor) => {
      signal.throwIfAborted()
      let page: GhOutput
      try {
        page = await this.gh(['api', 'graphql', '--hostname', host,
          '-f', `query=${CHECKS_QUERY}`, '-f', `id=${id}`, '-f', `cursor=${cursor}`], signal)
      } catch (error) {
        if (signal.aborted) throw signal.reason
        if (error instanceof GhUnavailableError || error instanceof GhTimeoutError || error instanceof GhOutputLimitError) {
          return { ok: false, failure: { code: error instanceof GhOutputLimitError ? 'too-large' : 'unavailable', message: error.message } }
        }
        throw error
      }
      bytes += Buffer.byteLength(page.stdout)
      if (bytes > this.maxOutputBytes) return { ok: false, failure: tooLarge }
      const value = parseJson(page.stdout)
      return hasGraphqlFields(value) ? mapCheckPageResponse(value) : { ok: false, failure: responseFailure(page, value) }
    })
    const failure = responseFailure(output, body)
    return new Map([...query.targets.values()].map(ref => [changeRequestKey(ref), failure] as const))
  }
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

/** Runs one reading `gh` command and maps a refusal to a failure, as the provider's reads do. */
type GhTextReader = (args: readonly string[], signal: AbortSignal) => Promise<string | ForgeFailure>

/**
 * Read the unified patch from the merge base of `base` and `head` to `head` through the REST compare endpoint.
 * Both ends are commit object names, so the answer never follows a moving branch. The patch keeps terminal escape
 * sequences that file contents hold; `gh` 2.97 and newer refuses to print them without `--allow-escape-sequences`.
 * @param read - runs `gh` with the provider's output limit and failure mapping.
 * @param repository - repository that holds both commits, with an owner and name already checked for inlining.
 * @param base - commit whose merge base with `head` starts the patch.
 * @param head - commit the patch ends at.
 * @param signal - cancellation of the read.
 * @returns the patch with `a/` and `b/` path prefixes, or why GitHub did not provide it.
 * @throws when `base` or `head` is not a full commit object name.
 */
async function readComparison(
  read: GhTextReader, repository: ForgeRepository, base: string, head: string, signal: AbortSignal,
): Promise<string | ForgeFailure> {
  for (const commit of [base, head]) {
    if (!COMMIT.test(commit)) throw new Error(`forge-github: invalid commit ${JSON.stringify(commit)}`)
  }
  const { host, owner, name } = repository
  return await read([
    'api', '--hostname', host, '--allow-escape-sequences', '-H', 'Accept: application/vnd.github.diff',
    `repos/${owner}/${name}/compare/${base}...${head}`,
  ], signal)
}
