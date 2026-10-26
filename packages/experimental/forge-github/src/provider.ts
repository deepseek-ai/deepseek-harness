/** GitHub implementation of the forge provider contract. */

import { changeRequestKey } from '@deepseek-ai/dsh-experimental-forge'
import type {
  ChangeRequestKey, ChangeRequestRef, ChangeRequestSnapshot, ForgeActionFailure, ForgeFailure, ForgeProvider, ForgeReadiness,
  ForgeRepository, MergeRequest,
} from '@deepseek-ai/dsh-experimental-forge'
import { GhOutputLimitError, GhTimeoutError, GhUnavailableError } from './gh.ts'
import type { GhOutput, GhRunner } from './gh.ts'
import { hasGraphqlFields, HEAD_QUERY, mapHeadResponse, mapSnapshotResponse, snapshotQuery } from './graphql.ts'
import { checkedRepository, parsePullRequestUrl, parseRemoteUrl } from './urls.ts'

const AUTHENTICATION = /gh auth login|authentication|bad credentials|HTTP 401/i

/** Status code `gh api` appends to the message of a failed request. */
const HTTP_STATUS = /\(HTTP (\d{3})\)/

/**
 * GitHub's error code for an answer over its size limits, such as a diff over
 * 300 files: `gh pr diff` prints it after the field, and `gh api` returns it in the JSON error body.
 */
const TOO_LARGE = /\btoo_large\b/

/** A full SHA-1 or SHA-256 object name. */
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

/** Reads GitHub and GitHub Enterprise pull requests through a `gh` runner. */
export class GitHubProvider implements ForgeProvider {
  readonly forge = 'github'
  private readonly hosts: ReadonlySet<string>

  /**
   * @param gh - runner that executes `gh` on the host.
   * @param hosts - host names this provider serves, such as `github.com` and Enterprise hosts.
   */
  constructor(private readonly gh: GhRunner, hosts: readonly string[]) {
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
    if (TOO_LARGE.test(output.stderr) || TOO_LARGE.test(output.stdout)) return { code: 'too-large', message }
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
  ): Promise<ReadonlyMap<ChangeRequestKey, ChangeRequestSnapshot | ForgeFailure>> {
    const query = snapshotQuery(refs)
    const output = await this.gh(['api', 'graphql', '--hostname', host, '-f', `query=${query.document}`], signal)
    const body = parseJson(output.stdout)
    if (hasGraphqlFields(body)) return mapSnapshotResponse(body, query)
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
