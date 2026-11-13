/** Address syntax for Git-backed market indexes, shared by the Host and Discover. */

const GIT_ADDRESS = /^git\+(?:https|ssh):\/\//u
const SSH_SHORTHAND = /^git@github\.com:([^\s?#]+)$/iu
const GITHUB_REPOSITORY = /^\/[\w.-]+\/[\w.-]+\/?$/u
const SSH_USER = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u
const DEFAULT_PATH = 'index.json'

/** A Git remote and the file it provides to a market index. */
export interface GitMarketIndexSource {
  readonly url: string
  readonly repository: string
  readonly path: string
  readonly ref?: string
}

/**
 * Recognize Git repository addresses without contacting the source.
 * @param input - pasted index address or repository link.
 * @returns whether the address identifies a Git repository. Other addresses use direct JSON validation.
 */
export function isGitMarketIndexSourceAddress(input: string): boolean {
  const address = input.trim()
  if (GIT_ADDRESS.test(address) || /^ssh:\/\//u.test(address) || SSH_SHORTHAND.test(address)) return true
  if (!URL.canParse(address)) return false
  const url = new URL(address)
  if (url.protocol !== 'https:' || url.hostname === 'raw.githubusercontent.com') return false
  return url.host === 'github.com' ? GITHUB_REPOSITORY.test(url.pathname) : /\.git\/?$/u.test(url.pathname)
}

/**
 * Parse a Git index address for use as a source key and a Git remote. The options belong to the index address.
 * @param input - an explicit `git+https` or `git+ssh` index address.
 * @returns the canonical address, the remote without index options, and the file location.
 * @throws {Error} for an unsupported remote, option, repository-relative path, or ref.
 */
export function parseGitMarketIndexSource(input: string): GitMarketIndexSource {
  if (!GIT_ADDRESS.test(input)) throw new Error('Use a git+https or git+ssh index address')
  const remote = new URL(input.slice(4))
  const ssh = remote.protocol === 'ssh:'
  if (remote.href.includes('#') || remote.password !== '' || (ssh ? !SSH_USER.test(remote.username) : remote.username !== '')) {
    throw new Error('Git index addresses cannot contain credentials or fragments; SSH addresses include an SSH user')
  }
  if (remote.hostname === '' || remote.pathname === '' || remote.pathname === '/' || /[\s\\]/u.test(input)) {
    throw new Error('Use a Git repository address with a host and repository path')
  }
  if (remote.host === 'github.com') {
    if (!GITHUB_REPOSITORY.test(remote.pathname)) throw new Error('Use the GitHub repository address and specify the index file separately')
    const project = remote.pathname.replace(/\/$/u, '')
    remote.pathname = project.endsWith('.git') ? project : `${project}.git`
  }
  const options = remote.searchParams
  const path = options.get('path') ?? DEFAULT_PATH
  const requestedRef = options.get('ref') ?? undefined
  if ([...options].some(([key]) => key !== 'path' && key !== 'ref') || options.getAll('path').length > 1 || options.getAll('ref').length > 1) {
    throw new Error('A Git index address accepts one path and one ref option')
  }
  if (/[\x00-\x1f\x7f\\]/u.test(path) || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('Use an index file path relative to the repository root')
  }
  if (requestedRef !== undefined && (/[\x00-\x20\x7f~^:?*\[\\]/u.test(requestedRef) || requestedRef === '@' || requestedRef === 'HEAD' ||
    requestedRef.startsWith('-') || requestedRef.includes('..') || requestedRef.includes('@{') || requestedRef.endsWith('.') ||
    requestedRef.split('/').some(part => part === '' || part.startsWith('.') || part.endsWith('.lock')))) {
    throw new Error('Use a Git branch name or a full commit SHA')
  }
  const ref = requestedRef !== undefined && /^[0-9a-f]{40}$/iu.test(requestedRef) ? requestedRef.toLowerCase() : requestedRef
  remote.search = ''
  const repository = remote.href
  if (path !== DEFAULT_PATH) remote.searchParams.set('path', path)
  if (ref !== undefined) remote.searchParams.set('ref', ref)
  return { url: `git+${remote.href}`, repository, path, ...ref === undefined ? {} : { ref } }
}

/**
 * Turn a pasted Git repository link into an explicit Git index address.
 * @param input - HTTPS or SSH repository URL, GitHub SSH shorthand, or an existing Git index address.
 * @param path - optional override for the repository-relative index file.
 * @param ref - optional override for the branch or full commit SHA.
 * @returns the canonical index address.
 * @throws {Error} when the address or options cannot be used by a Git index source.
 */
export function gitMarketIndexSource(input: string, path?: string, ref?: string): string {
  const address = input.trim()
  const shorthand = SSH_SHORTHAND.exec(address)
  const url = new URL(shorthand === null ? address.replace(/^git\+/u, '') : `ssh://git@github.com/${shorthand[1]}`)
  if (path !== undefined && path !== '') url.searchParams.set('path', path)
  if (ref !== undefined && ref !== '') url.searchParams.set('ref', ref)
  return parseGitMarketIndexSource(`git+${url.href}`).url
}
