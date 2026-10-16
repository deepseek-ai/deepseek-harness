/** Select an exact successful package attempt and its original runner without downloading installers. */
import { execFileSync } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'

const positiveId = z.string().regex(/^[1-9]\d*$/u)
const inputsSchema = z.object({ package_run_id: positiveId, package_run_attempt: z.union([positiveId, z.literal('')]).optional() })
const runSchema = z.object({ id: z.number().int().positive(), run_attempt: z.number().int().positive(),
  head_sha: z.string().regex(/^[a-f0-9]{40}$/u), status: z.literal('completed'), conclusion: z.literal('success'),
  event: z.literal('workflow_dispatch'), path: z.enum(['.github/workflows/macos-package.yml', '.github/workflows/windows-package.yml']),
  repository: z.object({ full_name: z.string() }) })
const jobsSchema = z.object({ jobs: z.array(z.object({
  name: z.string(), runner_name: z.string().nullable(), conclusion: z.string().nullable(),
})) })
const routesSchema = z.record(z.string(), z.object({ label: z.string().regex(/^dsh-[a-z0-9-]+$/u), target: z.enum(['mac-arm64', 'win-x64']) }))

/**
 * Read GitHub evidence for one explicit attempt, or the latest attempt without falling back after failure.
 * @param repository Repository containing the package workflow.
 * @param inputsValue Manual dispatch inputs.
 * @param routesValue Configured original-machine publishing labels.
 * @param api Read-only GitHub JSON request; pagination is requested for the jobs endpoint.
 * @returns Pinned attempt evidence and its unique machine label for local manifest verification.
 */
export function selectDesktopPackage(repository: string, inputsValue: unknown, routesValue: unknown,
  api: (path: string, paginate?: boolean) => unknown) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) throw new Error('desktop publish: invalid repository')
  const inputs = inputsSchema.parse(inputsValue)
  const base = `repos/${repository}/actions/runs/${inputs.package_run_id}`
  const attempt = inputs.package_run_attempt || String(z.object({ run_attempt: z.number().int().positive() }).parse(api(base)).run_attempt)
  const run = runSchema.parse(api(`${base}/attempts/${attempt}`))
  if (String(run.id) !== inputs.package_run_id || String(run.run_attempt) !== attempt || run.repository.full_name !== repository) {
    throw new Error('desktop publish: selected run or attempt does not match GitHub evidence')
  }
  const jobs = z.array(jobsSchema).parse(api(`${base}/attempts/${attempt}/jobs?per_page=100`, true)).flatMap(page => page.jobs)
  const packages = jobs.filter(job => job.name === 'package' && job.conclusion === 'success' && job.runner_name)
  if (packages.length !== 1) throw new Error('desktop publish: expected one successful package job')
  const runnerName = packages[0]!.runner_name!
  const routes = routesSchema.parse(routesValue)
  const route = routes[runnerName]
  const target = run.path.endsWith('/macos-package.yml') ? 'mac-arm64' : 'win-x64'
  if (!route || route.target !== target) throw new Error('desktop publish: original machine has no configured publishing route')
  if (new Set(Object.values(routes).map(value => value.label)).size !== Object.keys(routes).length) {
    throw new Error('desktop publish: each configured machine needs its own unique runner label')
  }
  return { run, jobs, routes, runnerName, runnerLabel: route.label }
}

/**
 * Read GitHub JSON with bounded execution and output size.
 * @param path Repository API path.
 * @param paginate Whether to return all pages as an array.
 * @returns Parsed JSON, validated by the caller before use.
 */
export function desktopPublishApi(path: string, paginate = false): unknown {
  return JSON.parse(execFileSync('gh', ['api', ...(paginate ? ['--paginate', '--slurp'] : []), path],
    { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }))
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  const env = process.env
  if (!env.GITHUB_EVENT_PATH || !env.GITHUB_REPOSITORY || !env.GITHUB_OUTPUT) throw new Error('desktop publish: Actions context required')
  const event = z.object({ inputs: inputsSchema }).parse(JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')))
  const inputs = { ...event.inputs, package_run_attempt: env.DESKTOP_PACKAGE_ATTEMPT || event.inputs.package_run_attempt }
  const selected = selectDesktopPackage(env.GITHUB_REPOSITORY, inputs, JSON.parse(env.DESKTOP_PUBLISH_RUNNERS || '{}'), desktopPublishApi)
  await appendFile(env.GITHUB_OUTPUT, `selection=${JSON.stringify(selected)}\nrunner=${selected.runnerLabel}\n`)
}
