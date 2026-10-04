/** Reversible command-link ownership; operations never follow or overwrite a changed command entry. */

import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, link, lstat, mkdir, readFile, readlink, rename, stat, symlink, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** Fixed installation locations supplied by the Desktop shell. */
export interface FileCommandInstallation {
  readonly destination: string
  readonly launcher: string
  readonly linkHelper: string
}

type Entry = { readonly kind: 'symlink'; readonly fingerprint: string; readonly target: string }
  | { readonly kind: 'missing' | 'file' | 'unsupported'; readonly fingerprint: string }

interface Backup {
  readonly name: string
  readonly fingerprint: string
}

interface Receipt {
  readonly schemaVersion: 1
  readonly launcher: string
  readonly installedFingerprint: string
  readonly backup?: Backup
}

/** State displayed before a command-management operation. */
export interface CommandInspection {
  readonly fingerprint: string
  readonly destination: string
  readonly launcher: string
  readonly kind: Entry['kind']
  readonly managed: boolean
  readonly available: boolean
  readonly target?: string
  readonly backup?: string
  readonly preservedBackup?: string
}

/** A declined stale operation or a command entry outside this installer's ownership. */
export class CommandInstallationError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function receiptPath(options: FileCommandInstallation): string {
  return join(dirname(options.destination), '.dsh-desktop-command.json')
}

async function readEntry(path: string): Promise<Entry> {
  let info
  try { info = await lstat(path, { bigint: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing', fingerprint: digest('missing') }
    throw error
  }
  const fields = [info.dev, info.ino, info.mode, info.uid, info.gid, info.size, info.mtimeNs].map(String)
  if (info.isSymbolicLink()) {
    const target = await readlink(path)
    return { kind: 'symlink', fingerprint: digest({ kind: 'symlink', fields, target }), target }
  }
  const kind = info.isFile() ? 'file' : 'unsupported'
  return { kind, fingerprint: digest({ kind, fields }) }
}

async function readReceipt(options: FileCommandInstallation): Promise<Receipt | undefined> {
  const path = receiptPath(options)
  let info
  try { info = await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!info.isFile() || info.size > 8192) throw new CommandInstallationError('EOWNERSHIP', 'Invalid command ownership record.')
  let value: unknown
  try { value = JSON.parse(await readFile(path, 'utf8')) } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new CommandInstallationError('EOWNERSHIP', 'Invalid command ownership record.')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CommandInstallationError('EOWNERSHIP', 'Invalid command ownership record.')
  }
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1 || typeof record.launcher !== 'string' || !isAbsolute(record.launcher)
    || typeof record.installedFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(record.installedFingerprint)) {
    throw new CommandInstallationError('EOWNERSHIP', 'Invalid command ownership record.')
  }
  let backup: Backup | undefined
  if (record.backup !== undefined) {
    if (typeof record.backup !== 'object' || record.backup === null) throw new CommandInstallationError('EOWNERSHIP', 'Invalid command backup record.')
    const candidate = record.backup as Record<string, unknown>
    if (typeof candidate.name !== 'string' || !/^\.dsh-command-backup-[a-f0-9-]{36}$/u.test(candidate.name)
      || typeof candidate.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(candidate.fingerprint)) {
      throw new CommandInstallationError('EOWNERSHIP', 'Invalid command backup record.')
    }
    backup = { name: candidate.name, fingerprint: candidate.fingerprint }
  }
  return { schemaVersion: 1, launcher: record.launcher, installedFingerprint: record.installedFingerprint,
    ...backup === undefined ? {} : { backup } }
}

async function available(path: string): Promise<boolean> {
  try { await access(path, constants.X_OK); return (await stat(path)).isFile() } catch (error) {
    if (['ENOENT', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
    throw error
  }
}

async function readSnapshot(options: FileCommandInstallation) {
  const entry = await readEntry(options.destination)
  const receipt = await readReceipt(options)
  const state: CommandInspection = {
    fingerprint: digest({ entry: entry.fingerprint, receipt }),
    destination: options.destination, launcher: options.launcher, kind: entry.kind,
    managed: receipt !== undefined && entry.kind === 'symlink' && entry.target === receipt.launcher && entry.fingerprint === receipt.installedFingerprint,
    available: await available(options.destination),
    ...entry.kind === 'symlink' ? { target: entry.target } : {},
    ...receipt?.backup === undefined ? {} : { backup: join(dirname(options.destination), receipt.backup.name) },
  }
  return { entry, receipt, state }
}

/**
 * Read the command and receipt without changing either.
 * @param options - Fixed command destination and current installed launcher.
 * @returns A fingerprint to bind a later user decision to the observed entries.
 */
export async function inspectFileCommand(options: FileCommandInstallation): Promise<CommandInspection> {
  return (await readSnapshot(options)).state
}

async function restoreEntry(options: FileCommandInstallation, source: string, destination: string, expected?: string): Promise<void> {
  const entry = await readEntry(source)
  if (expected !== undefined && entry.fingerprint !== expected) throw new CommandInstallationError('EOWNERSHIP', 'Command backup changed.')
  if (entry.kind !== 'symlink' && entry.kind !== 'file') throw new CommandInstallationError('EOWNERSHIP', 'Command backup is unavailable.')
  if (expected !== undefined) {
    const claimed = await withdraw(options, source, entry)
    if (claimed === undefined) throw new CommandInstallationError('EOWNERSHIP', 'Command backup is unavailable.')
    try { await restoreEntry(options, claimed, destination) } catch (error) {
      try { await restoreEntry(options, claimed, source) } catch (restoreError) {
        throw new AggregateError([error, restoreError], 'The command backup is preserved at ' + claimed)
      }
      throw error
    }
    return
  }
  await linkEntry(options, source, destination)
  if ((await readEntry(destination)).fingerprint !== entry.fingerprint) throw new CommandInstallationError('EOWNERSHIP', 'Command backup changed during restoration.')
  await unlink(source)
}

async function linkEntry(options: FileCommandInstallation, source: string, destination: string): Promise<void> {
  // macOS Node link() follows symlinks; linkat preserves their identity and refuses occupied destinations.
  if (process.platform === 'darwin') await promisify(execFile)(options.linkHelper, [source, destination])
  else await link(source, destination)
}

async function withdraw(options: FileCommandInstallation, destination: string, expected: Entry): Promise<string | undefined> {
  if (expected.kind === 'missing') return undefined
  if (expected.kind === 'unsupported') throw new CommandInstallationError('EUNSUPPORTED', 'The command path is not a file or symbolic link.')
  const path = join(dirname(destination), '.dsh-command-backup-' + randomUUID())
  await rename(destination, path)
  if ((await readEntry(path)).fingerprint !== expected.fingerprint) {
    try { await restoreEntry(options, path, destination) } catch (error) {
      throw new AggregateError([error], 'The command changed; its entry is preserved at ' + path)
    }
    throw new CommandInstallationError('ESTALE', 'The command changed after confirmation.')
  }
  return path
}

/**
 * Install or repair a link, keeping the previous launcher available for removal.
 * @param options - Fixed command destination and current installed launcher.
 * @param expected - Fingerprint displayed in the user's confirmation.
 * @returns Updated state and any older backup preserved after an external command replacement.
 */
export async function installFileCommand(options: FileCommandInstallation, expected: string): Promise<CommandInspection> {
  await mkdir(dirname(options.destination), { recursive: true })
  return withFileLock(receiptPath(options), async () => {
    const { state, entry, receipt } = await readSnapshot(options)
    if (state.fingerprint !== expected) throw new CommandInstallationError('ESTALE', 'The command changed after confirmation.')
    if (!await available(options.launcher)) throw new CommandInstallationError('ENOENT', 'The installed launcher is unavailable.')
    const moved = await withdraw(options, options.destination, entry)
    const pending = join(dirname(options.destination), '.dsh-command-new-' + randomUUID())
    let created: Entry | undefined
    try {
      await symlink(options.launcher, pending)
      created = await readEntry(pending)
      await linkEntry(options, pending, options.destination)
      const backup = state.managed || moved === undefined ? receipt?.backup
        : { name: basename(moved), fingerprint: entry.fingerprint }
      const next: Receipt = { schemaVersion: 1, launcher: options.launcher, installedFingerprint: created.fingerprint,
        ...backup === undefined ? {} : { backup } }
      await writeFileAtomic(receiptPath(options), JSON.stringify(next) + '\n', { mode: 0o644 })
    } catch (error) {
      if (created !== undefined && (await readEntry(options.destination)).fingerprint === created.fingerprint) {
        const rollback = await withdraw(options, options.destination, created)
        if (rollback !== undefined) await unlink(rollback)
      }
      if (moved !== undefined) {
        try { await restoreEntry(options, moved, options.destination, entry.fingerprint) } catch (restoreError) {
          throw new AggregateError([error, restoreError], 'The previous command is preserved at ' + moved)
        }
      }
      throw error
    } finally {
      try { await unlink(pending) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (state.managed && moved !== undefined) await unlink(moved)
    const result = await inspectFileCommand(options)
    const previousBackup = receipt?.backup === undefined ? undefined : join(dirname(options.destination), receipt.backup.name)
    return previousBackup !== undefined && !state.managed && moved !== undefined && (await readEntry(previousBackup)).kind !== 'missing'
      ? { ...result, preservedBackup: previousBackup } : result
  }, { waitMs: 5000 })
}

/**
 * Remove only a recorded Desktop link and restore its unchanged previous entry.
 * @param options - Fixed command destination and current installed launcher.
 * @param expected - Fingerprint displayed when removal was requested.
 * @returns State after removal; an externally replaced command remains untouched.
 */
export async function removeFileCommand(options: FileCommandInstallation, expected: string): Promise<CommandInspection> {
  return withFileLock(receiptPath(options), async () => {
    const { state, entry, receipt } = await readSnapshot(options)
    if (state.fingerprint !== expected) throw new CommandInstallationError('ESTALE', 'The command changed after confirmation.')
    if (receipt === undefined) return state
    const backup = receipt.backup === undefined ? undefined : join(dirname(options.destination), receipt.backup.name)
    if (state.managed && backup !== undefined && receipt.backup !== undefined
      && (await readEntry(backup)).fingerprint !== receipt.backup.fingerprint) {
      throw new CommandInstallationError('EOWNERSHIP', 'The previous command backup changed or is missing.')
    }
    if (state.managed) {
      const removed = await withdraw(options, options.destination, entry)
      try {
        if (backup !== undefined) await restoreEntry(options, backup, options.destination, receipt.backup?.fingerprint)
        await unlink(receiptPath(options))
      } catch (error) {
        if (removed !== undefined) {
          try {
            if ((await readEntry(options.destination)).kind === 'missing') await restoreEntry(options, removed, options.destination, entry.fingerprint)
            else await unlink(removed)
          } catch (restoreError) {
            throw new AggregateError([error, restoreError], 'The Desktop command link is preserved at ' + removed)
          }
        }
        throw error
      }
      if (removed !== undefined) await unlink(removed)
    } else {
      // Another installer owns the current entry. Keep it and the old backup.
      await unlink(receiptPath(options))
    }
    const result = await inspectFileCommand(options)
    return !state.managed && backup !== undefined && (await readEntry(backup)).kind !== 'missing'
      ? { ...result, preservedBackup: backup } : result
  }, { waitMs: 5000 })
}
