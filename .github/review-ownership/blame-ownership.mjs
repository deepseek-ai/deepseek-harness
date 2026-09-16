/** Merge-base production ownership for approval scoring; PR blobs are data, never programs. */
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
/** GitHub account syntax shared by policy and commit-author validation. */
export const LOGIN = /^[A-Za-z0-9-]+(?:\[bot\])?$/u
const SHA = /^[0-9a-f]{40}$/u

/**
 * Resolve GitHub author accounts for counted commits, retaining unknown authors in the denominator.
 * @param {{totalLines: number, commitLines: Record<string, number>}} measurement Local blame counts.
 * @param {string} repository Owner/name.
 * @param {(path: string, options: object) => Promise<unknown>} api GitHub API caller.
 * @returns {Promise<{totalLines: number, reviewerLines: Record<string, number>}>} Case-folded account counts.
 */
export async function resolveBlameAuthors(measurement, repository, api) {
  const entries = Object.entries(measurement.commitLines)
  if (!Number.isSafeInteger(measurement.totalLines) || measurement.totalLines < 0
    || entries.some(([sha, count]) => !SHA.test(sha) || !Number.isSafeInteger(count) || count <= 0)
    || entries.reduce((sum, [, count]) => sum + count, 0) !== measurement.totalLines) {
    throw new Error('invalid production blame counts')
  }
  const [owner, name] = repository.split('/')
  const reviewerLines = Object.create(null)
  for (let offset = 0; offset < entries.length; offset += 50) {
    const batch = entries.slice(offset, offset + 50)
    const fields = batch.map(([sha], index) => `c${index}: object(oid: "${sha}") { ... on Commit { author { user { login } } } }`)
    const response = await api('/graphql', {
      method: 'POST',
      body: {
        query: `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join('\n')} } }`,
        variables: { owner, name },
      },
    })
    if (response.errors?.length || !response.data?.repository) throw new Error('GitHub blame author lookup failed')
    for (const [index, [, count]] of batch.entries()) {
      const author = response.data.repository[`c${index}`]?.author
      if (!author || !Object.hasOwn(author, 'user')) throw new Error('GitHub returned no blame commit author')
      if (author.user === null) continue
      const login = author.user.login
      if (typeof login !== 'string' || !LOGIN.test(login)) {
        throw new Error('GitHub returned an invalid blame author login')
      }
      const key = login.toLowerCase()
      reviewerLines[key] = (reviewerLines[key] ?? 0) + count
    }
  }
  return { totalLines: measurement.totalLines, reviewerLines }
}

/**
 * Fetch complete history without checking out the PR and measure its old production lines once.
 * @param {{repository: string, number: number, headSha: string}} pull Reviewed pull request.
 * @param {(path: string, options?: object) => Promise<unknown>} api GitHub API caller.
 * @returns {Promise<{totalLines: number, reviewerLines: Record<string, number>}>} Production ownership.
 */
export async function productionOwnership(pull, api) {
  const current = await api(`/repos/${pull.repository}/pulls/${pull.number}`)
  if (current.head?.sha !== pull.headSha || !SHA.test(pull.headSha) || typeof current.base?.ref !== 'string') {
    throw new Error('pull request changed or has no valid base branch')
  }
  const baseRef = `refs/heads/${current.base.ref}`
  await exec('git', ['check-ref-format', baseRef])
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error('GITHUB_TOKEN is not set')
  const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com'
  const environment = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${server}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  }
  const { stdout: shallow } = await exec('git', ['rev-parse', '--is-shallow-repository'])
  await exec('git', [
    'fetch', '--no-tags', ...(shallow.trim() === 'true' ? ['--unshallow'] : []),
    `${server}/${pull.repository}.git`, baseRef, pull.headSha,
  ], { env: environment, maxBuffer: 16 * 1024 * 1024 })
  const { stdout: baseSha } = await exec('git', ['rev-parse', 'FETCH_HEAD'])
  const { stdout } = await exec('python3', [
    fileURLToPath(new URL('blame-production.py', import.meta.url)), baseSha.trim(), pull.headSha,
  ], { maxBuffer: 16 * 1024 * 1024 })
  return resolveBlameAuthors(JSON.parse(stdout), pull.repository, api)
}
