/** Validate the original machine and immutable inventory before GitHub artifact archival. */
import { execFileSync } from 'node:child_process'
import { appendFile, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { desktopPublicationFailure } from './desktop-publication-failure.ts'
import { desktopReleasesRoot } from './retain-desktop-ci.ts'
import { retainedDesktopPath, verifyRetainedDesktopRelease } from './desktop-release-store.ts'

/**
 * Verify an original build without interpreting the archive job's attempt as a new build.
 * @param env Original build outputs and current Actions machine identity.
 * @returns Verified file names to include alongside the manifest.
 */
export async function verifyDesktopArchive(env: NodeJS.ProcessEnv): Promise<string[]> {
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
  return ['manifest.json', ...manifest.files.map(file => file.name)]
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  try {
    const files = await verifyDesktopArchive(process.env)
    const { DESKTOP_ARCHIVE_NAME: name, DESKTOP_RETAINED_DIRECTORY: directory, RUNNER_TEMP: temp, GITHUB_OUTPUT: output } = process.env
    if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9.+_-]*\.zip$/u.test(name) || !directory || !temp || !output) throw new Error('desktop archival: invalid ZIP output settings')
    const path = join(await mkdtemp(join(temp, 'desktop-archive-')), name)
    execFileSync('tar', ['--format', 'zip', '--options', 'zip:compression=store', '--no-mac-metadata', '--no-xattrs', '-cf', path, '--', ...files], { cwd: directory, stdio: 'inherit' })
    await appendFile(output, `path=${path}\n`)
  } catch (error) {
    process.stderr.write(`${JSON.stringify(desktopPublicationFailure(error, 'artifact archival'))}\n`)
    process.exitCode = 1
  }
}
