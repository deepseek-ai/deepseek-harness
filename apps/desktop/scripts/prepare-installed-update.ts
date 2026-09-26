/** Allocate operator qualification materials or inspect journals; never signs, uploads, or installs. */
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { collectInstalledUpdateJournals, createInstalledUpdateRun, inspectInstalledUpdateJournals } from './installed-update-qualification.ts'
import { prepareInstalledUpdateBootstrap } from './prepare-installed-update-bootstrap.ts'
import { prepareInstalledUpdateRuntime } from './prepare-installed-update-runtime.ts'
import { planInstalledUpdateDistribution } from './installed-update-distribution.ts'
import { prepareInstalledUpdateApplication } from './prepare-installed-update-application.ts'

const repository = resolve(import.meta.dirname, '../../..')

async function main(): Promise<void> {
  const [command, original, successor, directory, ...extra] = process.argv.slice(2)
  if (command === 'collect' && original !== undefined && successor !== undefined && directory === undefined) {
    console.log(JSON.stringify({ collection: await collectInstalledUpdateJournals(original, successor), operatorAcceptance: 'pending' }, null, 2))
    return
  }
  if (command === 'application' && original !== undefined && successor === undefined) {
    console.log(JSON.stringify(await prepareInstalledUpdateApplication(original, resolve(repository, 'apps/desktop')), null, 2))
    return
  }
  if (command === 'files' && original !== undefined && successor !== undefined && directory === undefined) {
    console.log(JSON.stringify(await planInstalledUpdateDistribution(original, successor), null, 2))
    return
  }
  if (command === 'bootstrap' && original !== undefined && successor === undefined) {
    console.log(JSON.stringify({ bootstrap: await prepareInstalledUpdateBootstrap(original), launched: false }, null, 2))
    return
  }
  if (command === 'runtime' && original !== undefined && successor === undefined) {
    console.log(JSON.stringify(await prepareInstalledUpdateRuntime(original,
      resolve(repository, 'apps/desktop/.desktop-build/targets/win-x64/dsh')), null, 2))
    return
  }
  if ((command !== 'init' && command !== 'inspect') || original === undefined || successor === undefined
    || extra.length !== 0 || (command === 'init' && directory !== undefined) || (command === 'inspect' && directory === undefined)) {
    throw new Error('usage: prepare-installed-update.ts init <original-test-version> <successor-test-version> | bootstrap <run.json> | runtime <run.json> | application <run.json> | files <run.json> <version> | collect <run.json> <journal-directory> | inspect <original-test-version> <successor-test-version> <journal-directory>')
  }
  if (command === 'inspect') {
    const evidence = await inspectInstalledUpdateJournals(directory!, [original, successor])
    console.log(JSON.stringify(evidence, null, 2))
    if (evidence.recordedFlow === 'incomplete') process.exitCode = 2
    return
  }
  const metadata = JSON.parse(await readFile(resolve(repository, 'package.json'), 'utf8')) as { version: string }
  const git = (args: string[]): string => execFileSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true }).trim()
  const run = await createInstalledUpdateRun(resolve(repository, 'apps/desktop/.desktop-build/qualification'), [original, successor], {
    version: metadata.version, commit: git(['rev-parse', 'HEAD']),
    dirtyFiles: git(['status', '--porcelain=v1', '--untracked-files=normal']).split('\n').filter(Boolean),
  })
  console.log(JSON.stringify({ manifest: resolve(run.root, 'run.json'), appId: run.appId,
    versions: run.versions, feedUrl: `${run.origin}/${run.feedKey}`, artifactsPrepared: false, published: false }, null, 2))
}

main().catch(() => {
  // Inputs may be logs or local configuration; do not echo arbitrary exception details.
  console.error('installed update preparation failed; verify arguments, Git checkout, versions, and local evidence files. No remote operation was attempted.')
  process.exitCode = 1
})
