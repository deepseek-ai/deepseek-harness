/** Reject identifiable debugging artifacts before installing publication dependencies. */
import { execFileSync } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { desktopPublishQualificationError } from './desktop-publish-qualification.mjs'

/**
 * Pin the requested attempt and reject its explicitly named debugging artifacts.
 * Artifact names only reject; local inventory and signature verification still authorize publication.
 * @param {string} repository GitHub repository.
 * @param {{ package_run_id: string, package_run_attempt?: string }} inputs Dispatch inputs.
 * @param {(path: string, paginate?: boolean) => unknown} api Parsed GitHub JSON; validated here without dependencies.
 * @returns {string} Exact attempt for subsequent routing.
 */
export function preflightDesktopPublish(repository, inputs, api) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository) || !/^[1-9]\d*$/u.test(inputs.package_run_id)
    || (inputs.package_run_attempt && !/^[1-9]\d*$/u.test(inputs.package_run_attempt))) {
    throw new Error('desktop publish: repository, package_run_id and package_run_attempt must identify a valid packaging attempt')
  }
  const base = `repos/${repository}/actions/runs/${inputs.package_run_id}`
  const latest = inputs.package_run_attempt ? undefined : api(base)
  const attempt = inputs.package_run_attempt || String(latest && typeof latest === 'object' && 'run_attempt' in latest ? latest.run_attempt : '')
  if (!/^[1-9]\d*$/u.test(attempt)) throw new Error('desktop publish: GitHub returned an invalid attempt')
  const pages = api(`${base}/artifacts?per_page=100`, true)
  if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page.artifacts)
    || page.artifacts.some(artifact => typeof artifact.name !== 'string'))) {
    throw new Error('desktop publish: GitHub returned invalid artifact metadata')
  }
  for (const { name } of pages.flatMap(page => page.artifacts)) {
    if (!name.endsWith(`-${inputs.package_run_id}-${attempt}`)) continue
    const qualification = name.startsWith('windows-x64-unsigned-') ? 'unsigned'
      : /^macos-(?:arm64|x64)-unnotarized-debug-/u.test(name) ? 'unnotarized' : ''
    const diagnostic = desktopPublishQualificationError(qualification)
    if (diagnostic) throw new Error(diagnostic)
  }
  return attempt
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  const env = process.env
  if (!env.GITHUB_EVENT_PATH || !env.GITHUB_REPOSITORY || !env.GITHUB_OUTPUT) throw new Error('desktop publish: Actions context required')
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'))
  const attempt = preflightDesktopPublish(env.GITHUB_REPOSITORY, event.inputs, (path, paginate) =>
    JSON.parse(execFileSync('gh', ['api', ...(paginate ? ['--paginate', '--slurp'] : []), path],
      { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })))
  await appendFile(env.GITHUB_OUTPUT, `attempt=${attempt}\n`)
}
