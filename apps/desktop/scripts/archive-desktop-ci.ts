/** Validate the original machine and immutable inventory before GitHub artifact archival. */
import { resolve } from 'node:path'
import { desktopPublicationFailure } from './desktop-publication-failure.ts'
import { desktopReleasesRoot } from './retain-desktop-ci.ts'
import { retainedDesktopPath, verifyRetainedDesktopRelease } from './desktop-release-store.ts'

/**
 * Verify an original build without interpreting the archive job's attempt as a new build.
 * @param env Original build outputs and current Actions machine identity.
 * @returns Resolves after the retained inventory passes all digest checks.
 */
export async function verifyDesktopArchive(env: NodeJS.ProcessEnv): Promise<void> {
  if (!env.RUNNER_NAME || env.RUNNER_NAME !== env.DESKTOP_PACKAGE_RUNNER) throw new Error('desktop archival: wrong original machine')
  const root = desktopReleasesRoot(env)
  const runId = env.GITHUB_RUN_ID || ''
  const attempt = env.DESKTOP_PACKAGE_ATTEMPT || ''
  const expected = retainedDesktopPath(root, runId, attempt)
  if (env.DESKTOP_RETAINED_DIRECTORY !== expected) throw new Error('desktop archival: retained directory differs from original build')
  const manifest = await verifyRetainedDesktopRelease(root, runId, attempt)
  if (manifest.source.repository !== env.GITHUB_REPOSITORY || manifest.source.runnerName !== env.RUNNER_NAME) {
    throw new Error('desktop archival: retained source does not match repository or machine')
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  try { await verifyDesktopArchive(process.env) }
  catch (error) {
    process.stderr.write(`${JSON.stringify(desktopPublicationFailure(error, 'artifact archival'))}\n`)
    process.exitCode = 1
  }
}
