/** Prepare verified installer artifacts and expose their paths to Actions upload steps. */
import { constants } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { appendFile, copyFile, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { desktopPublicationFailure } from '@deepseek-ai/dsh-desktop-publisher/desktop-publication-failure.ts'
import { desktopReleasesRoot } from './retain-desktop-ci.ts'
import { retainedDesktopPath, verifyRetainedDesktopRelease } from '@deepseek-ai/dsh-desktop-publisher/desktop-release-store.ts'

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
    const { DESKTOP_ARCHIVE_NAME: name, DESKTOP_RETAINED_DIRECTORY: directory, RUNNER_TEMP: temp, GITHUB_OUTPUT: output } = process.env
    if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9.+_-]*\.zip$/u.test(name) || !directory || !temp || !output) throw new Error('desktop archival: invalid ZIP output settings')
    const split = process.argv[2] === '--split-macos'
    if (process.argv.length !== (split ? 3 : 2)) throw new Error('desktop archival: usage: archive-desktop-ci.ts [--split-macos]')
    const files = await verifyDesktopArchive(process.env)
    const installers = split ? files.filter(file => /\.(?:dmg|zip)$/u.test(file)) : []
    if (split && (installers.length !== 2 || !installers.some(file => file.endsWith('.dmg')) || !installers.some(file => file.endsWith('.zip')))) {
      throw new Error('desktop archival: split macOS artifacts require one DMG and one update ZIP')
    }
    // archive: false uses the file basename; keep it equal to the upload step's name used for overwrite deletion.
    const staging = await mkdtemp(join(temp, 'desktop-archive-'))
    // Split downloads derive their common identity prefix from DESKTOP_ARCHIVE_NAME without .zip.
    const base = name.slice(0, -4)
    const path = join(staging, split ? `${base}-metadata.zip` : name)
    const outputs = [`${split ? 'metadata-path' : 'path'}=${path}`]
    for (const file of installers) {
      const kind = file.endsWith('.dmg') ? 'dmg' : 'update'
      const filename = `${base}${kind === 'dmg' ? '.dmg' : '-update.zip'}`
      const destination = join(staging, filename)
      await copyFile(join(directory, file), destination, constants.COPYFILE_FICLONE)
      outputs.push(`${kind}-path=${destination}`, `${kind}-name=${filename}`)
    }
    if (split) outputs.push(`metadata-name=${base}-metadata.zip`)
    const archived = files.filter(file => !installers.includes(file))
    const windows = process.platform === 'win32'
    if (windows && !process.env.SystemRoot) throw new Error('desktop archival: SystemRoot is required to locate Windows bsdtar')
    const tar = windows ? join(process.env.SystemRoot!, 'System32', 'tar.exe') : '/usr/bin/tar'
    const metadata = process.platform === 'darwin' ? ['--no-mac-metadata', '--no-xattrs'] : []
    try {
      execFileSync(tar, ['--format', 'zip', '--options', 'zip:compression=store', ...metadata, '-cf', path, '--', ...archived], { cwd: directory, stdio: 'inherit' })
    } catch (cause) {
      throw new Error(`desktop archival: ZIP creation failed with ${tar}. Check system bsdtar availability, its stderr and free space in RUNNER_TEMP.`, { cause })
    }
    await appendFile(output, `${outputs.join('\n')}\n`)
  } catch (error) {
    process.stderr.write(`${JSON.stringify(desktopPublicationFailure(error, 'artifact archival'))}\n`)
    process.exitCode = 1
  }
}
