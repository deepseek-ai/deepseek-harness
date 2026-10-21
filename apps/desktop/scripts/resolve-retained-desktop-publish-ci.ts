/** Resolve publication settings from the original machine's retained package before deployment approval. */
import { appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { desktopReleasesRoot } from './retain-desktop-ci.ts'
import { verifyRetainedDesktopRelease } from './desktop-release-store.ts'
import { resolveDesktopPublishRoute } from './desktop-publish-route.ts'

/**
 * Verify a retained package against GitHub selection evidence, source history and required reviewers.
 * @param env Selected attempt and current runner context; no signing or upload credentials are needed.
 * @param api Read-only GitHub API used for source and Environment checks.
 * @returns Complete route whose deployment environment comes from the retained manifest.
 */
export async function resolveRetainedDesktopPublication(env: NodeJS.ProcessEnv, api: (path: string) => unknown) {
  const selection = z.object({ run: z.object({ id: z.number().int().positive(), run_attempt: z.number().int().positive() }).passthrough(),
    jobs: z.array(z.unknown()), routes: z.unknown(), runnerName: z.string() }).parse(JSON.parse(env.DESKTOP_PACKAGE_SELECTION || '{}'))
  if (!env.GITHUB_REPOSITORY || env.RUNNER_NAME !== selection.runnerName) throw new Error('desktop publish: task was dispatched to a different machine')
  const manifest = await verifyRetainedDesktopRelease(desktopReleasesRoot(env), String(selection.run.id), String(selection.run.run_attempt))
  const route = resolveDesktopPublishRoute(env.GITHUB_REPOSITORY, selection.run, manifest, selection.jobs, selection.routes)
  if (route.runnerName !== env.RUNNER_NAME) throw new Error('desktop publish: retained package belongs to another machine')
  const repository = env.GITHUB_REPOSITORY
  const source = z.object({ sha: z.string() }).parse(await api(`repos/${repository}/commits/${route.commit}`))
  if (source.sha !== route.commit) throw new Error('desktop publish: source commit not found')
  if (!/^dsh-v[0-9][0-9A-Za-z.-]*$/u.test(route.sourceRef)) {
    const comparison = z.object({ status: z.string() }).parse(await api(`repos/${repository}/compare/${route.commit}...${encodeURIComponent(`refs/heads/${route.sourceRef}`)}`))
    if (!['ahead', 'identical'].includes(comparison.status)) throw new Error('desktop publish: source is not on the selected repository branch')
  } else {
    const tagged = z.object({ sha: z.string() }).parse(await api(`repos/${repository}/commits/${encodeURIComponent(`refs/tags/${route.sourceRef}`)}`))
    if (tagged.sha !== route.commit) throw new Error('desktop publish: source tag changed')
  }
  const environment = z.object({ protection_rules: z.array(z.object({ type: z.string(), reviewers: z.array(z.unknown()).optional() })) })
    .parse(await api(`repos/${repository}/environments/desktop-${route.preset}`))
  if (!environment.protection_rules.some(rule => rule.type === 'required_reviewers' && (rule.reviewers?.length ?? 0) > 0)) {
    throw new Error(`desktop publish: desktop-${route.preset} requires configured reviewers`)
  }
  return route
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  const env = process.env
  if (!env.GITHUB_OUTPUT || !env.GH_TOKEN) throw new Error('desktop publish: Actions output and API token required')
  const route = await resolveRetainedDesktopPublication(env, async (path) => {
    const response = await fetch(`${env.GITHUB_API_URL || 'https://api.github.com'}/${path}`, {
      headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) throw new Error(`desktop publish: GitHub verification request failed (HTTP ${response.status})`)
    return response.json()
  })
  await appendFile(env.GITHUB_OUTPUT, `route=${JSON.stringify(route)}\npreset=${route.preset}\n`)
}
