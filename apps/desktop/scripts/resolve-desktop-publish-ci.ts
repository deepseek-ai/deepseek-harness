/** Resolve a workflow_run publication request without reading machine or COS credentials. */
import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { resolveDesktopPublishRoute } from './desktop-publish-route.ts'

const eventSchema = z.object({ workflow_run: z.object({ id: z.number().int().positive(), run_attempt: z.number().int().positive() }) })
const artifactsSchema = z.object({ artifacts: z.array(z.object({ name: z.string(), expired: z.boolean() })) })

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  const env = process.env
  if (!env.GITHUB_EVENT_PATH || !env.GITHUB_REPOSITORY || !env.GITHUB_OUTPUT || !env.RUNNER_TEMP) throw new Error('desktop publish: Actions context required')
  const event = eventSchema.parse(JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')))
  const repository = env.GITHUB_REPOSITORY
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) throw new Error('desktop publish: invalid repository')
  const { id, run_attempt: attempt } = event.workflow_run
  const api = (path: string): unknown => JSON.parse(execFileSync('gh', ['api',
    path], { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }))
  const base = `repos/${repository}/actions/runs/${id}`
  const name = `desktop-publish-request-${id}-${attempt}`
  const pages: unknown = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp',
    `${base}/artifacts?per_page=100`], { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }))
  const match = z.array(artifactsSchema).parse(pages).flatMap(page => page.artifacts)
    .find(artifact => artifact.name === name)
  if (match === undefined) {
    await appendFile(env.GITHUB_OUTPUT, 'publish=false\n')
  } else {
    if (match.expired) throw new Error('desktop publish: request artifact expired')
    const destination = join(env.RUNNER_TEMP, `desktop-request-${id}-${attempt}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`)
    await mkdir(destination, { recursive: false, mode: 0o700 })
    execFileSync('gh', ['run', 'download', String(id), '--repo', repository,
      '--name', name, '--dir', destination], { timeout: 60_000, stdio: 'pipe' })
    const request: unknown = JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8'))
    const jobs = z.object({ jobs: z.array(z.unknown()) }).parse(api(`${base}/attempts/${attempt}/jobs?per_page=100`))
    const route = resolveDesktopPublishRoute(repository, api(`${base}/attempts/${attempt}`),
      request, jobs.jobs, JSON.parse(env.DESKTOP_PUBLISH_RUNNERS || '{}'))
    const source = z.object({ sha: z.string() }).parse(api(`repos/${repository}/commits/${route.commit}`))
    if (source.sha !== route.commit) throw new Error('desktop publish: source commit not found')
    if (route.sourceRef === 'master') {
      const comparison = z.object({ status: z.string() }).parse(api(`repos/${repository}/compare/${route.commit}...master`))
      if (!['ahead', 'identical'].includes(comparison.status)) throw new Error('desktop publish: source is not on master')
    } else {
      const tagged = z.object({ sha: z.string() }).parse(api(`repos/${repository}/commits/${route.sourceRef}`))
      if (tagged.sha !== route.commit) throw new Error('desktop publish: source tag changed')
    }
    {
      const environment = z.object({ protection_rules: z.array(z.object({ type: z.string(),
        reviewers: z.array(z.unknown()).optional() })) })
        .parse(api(`repos/${repository}/environments/desktop-${route.preset}`))
      if (!environment.protection_rules.some(rule => rule.type === 'required_reviewers' && (rule.reviewers?.length ?? 0) > 0)) {
        throw new Error(`desktop publish: desktop-${route.preset} requires configured reviewers`)
      }
    }
    await appendFile(env.GITHUB_OUTPUT, `publish=true\nroute=${JSON.stringify(route)}\nrunner=${route.runnerLabel}\npreset=${route.preset}\n`)
  }
}
