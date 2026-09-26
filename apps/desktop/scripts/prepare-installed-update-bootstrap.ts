/** Prepare immutable per-run bootstrap files without launching the application or loading credentials. */
import { copyFile, constants, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readInstalledUpdateRun } from './installed-update-qualification.ts'

/**
 * Write the shared qualification entry for both versions; refuse to overwrite an existing preparation.
 * @param manifest Original run.json in its allocated directory.
 * @returns The private directory whose two modules must be included in each package's files.
 */
export async function prepareInstalledUpdateBootstrap(manifest: string): Promise<string> {
  const run = await readInstalledUpdateRun(manifest)
  const directory = join(run.root, 'bootstrap')
  await mkdir(directory)
  await copyFile(join(import.meta.dirname, 'installed-update-identity.mjs'),
    join(directory, 'installed-update-identity.mjs'), constants.COPYFILE_EXCL)
  const entry = `import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configureInstalledUpdateIdentity } from './installed-update-identity.mjs'

const run = ${JSON.stringify({ id: run.id, versions: run.versions })}
const metadata = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'))
configureInstalledUpdateIdentity(app, run, metadata, process.env)
await import('./lib/main.js')
`
  await writeFile(join(directory, 'qualification-bootstrap.mjs'), entry, { flag: 'wx', mode: 0o600, flush: true })
  return directory
}
