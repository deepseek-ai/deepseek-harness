/** Select one retained, successful CUA packaging attempt without contacting the Mac runner. */
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'

const positiveId = z.string().regex(/^[1-9]\d*$/u)
const inputsSchema = z.object({
  cua_run_id: positiveId,
  cua_run_attempt: z.union([positiveId, z.literal('')]).optional(),
})
const runSchema = z.object({
  id: z.number().int().positive(), run_attempt: z.number().int().positive(),
  status: z.literal('completed'), conclusion: z.string().nullable(), event: z.literal('workflow_dispatch'),
  path: z.enum(['.github/workflows/cua-helper-package.yml', '.github/workflows/release-publish.yml']),
  repository: z.object({ full_name: z.string() }),
})
const jobsSchema = z.array(z.object({ jobs: z.array(z.object({ name: z.string(), conclusion: z.string().nullable() })) }))
const artifactsSchema = z.array(z.object({ artifacts: z.array(z.object({
  id: z.number().int().positive(), name: z.string(), expired: z.boolean(), size_in_bytes: z.number().int().nonnegative(),
})) }))

/**
 * Pin an explicit attempt or the latest attempt once, then select its immutable artifact ID.
 * A successful helper job in a completed publication run is reusable even if later npm jobs failed.
 * Failure returns no selection; there is no fallback to another attempt. Payload validation remains with stage.ts.
 * @param repository - Repository containing the producer and consuming release.
 * @param inputsValue - Untrusted dispatch fields cua_run_id and optional cua_run_attempt.
 * @param api - Read-only GitHub JSON reader; paginated responses must be arrays of pages.
 * @returns Exact run, attempt and artifact to download before source/version and application validation.
 */
export function selectCuaHelperArtifact(repository: string, inputsValue: unknown,
  api: (path: string, paginate?: boolean) => unknown): { runId: string; attempt: string; artifactId: string } {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository) || repository.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('CUA reuse: invalid repository')
  }
  const inputs = inputsSchema.parse(inputsValue)
  const base = `repos/${repository}/actions/runs/${inputs.cua_run_id}`
  const attempt = inputs.cua_run_attempt
    || String(z.object({ run_attempt: z.number().int().positive() }).parse(api(base)).run_attempt)
  const run = runSchema.parse(api(`${base}/attempts/${attempt}`))
  if (String(run.id) !== inputs.cua_run_id || String(run.run_attempt) !== attempt || run.repository.full_name !== repository) {
    throw new Error('CUA reuse: selected run, attempt or repository does not match GitHub evidence')
  }
  const jobName = run.path === '.github/workflows/cua-helper-package.yml' ? 'package' : 'cua-helper / package'
  if (jobName === 'package' && run.conclusion !== 'success') {
    throw new Error('CUA reuse: standalone packaging did not succeed; select a successful attempt')
  }
  const jobs = jobsSchema.parse(api(`${base}/attempts/${attempt}/jobs?per_page=100`, true))
    .flatMap(page => page.jobs).filter(job => job.name === jobName)
  if (jobs.length !== 1 || jobs[0]?.conclusion !== 'success') {
    throw new Error(`CUA reuse: run ${inputs.cua_run_id}, attempt ${attempt} requires one successful ${jobName} job;`
      + ' select a successful attempt')
  }
  const name = `cua-helper-${inputs.cua_run_id}-${attempt}`
  const artifacts = artifactsSchema.parse(api(`${base}/artifacts?per_page=100`, true))
    .flatMap(page => page.artifacts).filter(artifact => artifact.name === name)
  const [artifact] = artifacts
  if (artifacts.length !== 1 || artifact === undefined || artifact.expired || artifact.size_in_bytes === 0) {
    throw new Error(`CUA reuse: ${name} is missing, expired, empty or ambiguous; select an available build or rebuild`)
  }
  return { runId: inputs.cua_run_id, attempt, artifactId: String(artifact.id) }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  const env = process.env
  if (!env.GITHUB_EVENT_PATH || !env.GITHUB_REPOSITORY || !env.GITHUB_OUTPUT) throw new Error('CUA reuse: Actions context required')
  const event = z.object({ inputs: inputsSchema }).parse(JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')))
  const selection = selectCuaHelperArtifact(env.GITHUB_REPOSITORY, event.inputs, (path, paginate) =>
    JSON.parse(execFileSync('gh', ['api', ...(paginate ? ['--paginate', '--slurp'] : []), path],
      { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })))
  appendFileSync(env.GITHUB_OUTPUT, `artifact-id=${selection.artifactId}\nattempt=${selection.attempt}\n`)
  console.log(`CUA helper: run ${selection.runId}, attempt ${selection.attempt}, artifact ${selection.artifactId}`)
}
