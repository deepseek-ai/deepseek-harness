/** Create and remove a run-owned checkout for Windows packaging. */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function assertUnlinkedAncestors(directory) {
  for (let current = directory; ; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error('Packaging workspace ancestors must not be links')
    }
    if (dirname(current) === current) break
  }
}

function locations(options) {
  const { buildRoot, runId, runAttempt, sourceSha } = options
  if (!buildRoot || !isAbsolute(buildRoot) || /[\r\n\0]/.test(buildRoot)) {
    throw new Error('Packaging build root must be a nonempty absolute directory')
  }
  const root = resolve(buildRoot)
  if (root === parse(root).root) throw new Error('Packaging build root must not be a volume root')
  if (!/^[1-9]\d*$/.test(runId) || !/^[1-9]\d*$/.test(runAttempt) || !/^[a-f0-9]{40}$/.test(sourceSha)) {
    throw new Error('Packaging workspace requires a run identity and exact commit')
  }
  assertUnlinkedAncestors(root)
  for (let current = root; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) throw new Error('Packaging build root must be outside existing Git checkouts')
    if (dirname(current) === current) break
  }
  const owner = join(root, `windows-package-${runId}-${runAttempt}`)
  assertUnlinkedAncestors(owner)
  return { root, owner, directory: join(owner, 'source'), temporaryDirectory: join(owner, 'temp') }
}

function git(directory, args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function ownership(options, paths) {
  return JSON.stringify({ version: 1, root: paths.root, source: resolve(options.sourceDirectory), runId: options.runId, runAttempt: options.runAttempt, sourceSha: options.sourceSha })
}

/**
 * Clone the validated commit into a new run-owned checkout; failures retain diagnostics.
 * @param {{sourceDirectory: string, buildRoot: string, runId: string, runAttempt: string, sourceSha: string}} options - Source and run identity.
 * @returns {{directory: string, temporaryDirectory: string}} Checkout and temporary directory owned by this run.
 */
export function prepareWindowsBuildWorkspace(options) {
  const paths = locations(options)
  if (git(options.sourceDirectory, ['rev-parse', 'HEAD']) !== options.sourceSha || git(options.sourceDirectory, ['status', '--porcelain'])) {
    throw new Error('Packaging source must be clean and match the selected commit')
  }
  mkdirSync(paths.root, { recursive: true })
  mkdirSync(paths.owner)
  writeFileSync(join(paths.owner, 'owner.json'), ownership(options, paths), { flag: 'wx' })
  mkdirSync(paths.temporaryDirectory)
  git(paths.owner, ['clone', '--no-hardlinks', '--no-checkout', resolve(options.sourceDirectory), paths.directory])
  git(paths.directory, ['checkout', '--detach', options.sourceSha])
  if (git(paths.directory, ['rev-parse', 'HEAD']) !== options.sourceSha || git(paths.directory, ['status', '--porcelain'])) {
    throw new Error('Isolated packaging checkout does not match the selected commit')
  }
  return { directory: paths.directory, temporaryDirectory: paths.temporaryDirectory }
}

/**
 * Remove only the matching run-owned directory after successful artifact upload.
 * Transient filesystem failures retry up to three times; persistent failures propagate.
 * @param {{sourceDirectory: string, buildRoot: string, runId: string, runAttempt: string, sourceSha: string}} options - Original source and run identity.
 * @returns {void}
 */
export function removeWindowsBuildWorkspace(options) {
  const paths = locations(options)
  const marker = join(paths.owner, 'owner.json')
  const stat = lstatSync(marker)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192 || readFileSync(marker, 'utf8') !== ownership(options, paths)) {
    throw new Error('Packaging workspace ownership does not match this run')
  }
  rmSync(paths.owner, { recursive: true, maxRetries: 3, retryDelay: 100 })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = {
    sourceDirectory: process.env.GITHUB_WORKSPACE ?? '',
    buildRoot: process.env.PACKAGE_BUILD_ROOT ?? '',
    runId: process.env.GITHUB_RUN_ID ?? '',
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? '',
    sourceSha: process.env.PACKAGE_SOURCE_SHA ?? '',
  }
  if (process.argv[2] === '--remove') removeWindowsBuildWorkspace(options)
  else {
    if (process.argv.length !== 2 || !process.env.GITHUB_OUTPUT) throw new Error('Expected Actions output file and no arguments')
    const result = prepareWindowsBuildWorkspace(options)
    appendFileSync(process.env.GITHUB_OUTPUT, `directory=${result.directory}\ntemporaryDirectory=${result.temporaryDirectory}\n`)
  }
}
