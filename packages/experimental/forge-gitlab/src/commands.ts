/** The GitLab CLI commands that bind merge requests to a Session through forge-session. */

import type { ForgeCommandArguments, ForgeCommandRule, ForgeCommandSelection } from '@deepseek-ai/dsh-experimental-forge-session'

const MERGE_REQUEST_URL = /^(https?:\/\/[^\s/]+\/(?:[^\s/]+\/)+-\/merge_requests\/[1-9]\d*)(?:[/?#].*)?$/
const PROJECT_URL = /^(https?:\/\/[a-z\d.-]+(?::\d+)?)\/((?:[\w.-]+\/)+[\w.-]+?)(?:\.git)?\/?$/i
/** A `.`, `..`, or `-` path segment, which no project path has. */
const DOT_SEGMENT = /\/(?:\.{1,2}|-)(?:\/|$)/
/** A REST path or URL below `/api/v4/` that names one merge request of a project, with the host of a full URL. */
const API_MERGE_REQUEST = new RegExp(String.raw`^(?:https?:\/\/([^/\s?#]+)\/api\/v4\/|\/?(?:api\/v4\/)?)`
  + String.raw`projects\/([^/?#\s]+)\/merge_requests\/([1-9]\d*)(?:[/?#].*)?$`)
const PROJECT_PATH = /^[\w.-]+(?:\/[\w.-]+)+$/
const HOST = /^[a-z\d.-]+(?::\d+)?$/i
/** Placeholders that `glab api` fills from the repository of the current directory. */
const CURRENT_PROJECT = new Set([':fullpath', ':id'])

/**
 * `glab mr create` prints the merge request it opens; `glab mr view`, `glab mr update`, and `glab mr checkout` act on
 * the merge request a URL or a number with `--repo`/`-R` selects. A number whose repository is a full `http` or `https`
 * project URL binds directly; any other repository form resolves through `glab mr view` in the call's shell, which
 * applies the GitLab CLI's own host resolution. `glab api` binds the merge request its REST path names, such as
 * `projects/group%2Fapp/merge_requests/7/changes`: directly with `--hostname` or a full URL, else through `glab mr view`,
 * which for the `:fullpath` and `:id` placeholders reads the repository of the current directory.
 */
export const GLAB_COMMANDS: ForgeCommandRule = {
  id: 'glab',
  version: 2,
  executable: 'glab',
  creates: [['mr', 'create'], ['mr', 'new']],
  references: {
    subcommands: [['mr', 'view'], ['mr', 'update'], ['mr', 'checkout']],
    valueOptions: [
      '--repo', '-R', '--jq', '--output', '-F', '--page', '-p', '--per-page', '-P', '--assignee', '-a', '--description', '-d',
      '--label', '-l', '--milestone', '-m', '--reviewer', '--target-branch', '--title', '-t', '--unlabel', '-u', '--branch',
      '-b', '--set-upstream-to',
    ],
    flagOptions: [
      '--comments', '-c', '--resolved', '--system-logs', '-s', '--unresolved', '--web', '-w', '--draft', '--fill', '-f',
      '--fill-commit-body', '--lock-discussion', '--ready', '-r', '--remove-source-branch', '--squash-before-merge',
      '--unassign', '--unlock-discussion', '--wip', '--yes', '-y', '--force',
    ],
  },
  apiRequests: {
    subcommands: [['api']],
    valueOptions: [
      '--hostname', '--method', '-X', '--field', '-F', '--raw-field', '-f', '--form', '--header', '-H', '--input', '--output',
    ],
    flagOptions: ['--include', '-i', '--paginate', '--silent'],
  },
  changeRequestPath: String.raw`\/-\/merge_requests\/\d+`,
  urlMembers: ['web_url'],
  select: command => command.kind === 'api-request' ? selectApiMergeRequest(command) : selectMergeRequest(command),
}

function selectMergeRequest({ operands, values }: ForgeCommandArguments): ForgeCommandSelection | undefined {
  const [selector] = operands
  if (selector === undefined || operands.length !== 1) return undefined
  const url = MERGE_REQUEST_URL.exec(selector)?.[1]
  if (url !== undefined) return { url }
  const repository = values.findLast(([option]) => option === '--repo' || option === '-R')?.[1]
  if (!/^[1-9]\d*$/.test(selector) || !Number.isSafeInteger(Number(selector)) || repository === undefined) return undefined
  const project = PROJECT_URL.exec(repository)
  if (project !== null && !DOT_SEGMENT.test(repository)) return { url: `${project[1]}/${project[2]}/-/merge_requests/${selector}` }
  return { lookup: lookup(selector, repository) }
}

function selectApiMergeRequest({ operands, values }: ForgeCommandArguments): ForgeCommandSelection | undefined {
  const [endpoint] = operands
  const match = endpoint === undefined || operands.length !== 1 ? null : API_MERGE_REQUEST.exec(endpoint)
  if (match === null) return undefined
  const [, urlHost, encoded, iid] = match
  if (!Number.isSafeInteger(Number(iid))) return undefined
  if (CURRENT_PROJECT.has(String(encoded))) return { lookup: lookup(String(iid)) }
  const path = decoded(String(encoded))
  if (path === undefined || !PROJECT_PATH.test(path) || DOT_SEGMENT.test(`/${path}`)) return undefined
  const host = urlHost ?? values.findLast(([option]) => option === '--hostname')?.[1]
  if (host === undefined) return { lookup: lookup(String(iid), path) }
  return HOST.test(host) ? { url: `https://${host}/${path}/-/merge_requests/${iid}` } : undefined
}

/** `glab mr view` printing one merge request's web URL, in `repository` or in the repository of the current directory. */
function lookup(number: string, repository?: string): string[] {
  return ['glab', 'mr', 'view', number, ...repository === undefined ? [] : ['--repo', repository], '--output', 'json', '--jq', '.web_url']
}

/** A project path decoded from its URL encoding, or undefined when the encoding is malformed. */
function decoded(encoded: string): string | undefined {
  try {
    return decodeURIComponent(encoded)
  } catch (error) {
    void error // A malformed escape names no project.
    return undefined
  }
}
