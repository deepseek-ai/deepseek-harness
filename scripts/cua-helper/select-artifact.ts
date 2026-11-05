/** Find a matching retained helper on the Mac runner before installing dependencies. */
import assert from 'node:assert/strict'
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
 * @returns Resolves to the matching producer artifact, or undefined when automatic discovery has no match.
 */
export async function selectCuaHelperArtifact(repository: string, runId: string, buildKey: string,
  api: (path: string, paginate?: boolean) => Promise<unknown>, matchesSource: (commit: string) => Promise<boolean>,
  now = new Date()): Promise<CuaHelperSelection | undefined> {
  assert(/^[\w.-]+\/[\w.-]+$/u.test(repository) && !repository.split('/').some(part => part === '.' || part === '..'),
    'CUA reuse: invalid repository')
  assert(runId === '' || /^[1-9]\d*$/u.test(runId), 'CUA reuse: enter the numeric run ID after /actions/runs/ in the run URL')
  assert(/^[a-f0-9]{64}$/u.test(buildKey), 'CUA reuse: invalid build key')
  const base = `repos/${repository}/actions`
  const selectRun = async (candidate: string, retained?: Record<string, unknown>[]): Promise<CuaHelperSelection | string> => {
    const attempt = id(record(await api(`${base}/runs/${candidate}`)).run_attempt)
    const run = record(await api(`${base}/runs/${candidate}/attempts/${attempt}`))
    assert(id(run.id) === candidate && id(run.run_attempt) === attempt
      && record(run.repository).full_name === repository && record(run.head_repository).full_name === repository,
    'CUA reuse: selected run, attempt or repository does not match GitHub evidence')
    const workflow = workflows.find(name => run.path === `.github/workflows/${name}`)
    assert(workflow && run.event === 'workflow_dispatch', 'CUA reuse: select a supported repository packaging or release run')
    if (run.status !== 'completed') return 'the latest attempt has not completed'
    if (workflow === 'cua-helper-package.yml' && run.conclusion !== 'success') return 'the latest packaging attempt did not succeed'
    const jobName = workflow === 'cua-helper-package.yml' ? 'package' : 'cua-helper / package'
    const jobs = rows(await api(`${base}/runs/${candidate}/jobs?filter=all&per_page=100`, true), 'jobs')
      .filter(job => job.name === jobName)
    const attempts = jobs.map(job => Number(id(job.run_attempt)))
    assert(attempts.every(value => value <= Number(attempt)), 'CUA reuse: run advanced during selection; retry with the same run ID')
    const producerAttempt = Math.max(0, ...attempts)
    const producers = jobs.filter(job => job.run_attempt === producerAttempt)
    if (producers.length !== 1 || producers[0]?.conclusion !== 'success') return `the last executed ${jobName} job did not succeed`
    const name = `cua-helper-${candidate}-${producerAttempt}-${buildKey}`
    const artifacts = (retained ?? rows(await api(`${base}/runs/${candidate}/artifacts?per_page=100`, true), 'artifacts'))
      .filter(artifact => artifact.name === name)
    if (artifacts.length === 0) return 'no artifact matches the current source bytes and build configuration; use the producer run linked in its summary or rebuild'
    const [artifact] = artifacts
    assert(artifacts.length === 1 && artifact !== undefined, 'CUA reuse: matching artifact is ambiguous')
    assert(typeof artifact.expired === 'boolean' && typeof artifact.size_in_bytes === 'number', 'CUA reuse: invalid artifact metadata')
    if (artifact.expired || artifact.size_in_bytes <= 0) return 'the matching artifact is expired or empty'
    assert(typeof run.head_sha === 'string' && /^[a-f0-9]{40}$/u.test(run.head_sha), 'CUA reuse: invalid producer head SHA')
    if (!await matchesSource(run.head_sha)) return 'the producer commit has different helper build inputs'
    return { runId: candidate, attempt: String(producerAttempt), artifactId: id(artifact.id) }
  }
  if (runId !== '') {
    const selected = await selectRun(runId)
    if (typeof selected === 'string') throw new Error(`CUA reuse: run ${runId}: ${selected}`)
    return selected
  }
  const since = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString()
  const candidates: Record<string, unknown>[] = []
  for (const workflow of workflows) {
    candidates.push(...rows(await api(
      `${base}/workflows/${workflow}/runs?event=workflow_dispatch&status=completed&created=${encodeURIComponent(`>=${since}`)}&per_page=100`,
      true), 'workflow_runs'))
  }
  candidates.sort((left, right) => Number(id(right.id)) - Number(id(left.id)))
  for (const candidate of candidates) {
    const candidateId = id(candidate.id)
    const artifacts = rows(await api(`${base}/runs/${candidateId}/artifacts?per_page=100`, true), 'artifacts')
    if (!artifacts.some(artifact => typeof artifact.name === 'string'
      && artifact.name.startsWith(`cua-helper-${candidateId}-`) && artifact.name.endsWith(`-${buildKey}`))) continue
    const selected = await selectRun(candidateId, artifacts)
    if (typeof selected !== 'string') return selected
  }
  return undefined
}

/**
 * Create authenticated, read-only GitHub requests using Node's built-in fetch.
 * Each call, including pagination, has a 60-second deadline and a 32 MiB response limit.
 * Pagination stays on the configured API origin. Request or parsing failures never return partial pages.
 * @param environment - GH_TOKEN and optional GITHUB_API_URL supplied by Actions.
 * @param request - HTTP transport receiving the authenticated URL and request options.
 * @returns JSON reader; paginated calls resolve to an array of page objects.
 */
export function createGitHubJsonReader(environment: NodeJS.ProcessEnv, request: typeof fetch = fetch):
(path: string, paginate?: boolean) => Promise<unknown> {
  const token = environment.GH_TOKEN?.trim()
  if (!token) throw new Error('CUA reuse: GH_TOKEN is required for GitHub API access')
  const configured = environment.GITHUB_API_URL ?? 'https://api.github.com'
  let base: URL
  try { base = new URL(configured.endsWith('/') ? configured : `${configured}/`) } catch (_error) {
    // URL parser errors may include credential-bearing configuration.
    throw new Error('CUA reuse: GITHUB_API_URL must be a valid HTTPS API URL')
  }
  assert(base.protocol === 'https:' && !base.username && !base.password && !base.search && !base.hash,
    'CUA reuse: GITHUB_API_URL must be HTTPS without credentials, query or fragment')
  return async (path, paginate = false) => {
    let target = new URL(path, base)
    const visited = new Set<string>()
    const pages: unknown[] = []
    let bytes = 0
    const signal = AbortSignal.timeout(60_000)
    while (true) {
      assert(target.origin === base.origin && target.pathname.startsWith(base.pathname)
        && !target.username && !target.password && !target.hash, 'CUA reuse: GitHub pagination left the configured API')
      assert(!visited.has(target.href), 'CUA reuse: GitHub returned a pagination cycle')
      visited.add(target.href)
      let response: Response
      try {
        response = await request(target, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'deepseek-harness-cua-helper' },
          redirect: 'error', signal,
        })
      } catch (error) {
        throw new Error('CUA reuse: GitHub request failed or timed out; check connectivity and retry this workflow', { cause: error })
      }
      if (!response.ok) {
        try { await response.body?.cancel() } catch (_error) {
          // A failed body stream must not hide the HTTP failure already received.
        }
        throw new Error(`CUA reuse: GitHub request failed (HTTP ${response.status}); check token permissions, rate limits or service availability, then retry`)
      }
      const reader = response.body?.getReader()
      if (!reader) throw new Error('CUA reuse: GitHub returned an empty response')
      const chunks: Uint8Array[] = []
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > 32 * 1024 * 1024) {
            await reader.cancel()
            throw new Error('CUA reuse: GitHub response exceeds 32 MiB')
          }
          chunks.push(chunk.value)
        }
      } finally { reader.releaseLock() }
      let value: unknown
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (_error) {
        // JSON parser errors may include response bytes.
        throw new Error('CUA reuse: GitHub returned invalid JSON; retry this workflow')
      }
      if (!paginate) return value
      pages.push(value)
      const link = response.headers.get('link') ?? ''
      const next = /<([^>]+)>\s*;\s*rel="next"/u.exec(link)?.[1]
      assert(next || !link.includes('rel="next"'), 'CUA reuse: GitHub returned an invalid pagination link')
      if (!next) return pages
      target = new URL(next, target)
    }
  }
}

if (isEntry(import.meta.url)) {
  const env = process.env
  if (!env.GITHUB_REPOSITORY || !env.GITHUB_OUTPUT || !env.GITHUB_STEP_SUMMARY || !env.CUA_BUILD_KEY) {
    throw new Error('CUA reuse: Actions context and CUA_BUILD_KEY are required')
  }
  const githubJson = createGitHubJsonReader(env)
  const repository = env.GITHUB_REPOSITORY
  const root = resolve(import.meta.dirname, '../..')
  const sourceMatches = new Map<string, boolean>()
  const selection = await selectCuaHelperArtifact(repository, env.CUA_RUN_ID ?? '', env.CUA_BUILD_KEY, githubJson, async (commit) => {
    let matches = sourceMatches.get(commit)
    if (matches === undefined) {
      matches = await cuaHelperSourceMatches(root, repository, commit, githubJson)
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
