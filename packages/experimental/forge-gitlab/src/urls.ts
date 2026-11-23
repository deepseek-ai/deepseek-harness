/** GitLab remote URL and merge request URL parsing, and validation of the project paths inlined into requests. */

import type { ChangeRequestRef, ForgeRepository } from '@deepseek-ai/dsh-experimental-forge'

/** Characters GitLab permits in one group or project path segment. */
const SEGMENT = /^[A-Za-z0-9_.-]+$/

/** Host, namespace, and project addressed by a URL. */
export interface GitLabLocation {
  /** Lowercase host name. */
  readonly host: string
  /** Group or user namespace, with nested groups joined by `/`. */
  readonly owner: string
  /** Project path without a `.git` suffix. */
  readonly name: string
}

/**
 * Check one group or project path segment.
 * @param value - candidate segment.
 * @returns whether GitLab permits the segment and it is not a dot path.
 */
export function isSegment(value: string): boolean {
  return SEGMENT.test(value) && value !== '.' && value !== '..'
}

/**
 * Split a namespace and project path, rejecting an empty or invalid segment.
 * @param host - host the path is on.
 * @param parts - path segments, the project last.
 * @returns the namespace and project, or undefined.
 */
export function location(host: string, parts: readonly string[]): GitLabLocation | undefined {
  if (parts.length < 2 || !parts.every(isSegment)) return undefined
  return { host: host.toLowerCase(), owner: parts.slice(0, -1).join('/'), name: parts.slice(-1).join('') }
}

/**
 * Validate a merge request before its project path and number are inlined into an API path or a GraphQL variable.
 * @param ref - merge request on a GitLab host.
 * @returns the project's full path, `namespace/project`.
 * @throws when a path segment is not permitted or the number is not a positive integer.
 */
export function checkedProject(ref: ChangeRequestRef): string {
  const { owner, name } = ref.repository
  if (!owner.split('/').every(isSegment) || !isSegment(name)) throw new Error(`forge-gitlab: invalid project ${JSON.stringify(`${owner}/${name}`)}`)
  if (!Number.isSafeInteger(ref.number) || ref.number <= 0) throw new Error(`forge-gitlab: invalid merge request number ${ref.number}`)
  return `${owner}/${name}`
}

/**
 * The REST path prefix of a merge request, with the project path percent-encoded as GitLab requires.
 * @param ref - merge request on a GitLab host.
 * @returns `projects/<encoded path>/merge_requests/<iid>`.
 * @throws as {@link checkedProject} does.
 */
export function mergeRequestPath(ref: ChangeRequestRef): string {
  return `projects/${encodeURIComponent(checkedProject(ref))}/merge_requests/${ref.number}`
}

/**
 * Parse a Git remote URL. Accepts `http(s)://[user@]host[:port]/namespace/project`, `ssh://[user@]host[:port]/…`,
 * `git://host/…`, and the scp-like `[user@]host:namespace/project`, each with an optional `.git` suffix or trailing
 * slash and with nested groups in the namespace. HTTP(S) ports belong to the host identity; SSH and Git transport
 * ports do not.
 * @param url - fetch or push URL as Git reports it.
 * @returns the location, or undefined for other URL shapes.
 */
export function parseRemoteUrl(url: string): GitLabLocation | undefined {
  // The GitHub provider parses the same remote URL forms; the providers share no runtime module but the forge entry,
  // which exports only what the Loader loads, so each keeps its copy.
  /* jscpd:ignore-start */
  const trimmed = url.trim()
  const scheme = /^https?:\/\/(?:[^@/]+@)?([^/:]+(?::\d+)?)\/(.+)$/i.exec(trimmed)
    ?? /^(?:ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed)
  const scp = scheme === null ? /^(?:[^@/:]+@)?([^/:]+):(?!\/\/)(.+)$/.exec(trimmed) : null
  const match = scheme ?? scp
  if (match === null) return undefined
  const [, host = '', path = ''] = match
  /* jscpd:ignore-end */
  return location(host, path.replace(/\/+$/, '').replace(/\.git$/i, '').split('/'))
}

/**
 * Parse a merge request web URL such as `https://gitlab.com/group/project/-/merge_requests/12/diffs`.
 * @param url - web URL of a merge request.
 * @returns the location and number, or undefined for other URLs.
 */
export function parseMergeRequestUrl(url: string): (GitLabLocation & { readonly number: number }) | undefined {
  const match = /^https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)(?:[/?#].*)?$/i.exec(url.trim())
  if (match === null) return undefined
  const [, host = '', path = '', digits = ''] = match
  const number = Number(digits)
  const parsed = location(host, path.split('/'))
  if (parsed === undefined || !Number.isSafeInteger(number) || number <= 0) return undefined
  return { ...parsed, number }
}

/**
 * Parse an issue web URL such as `https://gitlab.com/group/project/-/issues/12`.
 * @param url - web URL of an issue.
 * @returns the location and number, or undefined for other URLs.
 */
export function parseIssueUrl(url: string): (GitLabLocation & { readonly number: number }) | undefined {
  const match = /^https?:\/\/([^/]+)\/(.+?)\/-\/(?:issues|work_items)\/(\d+)(?:[/?#].*)?$/i.exec(url.trim())
  if (match === null) return undefined
  const [, host = '', path = '', digits = ''] = match
  const parsed = location(host, path.split('/'))
  return parsed === undefined ? undefined : { ...parsed, number: Number(digits) }
}

/**
 * Percent-encode each segment of a repository-relative path for a web or API URL.
 * @param path - repository-relative path.
 * @returns the encoded path with `/` kept between segments.
 */
export function encodedPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

/**
 * Build the repository of a location.
 * @param location - parsed host, namespace, and project.
 * @returns the repository of the `gitlab` family.
 */
export function repositoryOf(location: GitLabLocation): ForgeRepository {
  return { forge: 'gitlab', host: location.host, owner: location.owner, name: location.name }
}

/**
 * Resolve an avatar URL GitLab names by its path on the host, as it does for an uploaded avatar without a separate
 * asset host.
 * @param host - GitLab host.
 * @param url - avatar URL as GitLab reports it.
 * @returns the absolute URL, or null when GitLab names none.
 */
export function avatarUrlOf(host: string, url: string | null): string | null {
  return url?.startsWith('/') === true ? `https://${host}${url}` : url
}
