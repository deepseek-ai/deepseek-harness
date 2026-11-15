/** The GitHub CLI commands that bind pull requests to a Session through forge-session. */

import type { ForgeCommandArguments, ForgeCommandRule, ForgeCommandSelection } from '@deepseek-ai/dsh-experimental-forge-session'

const REPOSITORY = /^(?:([a-z\d.-]+(?::\d+)?)\/)?([a-z\d_-]+)\/([a-z\d_.-]+)$/i
const PULL_URL = /^(https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/[1-9]\d*)(?:[/?#].*)?$/
const HOST = /^[a-z\d.-]+(?::\d+)?$/i
/** A REST path that names one pull request of a repository. */
const API_PULL = /^\/?repos\/([^/\s?#]+)\/([^/\s?#]+)\/pulls\/([1-9]\d*)(?:[/?#].*)?$/
/** Placeholder pairs that `gh api` fills from the repository of the current directory. */
const CURRENT_REPOSITORY = new Set(['{owner}/{repo}', ':owner/:repo'])

/**
 * `gh pr create` prints the pull request it opens; `gh pr view`, `gh pr edit`, and `gh pr checkout` act on the pull
 * request a URL or a number with `--repo`/`-R` selects. A number whose repository names no host takes `GH_HOST` from
 * the command's assignments, else resolves through `gh pr view` in the call's shell. `gh api` binds the pull request its
 * REST path names, such as `repos/octo/demo/pulls/7/files`: directly with `--hostname` or `GH_HOST`, else through
 * `gh pr view`, which for the `{owner}/{repo}` placeholders reads the repository of the current directory.
 */
export const GH_COMMANDS: ForgeCommandRule = {
  id: 'gh',
  version: 2,
  executable: 'gh',
  creates: [['pr', 'create'], ['pr', 'new']],
  references: {
    subcommands: [['pr', 'view'], ['pr', 'edit'], ['pr', 'checkout']],
    valueOptions: [
      '--repo', '-R', '--json', '--jq', '-q', '--template', '-t', '--title', '--body', '-b', '--body-file', '-F', '--base',
      '-B', '--add-assignee', '--add-label', '--add-project', '--add-reviewer', '--milestone', '-m', '--remove-assignee',
      '--remove-label', '--remove-project', '--remove-reviewer', '--branch',
    ],
    flagOptions: ['--comments', '-c', '--web', '-w', '--detach', '-d', '--force', '-f', '--recurse-submodules', '--remove-milestone'],
  },
  apiRequests: {
    subcommands: [['api']],
    valueOptions: [
      '--hostname', '--method', '-X', '--field', '-F', '--raw-field', '-f', '--header', '-H', '--input', '--jq', '-q', '--template',
      '-t', '--preview', '-p', '--cache',
    ],
    flagOptions: ['--include', '-i', '--paginate', '--slurp', '--silent', '--verbose', '--allow-escape-sequences'],
  },
  changeRequestPath: String.raw`\/pull\/\d+`,
  urlMembers: ['url'],
  select: (command, environment) => command.kind === 'api-request' ? selectApiPullRequest(command, environment) : selectPullRequest(command, environment),
}

function selectPullRequest(
  { operands, values }: ForgeCommandArguments,
  environment: Readonly<Record<string, string>>,
): ForgeCommandSelection | undefined {
  const [selector] = operands
  if (selector === undefined || operands.length !== 1) return undefined
  const url = PULL_URL.exec(selector)?.[1]
  if (url !== undefined) return { url }
  const repository = values.findLast(([option]) => option === '--repo' || option === '-R')?.[1]
  if (!/^[1-9]\d*$/.test(selector) || !Number.isSafeInteger(Number(selector)) || repository === undefined) return undefined
  const match = REPOSITORY.exec(repository.replace(/^https?:\/\//, '').replace(/\.git$/, ''))
  if (match === null || match[3] === '.' || match[3] === '..') return undefined
  const [, repoHost, owner, name] = match
  const host = repoHost ?? environment.GH_HOST
  if (host !== undefined && HOST.test(host)) return { url: `https://${host}/${owner}/${name}/pull/${selector}` }
  return { lookup: lookup(selector, repository) }
}

function selectApiPullRequest(
  { operands, values }: ForgeCommandArguments,
  environment: Readonly<Record<string, string>>,
): ForgeCommandSelection | undefined {
  const [endpoint] = operands
  const match = endpoint === undefined || operands.length !== 1 ? null : API_PULL.exec(endpoint)
  if (match === null) return undefined
  const [, owner, name, number] = match
  if (!Number.isSafeInteger(Number(number))) return undefined
  if (CURRENT_REPOSITORY.has(`${owner}/${name}`)) return { lookup: lookup(String(number)) }
  const repository = REPOSITORY.exec(`${owner}/${name}`)
  if (repository === null || name === '.' || name === '..') return undefined
  const host = values.findLast(([option]) => option === '--hostname')?.[1] ?? environment.GH_HOST
  if (host === undefined) return { lookup: lookup(String(number), `${owner}/${name}`) }
  return HOST.test(host) ? { url: `https://${host}/${owner}/${name}/pull/${number}` } : undefined
}

/** `gh pr view` printing one pull request's URL, in `repository` or in the repository of the current directory. */
function lookup(number: string, repository?: string): string[] {
  return ['gh', 'pr', 'view', number, ...repository === undefined ? [] : ['--repo', repository], '--json', 'url', '--jq', '.url']
}
