#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import lefthookPackage from 'lefthook/package.json' with { type: 'json' }

const MINIMUM_GIT = [2, 26, 0]
const HOOKS_DIRECTORY = 'dsh-hooks'
const OWNERSHIP_MARKER = '.dsh-lefthook-owned'
const OWNERSHIP_MARKER_VERSION = 1
const OWNERSHIP_MARKER_OWNER = 'deepseek-harness worktree-local lefthook hooks'
const INSTALL_LOCK = 'dsh-lefthook-install.lock'
const INSTALL_LOCK_TIMEOUT_MS = 30_000
const INSTALL_LOCK_INITIALIZATION_TIMEOUT_MS = 5_000
const INSTALL_LOCK_POLL_MS = 50
const ALLOW_HOOKS_PATH_OVERRIDE = 'DSH_LEFTHOOK_ALLOW_HOOKS_PATH_OVERRIDE'
const REPOSITORY_EXTENSION_PATTERN = '^extensions\\.'
function errorCode(error) {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined
}

function commandFailure(command, args, result) {
  const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : ''
  const detail = result.error?.message ?? (stderr || `exit status ${String(result.status)}`)
  return new Error(`${command} ${args.join(' ')} failed: ${detail}`)
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: process.env,
  })
  if (result.status !== 0 && !options.allowStatuses?.includes(result.status)) {
    throw commandFailure(command, args, result)
  }
  return result
}

function git(args, root, options = {}) {
  return capture('git', args, { ...options, cwd: root })
}

function nulValues(result) {
  if (result.status !== 0) return []
  if (result.stdout === '') return ['']
  const output = result.stdout.endsWith('\0') ? result.stdout.slice(0, -1) : result.stdout
  return output.split('\0')
}

function stripGitLineTerminator(output) {
  const withoutLineFeed = output.endsWith('\n') ? output.slice(0, -1) : output
  return process.platform === 'win32' && withoutLineFeed.endsWith('\r')
    ? withoutLineFeed.slice(0, -1)
    : withoutLineFeed
}

function directFileConfigValues(root, configPath, key) {
  return nulValues(git(
    ['config', '--file', configPath, '--no-includes', '--null', '--get-all', key],
    root,
    { allowStatuses: [1] },
  ))
}

function parseFileConfigEntries(fields, key) {
  if (fields.length % 2 !== 0) {
    throw new Error(`git config returned invalid file entries for ${key}`)
  }
  const entries = []
  for (let index = 0; index < fields.length; index += 2) {
    entries.push({ origin: fields[index], value: fields[index + 1] })
  }
  return entries
}

function includedFileConfigEntries(root, configPath, key) {
  const fields = nulValues(git(
    ['config', '--file', configPath, '--includes', '--null', '--show-origin', '--get-all', key],
    root,
    { allowStatuses: [1] },
  ))
  return parseFileConfigEntries(fields, key)
}

function splitConfigNameValue(field, pattern) {
  const separator = field.indexOf('\n')
  if (separator < 0) throw new Error(`git config returned an invalid name and value for ${pattern}`)
  return { name: field.slice(0, separator), value: field.slice(separator + 1) }
}

function directFileConfigMatchingEntries(root, configPath, pattern) {
  const fields = nulValues(git(
    ['config', '--file', configPath, '--no-includes', '--null', '--show-origin', '--get-regexp', pattern],
    root,
    { allowStatuses: [1] },
  ))
  if (fields.length % 2 !== 0) {
    throw new Error(`git config returned invalid matching file entries for ${pattern}`)
  }
  const entries = []
  for (let index = 0; index < fields.length; index += 2) {
    entries.push({ origin: fields[index], ...splitConfigNameValue(fields[index + 1], pattern) })
  }
  return entries
}

function effectiveConfigEntry(root, key) {
  const fields = nulValues(git(
    ['config', '--null', '--show-scope', '--show-origin', '--get', key],
    root,
    { allowStatuses: [1] },
  ))
  if (fields.length === 0) return undefined
  if (fields.length !== 3) {
    throw new Error(`git config returned an invalid scoped value for ${key}`)
  }
  const [scope, origin, value] = fields
  return { origin, scope, value }
}

function parseGitBoolean(value, key) {
  const normalized = value.toLowerCase()
  if (normalized === '' || normalized === 'true' || normalized === 'yes' || normalized === 'on' || normalized === '1') return true
  if (normalized === 'false' || normalized === 'no' || normalized === 'off' || normalized === '0') return false
  throw new Error(`invalid Boolean value for ${key}: ${JSON.stringify(value)}`)
}

function assertSingle(values, key) {
  if (values.length > 1) throw new Error(`multiple ${key} values are not supported`)
  return values[0]
}

function worktreeConfigExtensionEnabled(root, commonConfigPath) {
  const extensionText = assertSingle(
    directFileConfigValues(root, commonConfigPath, 'extensions.worktreeConfig'),
    'extensions.worktreeConfig',
  )
  return extensionText === undefined
    ? false
    : parseGitBoolean(extensionText, 'extensions.worktreeConfig')
}

function hasDirectConfigEntries(root, configPath) {
  return git(['config', '--file', configPath, '--no-includes', '--null', '--list'], root).stdout !== ''
}

function registeredWorktreeConfigPaths(commonDirectory) {
  const paths = [join(commonDirectory, 'config.worktree')]
  const linkedDirectory = join(commonDirectory, 'worktrees')
  try {
    const entries = readdirSync(linkedDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      paths.push(join(linkedDirectory, entry.name, 'config.worktree'))
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
  return paths
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
}

function assertCommonConfigFile(commonConfigPath) {
  const configStat = lstatIfPresent(commonConfigPath)
  if (configStat === undefined || !configStat.isFile() || configStat.isSymbolicLink()) {
    throw new Error(
      `refusing common repository config ${JSON.stringify(commonConfigPath)} because it is not a regular file`,
    )
  }
}

function assertWorktreeConfigFiles(root, commonDirectory, commonConfigPath, currentConfigPath) {
  const extensionEnabled = worktreeConfigExtensionEnabled(root, commonConfigPath)
  for (const configPath of registeredWorktreeConfigPaths(commonDirectory)) {
    const configStat = lstatIfPresent(configPath)
    if (configStat === undefined) continue
    if (!configStat.isFile() || configStat.isSymbolicLink()) {
      const state = extensionEnabled ? 'active' : 'dormant'
      throw new Error(
        `refusing ${state} worktree config ${JSON.stringify(configPath)} because it is not a regular file; `
        + 'replace it with a regular worktree config or remove it before retrying',
      )
    }
    if (extensionEnabled) continue
    if (!hasDirectConfigEntries(root, configPath)) continue
    const isCurrent = normalizedPath(configPath) === normalizedPath(currentConfigPath)
    const owner = isCurrent ? 'current' : 'sibling'
    throw new Error(
      `cannot enable extensions.worktreeConfig while ${owner} dormant worktree config `
      + `${JSON.stringify(configPath)} contains user-owned settings that enabling the extension would activate; `
      + 'inspect and migrate those settings, then enable the extension explicitly or remove them before retrying',
    )
  }
}

function assertSupportedGit(root) {
  const version = git(['--version'], root).stdout.trim()
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(version)
  if (match === null) throw new Error(`cannot determine Git version from ${JSON.stringify(version)}`)
  const actual = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
  for (let index = 0; index < MINIMUM_GIT.length; index += 1) {
    if (actual[index] > MINIMUM_GIT[index]) return
    if (actual[index] < MINIMUM_GIT[index]) {
      throw new Error(`Git 2.26 or newer is required for worktree-local hooks; found ${version}`)
    }
  }
}

function planWorktreeConfigMigration(root, commonConfigPath) {
  const versions = directFileConfigValues(root, commonConfigPath, 'core.repositoryFormatVersion')
  const versionText = assertSingle(versions, 'core.repositoryFormatVersion')
  const version = Number(versionText)
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`unsupported core.repositoryFormatVersion: ${JSON.stringify(versionText)}`)
  }

  if (version === 0) {
    const extensionEntry = directFileConfigMatchingEntries(
      root,
      commonConfigPath,
      REPOSITORY_EXTENSION_PATTERN,
    )[0]
    if (extensionEntry !== undefined) {
      throw new Error(
        `cannot upgrade core.repositoryFormatVersion from 0 while dormant repository extension `
        + `${extensionEntry.name} is configured (${configSource(extensionEntry)}); `
        + 'audit and migrate it, then set repository format 1 explicitly before retrying',
      )
    }
  }

  const extensionEnabled = worktreeConfigExtensionEnabled(root, commonConfigPath)
  const worktreeText = assertSingle(
    directFileConfigValues(root, commonConfigPath, 'core.worktree'),
    'core.worktree',
  )
  if (worktreeText !== undefined) {
    throw new Error(
      `cannot enable extensions.worktreeConfig while core.worktree is in the common config `
      + `(file:${commonConfigPath}: ${JSON.stringify(worktreeText)}); `
      + 'move it to the main worktree config first',
    )
  }

  const directBareText = assertSingle(directFileConfigValues(root, commonConfigPath, 'core.bare'), 'core.bare')
  const directBare = directBareText === undefined ? undefined : parseGitBoolean(directBareText, 'core.bare')
  if (directBare === true) {
    throw new Error(
      `cannot enable extensions.worktreeConfig for a common config with core.bare=true `
      + `(file:${commonConfigPath}: ${JSON.stringify(directBareText)})`,
    )
  }

  return { directBare, extensionEnabled, version }
}

function applyWorktreeConfigMigration(root, commonConfigPath, migration) {
  const { directBare, extensionEnabled, version } = migration
  if (version === 0) {
    git(['config', '--file', commonConfigPath, 'core.repositoryFormatVersion', '1'], root)
  }
  if (!extensionEnabled) {
    git(['config', '--file', commonConfigPath, 'extensions.worktreeConfig', 'true'], root)
  }
  if (directBare === false) {
    git(['config', '--file', commonConfigPath, '--unset-all', 'core.bare'], root)
  }
}

function readInstallLock(lockPath) {
  try {
    return readFileSync(lockPath, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
}

function installLockStat(lockPath) {
  try {
    return lstatSync(lockPath)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
}

function parseInstallLock(record) {
  const match = /^([1-9]\d*) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\n$/i.exec(record)
  if (match === null) return undefined
  const owner = Number(match[1])
  return Number.isSafeInteger(owner) ? owner : undefined
}

function installLockRecordMayBeIncomplete(record) {
  // Exclusive creation exposes the inode before its owner record is fully written.
  return record === '' || (!record.endsWith('\n') && /^[1-9]\d*(?: [0-9a-f-]*)?$/i.test(record))
}

function lockOwnerIsAlive(owner) {
  try {
    process.kill(owner, 0)
    return true
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return false
    if (errorCode(error) === 'EPERM') return true
    throw error
  }
}

function manualLockRecoveryError(lockPath, condition) {
  return new Error(
    `${condition} Lefthook installer lock ${JSON.stringify(lockPath)}. `
    + 'Confirm no Lefthook installer is running, remove it manually, and retry.',
  )
}

function lockOwnershipChangedError(lockPath) {
  return new Error(`Lefthook installer lock ownership changed for ${lockPath}; refusing to remove it`)
}

function releaseInstallLock(lockPath, ownedRecord, ownedStat) {
  const currentStat = installLockStat(lockPath)
  if (
    currentStat === undefined
    || !currentStat.isFile()
    || currentStat.isSymbolicLink()
    || currentStat.dev !== ownedStat.dev
    || currentStat.ino !== ownedStat.ino
    || readInstallLock(lockPath) !== ownedRecord
  ) {
    throw lockOwnershipChangedError(lockPath)
  }
  try {
    unlinkSync(lockPath)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw lockOwnershipChangedError(lockPath)
    }
    throw error
  }
}

/** Hold one opt-in fixture stage until its parent explicitly releases it. */
async function waitForLockTestBarrier(path) {
  writeFileSync(`${path}.ready`, '')
  const deadline = Date.now() + INSTALL_LOCK_TIMEOUT_MS
  while (!existsSync(`${path}.release`)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for installer test barrier ${path}`)
    await new Promise(resolveWait => setTimeout(resolveWait, INSTALL_LOCK_POLL_MS))
  }
}

/** Windows can deny access to a deleted lock until its last reader closes it. */
async function accessInstallLock(operation, deadline) {
  while (true) {
    try {
      return operation()
    } catch (error) {
      if (process.platform !== 'win32' || errorCode(error) !== 'EPERM' || Date.now() >= deadline) throw error
      await new Promise(resolveWait => setTimeout(resolveWait, INSTALL_LOCK_POLL_MS))
    }
  }
}

async function acquireInstallLock(commonDirectory) {
  const lockPath = join(commonDirectory, INSTALL_LOCK)
  const deadline = Date.now() + INSTALL_LOCK_TIMEOUT_MS
  const ownedRecord = `${String(process.pid)} ${randomUUID()}\n`
  let initializingLock
  let observeBarrier = process.env.DSH_TEST_LEFTHOOK_LOCK_OBSERVE_BARRIER
  while (true) {
    try {
      const lockHandle = await accessInstallLock(() => openSync(lockPath, 'wx', 0o600), deadline)
      let ownedStat
      try {
        ownedStat = fstatSync(lockHandle)
        const publicationBarrier = process.env.DSH_TEST_LEFTHOOK_LOCK_PUBLISH_BARRIER
        if (publicationBarrier !== undefined) await waitForLockTestBarrier(publicationBarrier)
        writeFileSync(lockHandle, ownedRecord)
      } finally {
        closeSync(lockHandle)
      }
      const publishedStat = installLockStat(lockPath)
      if (
        publishedStat === undefined
        || !publishedStat.isFile()
        || publishedStat.isSymbolicLink()
        || publishedStat.dev !== ownedStat.dev
        || publishedStat.ino !== ownedStat.ino
      ) {
        throw lockOwnershipChangedError(lockPath)
      }
      return () => releaseInstallLock(lockPath, ownedRecord, ownedStat)
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
      const existingStat = await accessInstallLock(() => installLockStat(lockPath), deadline)
      if (existingStat === undefined) continue
      if (!existingStat.isFile() || existingStat.isSymbolicLink()) {
        throw manualLockRecoveryError(lockPath, 'invalid')
      }
      const existingRecord = await accessInstallLock(() => readInstallLock(lockPath), deadline)
      if (existingRecord === undefined) continue
      const verifiedStat = await accessInstallLock(() => installLockStat(lockPath), deadline)
      if (verifiedStat === undefined) continue
      if (!verifiedStat.isFile() || verifiedStat.isSymbolicLink()) {
        throw manualLockRecoveryError(lockPath, 'invalid')
      }
      if (verifiedStat.dev !== existingStat.dev || verifiedStat.ino !== existingStat.ino) continue
      const owner = parseInstallLock(existingRecord)
      if (owner === undefined) {
        if (!installLockRecordMayBeIncomplete(existingRecord)) {
          throw manualLockRecoveryError(lockPath, 'invalid')
        }
        if (observeBarrier !== undefined) {
          const barrier = observeBarrier
          observeBarrier = undefined
          await waitForLockTestBarrier(barrier)
        }
        const now = Date.now()
        if (
          initializingLock === undefined
          || initializingLock.dev !== existingStat.dev
          || initializingLock.ino !== existingStat.ino
        ) {
          initializingLock = {
            deadline: now + INSTALL_LOCK_INITIALIZATION_TIMEOUT_MS,
            dev: existingStat.dev,
            ino: existingStat.ino,
          }
        }
        if (now >= initializingLock.deadline) {
          throw manualLockRecoveryError(lockPath, 'invalid')
        }
        await new Promise(resolveWait => setTimeout(resolveWait, INSTALL_LOCK_POLL_MS))
        continue
      }
      initializingLock = undefined
      if (!lockOwnerIsAlive(owner)) throw manualLockRecoveryError(lockPath, 'stale')
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for Lefthook installer lock ${lockPath}`)
      }
      await new Promise(resolveWait => setTimeout(resolveWait, INSTALL_LOCK_POLL_MS))
    }
  }
}

function ownershipMarkerContent(hooksPath) {
  return `${JSON.stringify({
    version: OWNERSHIP_MARKER_VERSION,
    owner: OWNERSHIP_MARKER_OWNER,
    hooksPath,
  })}\n`
}

function parseOwnershipMarker(content) {
  let parsed
  try {
    parsed = JSON.parse(content)
  } catch {
    return undefined
  }
  if (
    typeof parsed !== 'object'
    || parsed === null
    || parsed.version !== OWNERSHIP_MARKER_VERSION
    || parsed.owner !== OWNERSHIP_MARKER_OWNER
    || typeof parsed.hooksPath !== 'string'
    || !isAbsolute(parsed.hooksPath)
  ) {
    return undefined
  }
  return { hooksPath: parsed.hooksPath }
}

function inspectOwnedHooksDirectory(hooksPath) {
  const markerPath = join(hooksPath, OWNERSHIP_MARKER)
  if (!existsSync(hooksPath)) return undefined
  const hooksStat = lstatSync(hooksPath)
  if (!hooksStat.isDirectory() || hooksStat.isSymbolicLink()) {
    throw new Error(`refusing to use non-directory or symlinked hooks path ${hooksPath}`)
  }
  if (!existsSync(markerPath)) {
    throw new Error(`refusing to overwrite unowned hooks directory ${hooksPath}`)
  }
  const markerStat = lstatSync(markerPath)
  const marker = markerStat.isFile() && !markerStat.isSymbolicLink() && markerStat.nlink === 1
    ? parseOwnershipMarker(readFileSync(markerPath, 'utf8'))
    : undefined
  if (marker === undefined) {
    throw new Error(`refusing to overwrite hooks directory with an invalid ownership marker: ${hooksPath}`)
  }
  for (const name of readdirSync(hooksPath)) {
    if (name === OWNERSHIP_MARKER) continue
    const entryPath = join(hooksPath, name)
    const entryStat = lstatSync(entryPath)
    if (!entryStat.isFile() || entryStat.isSymbolicLink() || entryStat.nlink !== 1) {
      throw new Error(
        `refusing to overwrite non-regular or multiply linked hook entry ${JSON.stringify(entryPath)}`,
      )
    }
  }
  return { markerPath, ...marker }
}

function isRegisteredOwnedHooksPath(commonDirectory, hooksPath) {
  const normalizedHooksPath = normalizedPath(hooksPath)
  const isRegistered = registeredWorktreeConfigPaths(commonDirectory).some(
    configPath => normalizedPath(join(dirname(configPath), HOOKS_DIRECTORY)) === normalizedHooksPath,
  )
  if (!isRegistered) return false
  return inspectOwnedHooksDirectory(hooksPath)?.hooksPath === hooksPath
}

function ensureOwnedHooksDirectory(hooksPath) {
  const inspected = inspectOwnedHooksDirectory(hooksPath)
  if (inspected !== undefined) return inspected
  mkdirSync(hooksPath, { mode: 0o700 })
  const markerPath = join(hooksPath, OWNERSHIP_MARKER)
  writeFileSync(markerPath, ownershipMarkerContent(hooksPath), { flag: 'wx', mode: 0o600 })
  return { markerPath, hooksPath }
}

function updateOwnershipMarker(markerPath, hooksPath) {
  writeFileSync(markerPath, ownershipMarkerContent(hooksPath), { mode: 0o600 })
}

function environmentWithoutCommandGitConfig() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase()
    if (
      normalized === 'GIT_CONFIG_PARAMETERS'
      || normalized === 'GIT_CONFIG_COUNT'
      || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(normalized)
    ) {
      delete env[key]
    }
  }
  return env
}

function runLefthook(root, lefthook) {
  const args = ['install', '--force']
  const env = environmentWithoutCommandGitConfig()
  // Node refuses to spawn Windows `.cmd` shims directly; the quoted path is
  // re-parsed by cmd.exe, while POSIX can execute its extensionless shim.
  const result = process.platform === 'win32'
    ? spawnSync(`"${lefthook}"`, args, { cwd: root, env, stdio: 'inherit', shell: true })
    : spawnSync(lefthook, args, { cwd: root, env, stdio: 'inherit' })
  if (result.status !== 0) throw commandFailure(lefthook, args, result)
}

function configSource(entry) {
  return `${entry.origin}: ${JSON.stringify(entry.value)}`
}

function normalizedPath(path) {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function configOriginPath(origin, root) {
  if (!origin.startsWith('file:')) return undefined
  const originPath = origin.slice('file:'.length)
  return isAbsolute(originPath) ? originPath : resolve(root, originPath)
}

function originIsFile(origin, root, configPath) {
  const originPath = configOriginPath(origin, root)
  return originPath !== undefined && normalizedPath(originPath) === normalizedPath(configPath)
}

function refuseInheritedHooksPath(entry) {
  throw new Error(
    `refusing to replace user-owned core.hooksPath (${configSource(entry)}). `
    + `Chain those hooks through lefthook.yml, or, if this inherited path may remain active only in other worktrees, `
    + `rerun with ${ALLOW_HOOKS_PATH_OVERRIDE}=1`,
  )
}

function refuseScopedHooksPath(entry) {
  if (entry.scope === 'command') {
    throw new Error(
      `refusing to replace command-scoped core.hooksPath (${configSource(entry)}); `
      + `${ALLOW_HOOKS_PATH_OVERRIDE} cannot override transient command configuration`,
    )
  }
  if (entry.scope === 'worktree') {
    throw new Error(
      `refusing to replace worktree-scoped core.hooksPath (${configSource(entry)}); `
      + 'a worktree-specific custom path must be integrated or removed explicitly',
    )
  }
  throw new Error(
    `refusing to replace core.hooksPath from unsupported ${entry.scope} scope (${configSource(entry)})`,
  )
}

async function main() {
  if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') return
  if (typeof lefthookPackage.bin?.lefthook !== 'string') return
  const probe = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  if (probe.status !== 0) return
  const root = stripGitLineTerminator(probe.stdout)
  const isWindows = process.platform === 'win32'
  const lefthook = join(root, 'node_modules', '.bin', isWindows ? 'lefthook.cmd' : 'lefthook')
  if (!existsSync(lefthook)) return

  assertSupportedGit(root)
  const gitDirectory = stripGitLineTerminator(git(['rev-parse', '--absolute-git-dir'], root).stdout)
  const commonOutput = stripGitLineTerminator(git(['rev-parse', '--git-common-dir'], root).stdout)
  const commonDirectory = isAbsolute(commonOutput) ? commonOutput : resolve(root, commonOutput)
  const commonConfigPath = join(commonDirectory, 'config')
  const worktreeConfigPath = join(gitDirectory, 'config.worktree')
  const hooksPath = join(gitDirectory, HOOKS_DIRECTORY)
  const releaseLock = await acquireInstallLock(commonDirectory)
  let installationError

  try {
    assertCommonConfigFile(commonConfigPath)
    assertWorktreeConfigFiles(
      root,
      commonDirectory,
      commonConfigPath,
      worktreeConfigPath,
    )
    const worktreeEntries = includedFileConfigEntries(root, worktreeConfigPath, 'core.hooksPath')
    const includedWorktreeEntry = worktreeEntries.find(
      entry => !originIsFile(entry.origin, root, worktreeConfigPath),
    )
    if (includedWorktreeEntry !== undefined) {
      refuseScopedHooksPath({ ...includedWorktreeEntry, scope: 'worktree' })
    }
    const worktreePath = assertSingle(
      worktreeEntries.map(entry => entry.value),
      'worktree core.hooksPath',
    )
    let ownedHooksDirectory
    let copiedWorktreePathIsOwned = false
    if (worktreePath !== undefined && worktreePath !== hooksPath) {
      ownedHooksDirectory = inspectOwnedHooksDirectory(hooksPath)
      const worktreePathIsRelocated = ownedHooksDirectory?.hooksPath === worktreePath
      copiedWorktreePathIsOwned = !worktreePathIsRelocated
        && isRegisteredOwnedHooksPath(commonDirectory, worktreePath)
      if (!worktreePathIsRelocated && !copiedWorktreePathIsOwned) {
        refuseScopedHooksPath({ origin: `file:${worktreeConfigPath}`, scope: 'worktree', value: worktreePath })
      }
    }
    const directWorktreePathIsOwned = worktreePath !== undefined
      && (
        worktreePath === hooksPath
        || ownedHooksDirectory?.hooksPath === worktreePath
        || copiedWorktreePathIsOwned
      )
    const effectiveEntry = effectiveConfigEntry(root, 'core.hooksPath')
    if (effectiveEntry !== undefined) {
      const effectivePathIsOwned = effectiveEntry.scope === 'worktree'
        && effectiveEntry.value === worktreePath
        && directWorktreePathIsOwned
        && originIsFile(effectiveEntry.origin, root, worktreeConfigPath)
      if (!effectivePathIsOwned) {
        if (effectiveEntry.scope === 'command' || effectiveEntry.scope === 'worktree') {
          refuseScopedHooksPath(effectiveEntry)
        }
        if (!['system', 'global', 'local'].includes(effectiveEntry.scope)) {
          refuseScopedHooksPath(effectiveEntry)
        }
        if (process.env[ALLOW_HOOKS_PATH_OVERRIDE] !== '1') {
          refuseInheritedHooksPath(effectiveEntry)
        }
      }
    }
    const migration = planWorktreeConfigMigration(root, commonConfigPath)
    ownedHooksDirectory = ensureOwnedHooksDirectory(hooksPath)
    if (
      worktreePath !== undefined
      && worktreePath !== hooksPath
      && ownedHooksDirectory.hooksPath !== worktreePath
      && !copiedWorktreePathIsOwned
    ) {
      throw new Error(`hooks directory ownership changed while relocating ${JSON.stringify(worktreePath)}`)
    }
    applyWorktreeConfigMigration(root, commonConfigPath, migration)

    let pathChanged = false
    try {
      git(['config', '--worktree', 'core.hooksPath', hooksPath], root)
      pathChanged = worktreePath !== hooksPath
      const installedEntry = effectiveConfigEntry(root, 'core.hooksPath')
      if (
        installedEntry === undefined
        || installedEntry.scope !== 'worktree'
        || installedEntry.value !== hooksPath
        || !originIsFile(installedEntry.origin, root, worktreeConfigPath)
      ) {
        throw new Error('new worktree-local core.hooksPath did not become the effective direct worktree value')
      }
      runLefthook(root, lefthook)
      updateOwnershipMarker(ownedHooksDirectory.markerPath, hooksPath)
    } catch (error) {
      const rollbackErrors = []
      if (pathChanged) {
        try {
          if (worktreePath === undefined) {
            git(['config', '--worktree', '--unset-all', 'core.hooksPath'], root)
          } else {
            git(['config', '--worktree', 'core.hooksPath', worktreePath], root)
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          `Lefthook installation failed: ${String(error)}; `
          + `worktree integration rollback also failed: ${rollbackErrors.map(String).join('; ')}`,
        )
      }
      throw error
    }
  } catch (error) {
    installationError = error
    throw error
  } finally {
    try {
      releaseLock()
    } catch (releaseError) {
      if (installationError !== undefined) {
        throw new AggregateError(
          [installationError, releaseError],
          `Lefthook installation failed: ${String(installationError)}; installer lock release also failed: ${String(releaseError)}`,
        )
      }
      throw releaseError
    }
  }
}

try {
  await main()
} catch (error) {
  console.error(`[install-lefthook] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
