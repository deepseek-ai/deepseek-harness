/** Find a matching retained helper on the Mac runner before installing dependencies. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isEntry } from '../release/process.ts'
import { cuaHelperSourceMatches } from './build-inputs.ts'

const workflows = ['cua-helper-package.yml', 'release-publish.yml'] as const

function record(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'CUA reuse: invalid GitHub object')
  return value as Record<string, unknown>
}

function id(value: unknown): string {
  assert(typeof value === 'number' && Number.isSafeInteger(value) && value > 0, 'CUA reuse: invalid GitHub identifier')
  return String(value)
}

function rows(value: unknown, key: string): Record<string, unknown>[] {
  assert(Array.isArray(value), 'CUA reuse: expected paginated GitHub response')
  return value.flatMap((page: unknown) => {
    const entries = record(page)[key]
    assert(Array.isArray(entries), `CUA reuse: invalid GitHub ${key}`)
    return entries.map(record)
  })
}

/** Exact producer attempt and immutable artifact selected by the Mac workflow. */
export interface CuaHelperSelection {
  readonly runId: string
  readonly attempt: string
  readonly artifactId: string
}

/**
 * Select the last executed helper job, preserving its producer attempt across pack/publish-only reruns.
 * Automatic misses rebuild; explicit misses and unreadable GitHub evidence fail without selecting another run.
 * @param repository - Same repository that owns the producer and consumer.
 * @param runId - Optional decimal run ID; empty selects automatic discovery.
 * @param buildKey - Source and machine configuration digest required by the consumer.
 * @param api - Read-only GitHub JSON reader; paginated responses are arrays of pages.
 * @param matchesSource - Independent comparison of the producer head SHA with the consuming build inputs.
 * @param now - Discovery time; automatic search covers the artifact's 14-day retention window.
 * @returns Matching producer artifact, or undefined when automatic discovery has no match.
 */
export function selectCuaHelperArtifact(repository: string, runId: string, buildKey: string,
  api: (path: string, paginate?: boolean) => unknown, matchesSource: (commit: string) => boolean,
  now = new Date()): CuaHelperSelection | undefined {
  assert(/^[\w.-]+\/[\w.-]+$/u.test(repository) && !repository.split('/').some(part => part === '.' || part === '..'),
    'CUA reuse: invalid repository')
  assert(runId === '' || /^[1-9]\d*$/u.test(runId), 'CUA reuse: enter the numeric run ID after /actions/runs/ in the run URL')
  assert(/^[a-f0-9]{64}$/u.test(buildKey), 'CUA reuse: invalid build key')
  const base = `repos/${repository}/actions`
  const selectRun = (candidate: string, retained?: Record<string, unknown>[]): CuaHelperSelection | string => {
    const attempt = id(record(api(`${base}/runs/${candidate}`)).run_attempt)
    const run = record(api(`${base}/runs/${candidate}/attempts/${attempt}`))
    assert(id(run.id) === candidate && id(run.run_attempt) === attempt
      && record(run.repository).full_name === repository && record(run.head_repository).full_name === repository,
    'CUA reuse: selected run, attempt or repository does not match GitHub evidence')
    const workflow = workflows.find(name => run.path === `.github/workflows/${name}`)
    assert(workflow && run.event === 'workflow_dispatch', 'CUA reuse: select a supported repository packaging or release run')
    if (run.status !== 'completed') return 'the latest attempt has not completed'
    if (workflow === 'cua-helper-package.yml' && run.conclusion !== 'success') return 'the latest packaging attempt did not succeed'
    const jobName = workflow === 'cua-helper-package.yml' ? 'package' : 'cua-helper / package'
    const jobs = rows(api(`${base}/runs/${candidate}/jobs?filter=all&per_page=100`, true), 'jobs')
      .filter(job => job.name === jobName)
    const attempts = jobs.map(job => Number(id(job.run_attempt)))
    assert(attempts.every(value => value <= Number(attempt)), 'CUA reuse: run advanced during selection; retry with the same run ID')
    const producerAttempt = Math.max(0, ...attempts)
    const producers = jobs.filter(job => job.run_attempt === producerAttempt)
    if (producers.length !== 1 || producers[0]?.conclusion !== 'success') return `the last executed ${jobName} job did not succeed`
    const name = `cua-helper-${candidate}-${producerAttempt}-${buildKey}`
    const artifacts = (retained ?? rows(api(`${base}/runs/${candidate}/artifacts?per_page=100`, true), 'artifacts'))
      .filter(artifact => artifact.name === name)
    if (artifacts.length === 0) return 'no artifact matches the current source bytes and build configuration; use the producer run linked in its summary or rebuild'
    const [artifact] = artifacts
    assert(artifacts.length === 1 && artifact !== undefined, 'CUA reuse: matching artifact is ambiguous')
    assert(typeof artifact.expired === 'boolean' && typeof artifact.size_in_bytes === 'number', 'CUA reuse: invalid artifact metadata')
    if (artifact.expired || artifact.size_in_bytes <= 0) return 'the matching artifact is expired or empty'
    assert(typeof run.head_sha === 'string' && /^[a-f0-9]{40}$/u.test(run.head_sha), 'CUA reuse: invalid producer head SHA')
    if (!matchesSource(run.head_sha)) return 'the producer commit has different helper build inputs'
    return { runId: candidate, attempt: String(producerAttempt), artifactId: id(artifact.id) }
  }
  if (runId !== '') {
    const selected = selectRun(runId)
    if (typeof selected === 'string') throw new Error(`CUA reuse: run ${runId}: ${selected}`)
    return selected
  }
  const since = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString()
  const candidates = workflows.flatMap(workflow => rows(api(
    `${base}/workflows/${workflow}/runs?event=workflow_dispatch&status=completed&created=${encodeURIComponent(`>=${since}`)}&per_page=100`,
    true), 'workflow_runs'))
    .sort((left, right) => Number(id(right.id)) - Number(id(left.id)))
  for (const candidate of candidates) {
    const candidateId = id(candidate.id)
    const artifacts = rows(api(`${base}/runs/${candidateId}/artifacts?per_page=100`, true), 'artifacts')
    if (!artifacts.some(artifact => typeof artifact.name === 'string'
      && artifact.name.startsWith(`cua-helper-${candidateId}-`) && artifact.name.endsWith(`-${buildKey}`))) continue
    const selected = selectRun(candidateId, artifacts)
    if (typeof selected !== 'string') return selected
  }
  return undefined
}

function githubJson(path: string, paginate = false): unknown {
  let output: string
  try {
    output = execFileSync('gh', ['api', ...(paginate ? ['--paginate', '--slurp'] : []), path],
      { encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024 })
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error('CUA reuse: install GitHub CLI (gh) on the Mac runner PATH, then retry this workflow')
    }
    throw new Error('CUA reuse: GitHub lookup failed; check token permissions, rate limits and connectivity, then retry this workflow', { cause: error })
  }
  return JSON.parse(output)
}

if (isEntry(import.meta.url)) {
  const env = process.env
  if (!env.GITHUB_REPOSITORY || !env.GITHUB_OUTPUT || !env.GITHUB_STEP_SUMMARY || !env.CUA_BUILD_KEY) {
    throw new Error('CUA reuse: Actions context and CUA_BUILD_KEY are required')
  }
  const repository = env.GITHUB_REPOSITORY
  const root = resolve(import.meta.dirname, '../..')
  const sourceMatches = new Map<string, boolean>()
  const selection = selectCuaHelperArtifact(repository, env.CUA_RUN_ID ?? '', env.CUA_BUILD_KEY, githubJson, (commit) => {
    let matches = sourceMatches.get(commit)
    if (matches === undefined) {
      matches = cuaHelperSourceMatches(root, repository, commit, githubJson)
      sourceMatches.set(commit, matches)
    }
    return matches
  })
  appendFileSync(env.GITHUB_OUTPUT, `artifact-id=${selection?.artifactId ?? ''}\nrun-id=${selection?.runId ?? ''}\n`)
  const summary = selection
    ? `复用 [CUA helper 构建](https://github.com/${repository}/actions/runs/${selection.runId}/attempts/${selection.attempt})，run ID \`${selection.runId}\`，artifact ID \`${selection.artifactId}\`。跳过依赖安装、编译、签名和公证。`
    : '未找到源码逐字节一致且构建配置匹配的可用 CUA helper 产物，执行依赖安装和重新构建。'
  appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`)
  console.log(summary)
}
