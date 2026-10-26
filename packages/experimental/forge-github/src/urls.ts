/** GitHub remote URL and pull request URL parsing, and validation of the parts inlined into requests. */

import type { ChangeRequestRef, ForgeRepository } from '@deepseek-ai/dsh-experimental-forge'

/** Characters GitHub permits in owner and repository names. */
const SEGMENT = /^[A-Za-z0-9_.-]+$/

/** Host, owner, and repository name addressed by a URL. */
export interface GitHubLocation {
  /** Lowercase host name. */
  readonly host: string
  /** Owner as the URL spells it. */
  readonly owner: string
  /** Repository name without a `.git` suffix. */
  readonly name: string
}

/**
 * Check one owner or repository name segment.
 * @param value - candidate segment.
 * @returns whether GitHub permits the segment and it is not a dot path.
 */
export function isSegment(value: string): boolean {
  return SEGMENT.test(value) && value !== '.' && value !== '..'
}

/**
 * Validate a pull request before its owner, name, and number are inlined into
 * a GraphQL document, a `gh` argument, or an API path.
 * @param ref - pull request on a GitHub host.
 * @returns its repository.
 * @throws when the owner or name is not a permitted segment or the number is not a positive integer.
 */
export function checkedRepository(ref: ChangeRequestRef): ForgeRepository {
  const { owner, name } = ref.repository
  if (!isSegment(owner) || !isSegment(name)) throw new Error(`forge-github: invalid repository ${JSON.stringify(`${owner}/${name}`)}`)
  if (!Number.isSafeInteger(ref.number) || ref.number <= 0) throw new Error(`forge-github: invalid pull request number ${ref.number}`)
  return ref.repository
}

/**
 * Parse a Git remote URL. Accepts `http(s)://[user@]host[:port]/owner/name`,
 * `ssh://[user@]host[:port]/owner/name`, `git://host/owner/name`, and the
 * scp-like `[user@]host:owner/name`, each with an optional `.git` suffix or
 * trailing slash. HTTP(S) ports belong to the host identity; SSH and Git
 * transport ports do not.
 * @param url - fetch or push URL as Git reports it.
 * @returns the location, or undefined for other URL shapes.
 */
export function parseRemoteUrl(url: string): GitHubLocation | undefined {
  const trimmed = url.trim()
  const scheme = /^https?:\/\/(?:[^@/]+@)?([^/:]+(?::\d+)?)\/(.+)$/i.exec(trimmed)
    ?? /^(?:ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed)
  const scp = scheme === null ? /^(?:[^@/:]+@)?([^/:]+):(?!\/\/)(.+)$/.exec(trimmed) : null
  const match = scheme ?? scp
  if (match === null) return undefined
  const [, host = '', path = ''] = match
  const parts = path.replace(/\/+$/, '').replace(/\.git$/i, '').split('/')
  if (parts.length !== 2) return undefined
  const [owner = '', name = ''] = parts
  if (!isSegment(owner) || !isSegment(name)) return undefined
  return { host: host.toLowerCase(), owner, name }
}

/**
 * Parse a pull request web URL such as `https://github.com/owner/name/pull/12/files`.
 * @param url - web URL of a pull request.
 * @returns the location and number, or undefined for other URLs.
 */
export function parsePullRequestUrl(url: string): (GitHubLocation & { readonly number: number }) | undefined {
  const match = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(url.trim())
  if (match === null) return undefined
  const [, host = '', owner = '', name = '', digits = ''] = match
  const number = Number(digits)
  if (!isSegment(owner) || !isSegment(name) || !Number.isSafeInteger(number) || number <= 0) return undefined
  return { host: host.toLowerCase(), owner, name, number }
}
