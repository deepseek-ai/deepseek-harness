/** Validate a completed packaging attempt and route publication back to its original runner. */
import { z } from 'zod'
import { desktopPublishQualificationError } from './desktop-publish-qualification.mjs'

const positive = z.number().int().positive()
const runSchema = z.object({
  id: positive, run_attempt: positive, head_sha: z.string().regex(/^[a-f0-9]{40}$/u),
  path: z.string(), conclusion: z.literal('success'), event: z.literal('workflow_dispatch'),
  repository: z.object({ full_name: z.string() }),
})
const requestSchema = z.object({ source: z.object({
  repository: z.string(), runId: z.string(), attempt: z.string(), commit: z.string().regex(/^[a-f0-9]{40}$/u),
  workflowCommit: z.string(), sourceRef: z.string().min(1),
  channel: z.enum(['nightly', 'latest']),
  runnerName: z.string(), target: z.enum(['mac-arm64', 'win-x64']), preset: z.enum(['test', 'production']),
  qualification: z.enum(['signed', 'notarized', 'unsigned', 'unnotarized']),
}).refine(source => source.preset === 'test' || /^(?:master|dsh-v[0-9][0-9A-Za-z.-]*)$/u.test(source.sourceRef),
  'Production source must be master or dsh-v*') })
const jobsSchema = z.array(z.object({ name: z.string(), runner_name: z.string().nullable(), conclusion: z.string().nullable() }))
const routesSchema = z.record(z.string(), z.object({ label: z.string().regex(/^dsh-[a-z0-9-]+$/u), target: z.enum(['mac-arm64', 'win-x64']) }))

/** Validated values handed to the privileged publisher; no caller-selected shell fragments. */
export interface DesktopPublishRoute {
  readonly runId: string
  readonly attempt: string
  readonly commit: string
  readonly sourceRef: string
  readonly channel: 'nightly' | 'latest'
  readonly runnerName: string
  readonly runnerLabel: string
  readonly target: 'mac-arm64' | 'win-x64'
  readonly preset: 'test' | 'production'
}

/**
 * Match a locally retained manifest to GitHub's attempt/job evidence and configured machine labels.
 * @param repository Current repository, not a value selected by the manifest.
 * @param runValue GitHub response for the exact packaging attempt.
 * @param requestValue Retained manifest read on the original packaging machine.
 * @param jobsValue GitHub jobs for the same packaging attempt.
 * @param routesValue Administrator-maintained runner-name to unique-label mapping.
 * @returns Route to the original machine. Unknown runners, modes and mismatches reject.
 */
export function resolveDesktopPublishRoute(
  repository: string, runValue: unknown, requestValue: unknown, jobsValue: unknown, routesValue: unknown,
): DesktopPublishRoute {
  const run = runSchema.parse(runValue)
  const { source } = requestSchema.parse(requestValue)
  const diagnostic = desktopPublishQualificationError(source.qualification)
  if (diagnostic) throw new Error(diagnostic)
  const jobs = jobsSchema.parse(jobsValue)
  const routes = routesSchema.parse(routesValue)
  const workflow = source.target === 'win-x64' ? '.github/workflows/windows-package.yml' : '.github/workflows/macos-package.yml'
  if (run.repository.full_name !== repository || source.repository !== repository || run.path !== workflow
    || source.runId !== String(run.id) || source.attempt !== String(run.run_attempt)
    || source.workflowCommit !== run.head_sha
    || source.qualification !== (source.target === 'win-x64' ? 'signed' : 'notarized')) {
    throw new Error('desktop publish: request does not match the successful packaging attempt')
  }
  const route = routes[source.runnerName]
  if (!route || route.target !== source.target) throw new Error('desktop publish: original machine has no configured publishing route')
  if (new Set(Object.values(routes).map(value => value.label)).size !== Object.keys(routes).length) {
    throw new Error('desktop publish: each configured machine needs its own unique runner label')
  }
  const matches = jobs.filter(job => job.name === 'package' && job.runner_name === source.runnerName && job.conclusion === 'success')
  if (matches.length !== 1) throw new Error('desktop publish: original job does not establish a single successful packaging runner')
  return { runId: source.runId, attempt: source.attempt, commit: source.commit, sourceRef: source.sourceRef, channel: source.channel,
    runnerName: source.runnerName,
    runnerLabel: route.label, target: source.target, preset: source.preset }
}
