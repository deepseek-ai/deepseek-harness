/** Closed private transports shared by the native subprocess runner. */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'

/** Target state restored by the Linux bootstrap after systemd establishes the scope. */
export interface LinuxLaunchRequest {
  cwd: string
  env: Record<string, string>
}

/** Bounded Node-shaped error fields allowed across a private runner boundary. */
export interface SerializedRunnerError {
  name: string
  message: string
  code?: string
  syscall?: string
  path?: string
}

/** A Linux pre-exec failure published beside its consumed request. */
export type LinuxStartupError =
  { type: 'error'; error: SerializedRunnerError }

/** The only parent-to-runner start message on Windows. */
export interface WindowsStartRequest {
  type: 'start'
  cwd: string
  env: Record<string, string>
}

/** The only parent-to-runner control message on Windows. */
export interface WindowsTerminateRequest {
  type: 'terminate'
}

/** Exactly one direct-result branch is sent by a connected Windows runner. */
export type WindowsRunnerResult =
  | { type: 'target-exit'; exitCode: number }
  | { type: 'error'; error: SerializedRunnerError }

/** Private paths owned by one Linux ordinary or PTY spawn. */
export interface LinuxLaunchFiles {
  directory: string
  requestPath: string
  startupErrorPath: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => allowed.has(key))
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(entry => typeof entry === 'string')
}

function isSerializedRunnerError(value: unknown): value is SerializedRunnerError {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ['name', 'message'],
    ['code', 'syscall', 'path'],
  )) return false
  return typeof value.name === 'string'
    && typeof value.message === 'string'
    && (value.code === undefined || typeof value.code === 'string')
    && (value.syscall === undefined || typeof value.syscall === 'string')
    && (value.path === undefined || typeof value.path === 'string')
}

function parseErrorResult(value: Record<string, unknown>): LinuxStartupError {
  if (!hasExactKeys(value, ['type', 'error']) || !isSerializedRunnerError(value.error)) {
    throw new Error('subprocess runner emitted an invalid error result')
  }
  if (value.type !== 'error') {
    throw new Error('subprocess runner emitted an unknown error result')
  }
  return { type: 'error', error: value.error }
}

/**
 * Create a private 0700 directory and one complete 0600 launch request.
 * @param request - target cwd and complete environment for the bootstrap.
 * @returns private paths owned by this launch.
 */
export function createLinuxLaunchFiles(request: LinuxLaunchRequest): LinuxLaunchFiles {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-subprocess-launch-'))
  const files = {
    directory,
    requestPath: join(directory, 'launch-request.json'),
    startupErrorPath: join(directory, 'startup-error.json'),
  }
  try {
    chmodSync(directory, 0o700)
    writeFileSync(files.requestPath, JSON.stringify(request), { flag: 'wx', mode: 0o600 })
    return files
  } catch (error) {
    cleanupLinuxLaunchFiles(files)
    throw error
  }
}

/**
 * Derive the only permitted startup-error path from an absolute request locator.
 * @param requestPath - absolute path to the private launch-request file.
 * @returns validated sibling paths for this launch.
 */
export function linuxLaunchFilesFromLocator(requestPath: string): LinuxLaunchFiles {
  if (!isAbsolute(requestPath) || basename(requestPath) !== 'launch-request.json') {
    throw new Error('subprocess runner received an invalid Linux launch-request locator')
  }
  const directory = dirname(requestPath)
  return { directory, requestPath, startupErrorPath: join(directory, 'startup-error.json') }
}

/**
 * Strictly read and remove a one-shot Linux launch request.
 * @param requestPath - private launch-request path to consume.
 * @returns validated target cwd and environment.
 */
export function consumeLinuxLaunchRequest(requestPath: string): LinuxLaunchRequest {
  const text = readFileSync(requestPath, 'utf8')
  unlinkSync(requestPath)
  const value: unknown = JSON.parse(text)
  if (!isRecord(value) || !hasExactKeys(value, ['cwd', 'env'])
    || typeof value.cwd !== 'string' || !isStringRecord(value.env)) {
    throw new Error('subprocess runner received an invalid Linux launch request')
  }
  return { cwd: value.cwd, env: value.env }
}

/**
 * Publish one strict 0600 Linux pre-exec error.
 * @param files - private paths for this launch.
 * @param error - bounded spawn or runner failure to publish.
 */
export function writeLinuxStartupError(files: LinuxLaunchFiles, error: LinuxStartupError): void {
  writeFileSync(files.startupErrorPath, JSON.stringify(error), { flag: 'wx', mode: 0o600 })
}

/**
 * Read the Linux pre-exec error, if the bootstrap published one.
 * @param path - expected startup-error path.
 * @returns the validated failure, or undefined when none was published.
 */
export function readLinuxStartupError(path: string): LinuxStartupError | undefined {
  if (!existsSync(path)) return undefined
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(value)) throw new Error('subprocess runner emitted an invalid startup error')
  return parseErrorResult(value)
}

/**
 * Strictly parse the single Windows start message.
 * @param value - untrusted IPC payload.
 * @returns validated target start request.
 */
export function parseWindowsStartRequest(value: unknown): WindowsStartRequest {
  if (!isRecord(value) || !hasExactKeys(value, ['type', 'cwd', 'env'])
    || value.type !== 'start' || typeof value.cwd !== 'string' || !isStringRecord(value.env)) {
    throw new Error('subprocess runner received an invalid Windows start request')
  }
  return { type: 'start', cwd: value.cwd, env: value.env }
}

/**
 * Return true only for the exact, payload-free Windows terminate control.
 * @param value - untrusted IPC payload.
 * @returns whether the payload is the exact terminate request.
 */
export function isWindowsTerminateRequest(value: unknown): value is WindowsTerminateRequest {
  return isRecord(value) && hasExactKeys(value, ['type']) && value.type === 'terminate'
}

/**
 * Strictly parse one of the two Windows direct-result branches.
 * @param value - untrusted IPC payload.
 * @returns validated direct-result message.
 */
export function parseWindowsRunnerResult(value: unknown): WindowsRunnerResult {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('subprocess runner emitted an invalid Windows result')
  }
  if (value.type === 'error') return parseErrorResult(value)
  if (value.type === 'target-exit') {
    const validExitCode = typeof value.exitCode === 'number'
      && Number.isSafeInteger(value.exitCode)
      && value.exitCode >= 0
    if (!hasExactKeys(value, ['type', 'exitCode']) || !validExitCode) {
      throw new Error('subprocess runner emitted an invalid target-exit result')
    }
    return {
      type: 'target-exit',
      exitCode: value.exitCode as number,
    }
  }
  throw new Error(`subprocess runner emitted an unknown Windows result: ${value.type}`)
}

/**
 * Convert an unknown failure into the bounded cross-process error record.
 * @param error - failure caught at the process boundary.
 * @returns bounded serializable error fields.
 */
export function serializeRunnerError(error: unknown): SerializedRunnerError {
  const source = error instanceof Error ? error : new Error(String(error))
  const node = source as NodeJS.ErrnoException & { path?: string }
  return {
    name: source.name,
    message: source.message,
    ...typeof node.code === 'string' ? { code: node.code } : {},
    ...typeof node.syscall === 'string' ? { syscall: node.syscall } : {},
    ...typeof node.path === 'string' ? { path: node.path } : {},
  }
}

/**
 * Rebuild a Node-shaped Error from a strict runner record.
 * @param serialized - validated bounded error fields.
 * @returns reconstructed Error with supported Node fields.
 */
export function deserializeRunnerError(serialized: SerializedRunnerError): Error {
  const error = new Error(serialized.message)
  error.name = serialized.name
  return Object.assign(error, {
    ...serialized.code === undefined ? {} : { code: serialized.code },
    ...serialized.syscall === undefined ? {} : { syscall: serialized.syscall },
    ...serialized.path === undefined ? {} : { path: serialized.path },
  })
}

/**
 * Best-effort removal of only the private paths created for this Linux spawn.
 * @param files - exact private paths owned by this launch.
 */
export function cleanupLinuxLaunchFiles(files: LinuxLaunchFiles): void {
  try {
    if (lstatSync(files.directory).isSymbolicLink()) {
      unlinkSync(files.directory)
      return
    }
    for (const path of [
      files.requestPath,
      files.startupErrorPath,
    ]) {
      try { unlinkSync(path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    rmdirSync(files.directory)
  } catch {
    // Crash residue remains private and no later spawn reuses this directory.
  }
}
