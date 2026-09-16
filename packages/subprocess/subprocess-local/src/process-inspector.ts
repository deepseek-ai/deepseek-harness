/** Platform process-table inspection for terminal readiness, signals, and teardown. */

import { closeSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import type { SubprocessTerminalSignal } from '@deepseek-ai/dsh-subprocess'
import { createWindowsProcessInspector } from './windows-inspector.ts'

/** PID plus start identity, preventing teardown escalation after PID reuse. */
export interface ProcessIdentity {
  pid: number
  started: string
}

interface FileStatus {
  readonly rdev: number
  isCharacterDevice(): boolean
}

/**
 * One observation of the platform process table, shared by every question a
 * single readiness poll or teardown pass asks.
 *
 * The table is read at most once, on the first question that needs it — a
 * `/bin/ps` fork on macOS, a `/proc` walk on Linux, a Toolhelp32 enumeration on
 * Windows. Later questions never re-read it, which is what keeps a poll's cost
 * independent of how many descendants the running command spawned. Windows
 * liveness needs no table at all: wait state is a per-handle question there, so
 * a snapshot asked only for liveness never enumerates.
 *
 * A snapshot answers what the process table showed, which is what batch
 * filtering wants and what signalling must not use: {@link ProcessInspector.isAlive}
 * is the fence a signal takes, because it reads current state instead.
 */
export interface ProcessSnapshot {
  /** Whether the process-table scan omitted no unreadable rows; absent means unverified. */
  readonly complete?: boolean
  /**
   * Return the root and its transitive descendants as observed, children first.
   * @param rootPid - tree root to descend from.
   * @returns Observed root and descendants, children before parents.
   */
  tree(rootPid: number): ProcessIdentity[]
  /**
   * Return observed members of one POSIX process session.
   * @param sessionId - POSIX session identifier.
   * @returns Observed session members, empty where the platform's table omits session ids.
   */
  session(sessionId: number): ProcessIdentity[]
  /**
   * Return whether the exact identity was a non-quiescent process.
   * @param identity - PID plus start identity to match.
   * @returns Whether that exact identity — not merely that PID — was running.
   */
  alive(identity: ProcessIdentity): boolean
}

/** Injectable OS process operations used by one local PTY session. */
export interface ProcessInspector {
  foregroundPgid(shellPid: number): number | undefined
  /**
   * Report whether the foreground group waits on the terminal shell's stdin.
   *
   * @param pgid Foreground process-group identifier.
   * @param shellPid Persistent terminal shell process identifier.
   * @returns Whether a group member is blocked reading the shell's terminal input.
   */
  isStdinWaiting(pgid: number, shellPid: number): boolean
  /**
   * Read the process table once and answer tree, session, and liveness from it.
   * @returns A process-table observation whose reads are shared.
   * @throws when the platform process table cannot be enumerated.
   */
  snapshot(): ProcessSnapshot
  /**
   * Return whether the exact identity is a non-quiescent process right now.
   *
   * Reads the narrowest per-identity source the platform offers rather than a
   * whole table, so a signalling round can re-check every target without
   * paying for a scan. Callers filtering many members at once want
   * {@link ProcessSnapshot.alive} instead.
   *
   * @param identity - PID plus start identity to match.
   * @returns Whether that exact identity — not merely that PID — is running.
   */
  isAlive(identity: ProcessIdentity): boolean
  signalGroup(pgid: number, signal: SubprocessTerminalSignal): void
  /**
   * Signal one exact process identity, fenced against PID reuse.
   *
   * The fence reads current state immediately before the signal. An observation
   * taken earlier in the same round cannot stand in for it: the observation
   * preserves the original PID-to-start-time pairing, so a recycled PID would
   * still match and take a signal meant for the process that exited.
   *
   * @param identity - PID plus start identity to signal.
   * @param signal - termination signal to deliver.
   */
  signalProcess(identity: ProcessIdentity, signal: 'SIGTERM' | 'SIGKILL'): void
}

/** Testable boundary around filesystem, process-table, and signal syscalls. */
export interface ProcessInspectorInternals {
  readFile(path: string): string
  readDir(path: string): string[]
  readLink(path: string): string
  stat(path: string): FileStatus
  open(path: string): number
  read(fd: number, buffer: Buffer, length: number, position: number): number
  close(fd: number): void
  exec(file: string, args: string[]): string
  kill(pid: number, signal: NodeJS.Signals): void
}

/* v8 ignore start -- thin OS bindings; injected logic is unit-tested and real platform composition exercises them. */
const DEFAULT_INTERNALS: ProcessInspectorInternals = {
  readFile: path => readFileSync(path, 'utf8'),
  readDir: path => readdirSync(path),
  readLink: path => readlinkSync(path, 'utf8'),
  stat: path => statSync(path),
  open: path => openSync(path, 'r'),
  read: (fd, buffer, length, position) => readSync(fd, buffer, 0, length, position),
  close: closeSync,
  exec: (file, args) => execFileSync(file, args, { encoding: 'utf8' }),
  kill: (pid, signal) => process.kill(pid, signal),
}
/* v8 ignore stop */

interface ProcStat {
  pid: number
  parentPid: number
  pgrp: number
  session: number
  state: string
  ttyDevice: number
  tpgid: number
  started: string
}

/**
 * Parse fields used from Linux `/proc/<pid>/stat`, including parenthesized comm text.
 * @param text - complete stat line.
 * @returns Parsed identity/group fields, or undefined for malformed input.
 */
export function parseProcStat(text: string): ProcStat | undefined {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open <= 0 || close <= open) return undefined
  const pid = Number(text.slice(0, open).trim())
  const rest = text.slice(close + 2).trim().split(/\s+/)
  const state = rest[0] || ''
  const parentPid = Number(rest[1])
  const pgrp = Number(rest[2])
  const session = Number(rest[3])
  const ttyDevice = Number(rest[4])
  const tpgid = Number(rest[5])
  const started = rest[19]
  if (![pid, parentPid, pgrp, session, ttyDevice, tpgid].every(Number.isSafeInteger)
    || state.length !== 1 || started === undefined) return undefined
  return { pid, parentPid, pgrp, session, state, ttyDevice, tpgid, started }
}

function readLinuxStat(internals: ProcessInspectorInternals, pid: number): ProcStat | undefined {
  try {
    return parseProcStat(internals.readFile(`/proc/${pid}/stat`))
  } catch (_unreadableProcEntry) {
    return undefined
  }
}

// `/proc/<pid>/stat` renders tty_nr as a signed 32-bit device number, while
// Node exposes the same st_rdev bits as a nonnegative number.
function linuxDeviceNumber(value: number): number {
  return value >>> 0
}

// `/dev/tty` reports the alias device instead of the selected PTY through stat,
// so its owning process's tty_nr is the only comparable terminal identity.
function readLinuxTerminalDevice(
  internals: ProcessInspectorInternals,
  pid: number,
  ttyDevice: number,
  tid?: number,
): number | undefined {
  const terminalDevice = linuxDeviceNumber(ttyDevice)
  if (terminalDevice === 0) return undefined
  const path = tid === undefined ? `/proc/${pid}/fd/0` : `/proc/${pid}/task/${tid}/fd/0`
  try {
    const target = internals.readLink(path)
    if (target === '/dev/tty') return terminalDevice
    const status = internals.stat(path)
    return status.isCharacterDevice() && linuxDeviceNumber(status.rdev) === terminalDevice
      ? terminalDevice
      : undefined
  } catch (_unreadableStdinDevice) {
    return undefined
  }
}

/**
 * Report whether a Linux process group has an executing member. `false`
 * means the group contains only zombie/dead entries; `undefined` means the
 * process table could not prove either outcome.
 * @param processGroupId - POSIX process-group id to inspect.
 * @param internals - injectable process-table operations.
 * @returns Live-member presence, or `undefined` when unavailable/absent.
 */
export function linuxProcessGroupHasLiveMembers(
  processGroupId: number,
  internals: ProcessInspectorInternals = DEFAULT_INTERNALS,
): boolean | undefined {
  let entries: string[]
  try {
    entries = internals.readDir('/proc')
  } catch (_unreadableProcDirectory) {
    return undefined
  }
  let matched = false
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const stat = readLinuxStat(internals, Number(entry))
    if (stat?.pgrp !== processGroupId) continue
    matched = true
    if (!/^[ZXx]$/.test(stat.state)) return true
  }
  return matched ? false : undefined
}

function numericEntries(internals: ProcessInspectorInternals, path: string): number[] | undefined {
  try {
    return internals.readDir(path).filter(entry => /^\d+$/.test(entry)).map(Number)
  } catch (_unreadableProcDirectory) {
    return undefined
  }
}

interface SyscallInfo {
  number: number
  args: number[]
}

function readSyscall(internals: ProcessInspectorInternals, pid: number, tid: number): SyscallInfo | undefined {
  try {
    const text = internals.readFile(`/proc/${pid}/task/${tid}/syscall`).trim()
    if (text === 'running' || text.startsWith('-1 ')) return undefined
    const fields = text.split(/\s+/)
    const number = Number(fields[0])
    const args = fields.slice(1, 7).map(field => Number.parseInt(field, 16))
    if (!Number.isSafeInteger(number) || args.some(value => !Number.isSafeInteger(value))) return undefined
    return { number, args }
  } catch (_unreadableSyscall) {
    return undefined
  }
}

function readMemory(
  internals: ProcessInspectorInternals,
  pid: number,
  address: number,
  length: number,
): Buffer | undefined {
  let fd: number | undefined
  try {
    fd = internals.open(`/proc/${pid}/mem`)
    const buffer = Buffer.alloc(length)
    const count = internals.read(fd, buffer, length, address)
    return buffer.subarray(0, count)
  } catch (_unreadableProcessMemory) {
    return undefined
  } finally {
    if (fd !== undefined) internals.close(fd)
  }
}

function fdSetHasStdin(internals: ProcessInspectorInternals, pid: number, address: number): boolean {
  return address !== 0 && (readMemory(internals, pid, address, 8)?.[0] ?? 0) % 2 === 1
}

function pollHasStdin(
  internals: ProcessInspectorInternals,
  pid: number,
  address: number,
  count: number,
): boolean {
  if (address === 0 || count <= 0) return false
  const memory = readMemory(internals, pid, address, Math.min(count, 1024) * 8)
  if (memory === undefined) return false
  for (let offset = 0; offset + 8 <= memory.length; offset += 8) {
    if (memory.readInt32LE(offset) === 0 && (memory.readInt16LE(offset + 4) & 0x001) !== 0) return true
  }
  return false
}

function epollHasStdin(internals: ProcessInspectorInternals, pid: number, tid: number, epfd: number): boolean {
  try {
    return internals.readFile(`/proc/${pid}/task/${tid}/fdinfo/${epfd}`)
      .split('\n')
      .some(line => /^tfd:\s+0\b/.test(line.trim()))
  } catch (_unreadableFdInfo) {
    return false
  }
}

interface SyscallTable {
  read: number
  select?: number
  pselect: number
  poll?: number
  ppoll: number
  epollWait?: number
  epollPwait: number
}

const SYSCALLS: Partial<Record<NodeJS.Architecture, SyscallTable>> = {
  x64: { read: 0, select: 23, pselect: 270, poll: 7, ppoll: 271, epollWait: 232, epollPwait: 281 },
  arm64: { read: 63, pselect: 72, ppoll: 73, epollPwait: 22 },
}

const SUPPORTED_SYSCALL_TABLES = Object.values(SYSCALLS)

// `/proc/<pid>/task/<tid>/syscall` uses the kernel ABI's numbers. User-mode
// emulation can therefore expose a supported table different from process.arch.
function linuxSyscallTables(arch: NodeJS.Architecture): readonly SyscallTable[] | undefined {
  const primary = SYSCALLS[arch]
  if (primary === undefined) return undefined
  return [primary, ...SUPPORTED_SYSCALL_TABLES.filter(table => table !== primary)]
}

function syscallWaitsOnStdin(
  internals: ProcessInspectorInternals,
  pid: number,
  tid: number,
  syscall: SyscallInfo,
  tables: readonly SyscallTable[],
): boolean {
  const [a0 = 0, a1 = 0, a2 = 0] = syscall.args
  for (const table of tables) {
    if (syscall.number === table.read) return a0 === 0
    if (syscall.number === table.select || syscall.number === table.pselect) {
      return a0 >= 1 && fdSetHasStdin(internals, pid, a1)
    }
    if (syscall.number === table.poll || syscall.number === table.ppoll) {
      return a1 >= 1 && pollHasStdin(internals, pid, a0, a1)
    }
    if (syscall.number === table.epollWait || syscall.number === table.epollPwait) {
      return a2 >= 1 && epollHasStdin(internals, pid, tid, a0)
    }
  }
  return false
}

abstract class PosixProcessInspector implements ProcessInspector {
  constructor(protected readonly internals: ProcessInspectorInternals) {}

  abstract foregroundPgid(shellPid: number): number | undefined
  abstract isStdinWaiting(pgid: number, shellPid: number): boolean
  abstract snapshot(): ProcessSnapshot
  abstract isAlive(identity: ProcessIdentity): boolean

  signalGroup(pgid: number, signal: SubprocessTerminalSignal): void {
    this.internals.kill(-pgid, signal)
  }

  signalProcess(identity: ProcessIdentity, signal: 'SIGTERM' | 'SIGKILL'): void {
    if (this.isAlive(identity)) this.internals.kill(identity.pid, signal)
  }
}

interface ProcessTreeEntry extends ProcessIdentity {
  parentPid: number
}

/** One process-table row, carrying the fields a platform's table exposes. */
interface ProcessRow extends ProcessTreeEntry {
  /** POSIX session identifier, or undefined where the table omits it. */
  session: number | undefined
  /** Single-letter process state, or undefined where the table omits it. */
  state: string | undefined
}

// Zombie and dead states answer "present in the table" but never "still
// running"; a table without a state column can only report presence.
function quiescent(state: string | undefined): boolean {
  return state !== undefined && /^[ZXx]$/.test(state)
}

class PosixProcessSnapshot implements ProcessSnapshot {
  private readonly byPid: Map<number, ProcessRow>

  constructor(private readonly rows: ProcessRow[], readonly complete: boolean) {
    this.byPid = new Map(rows.map(row => [row.pid, row]))
  }

  tree(rootPid: number): ProcessIdentity[] {
    return processTree(this.rows, rootPid)
  }

  session(sessionId: number): ProcessIdentity[] {
    return this.rows.flatMap(row =>
      row.session === sessionId ? [{ pid: row.pid, started: row.started }] : [])
  }

  alive(identity: ProcessIdentity): boolean {
    const row = this.byPid.get(identity.pid)
    return row?.started === identity.started && !quiescent(row.state)
  }
}

function processTree(entries: ProcessTreeEntry[], rootPid: number): ProcessIdentity[] {
  const byPid = new Map(entries.map(entry => [entry.pid, entry]))
  const root = byPid.get(rootPid)
  if (root === undefined) return []
  const byParent = new Map<number, ProcessTreeEntry[]>()
  for (const entry of entries) {
    const children = byParent.get(entry.parentPid) ?? []
    children.push(entry)
    byParent.set(entry.parentPid, children)
  }
  const visited = new Set<number>()
  const result: ProcessIdentity[] = []
  const visit = (entry: ProcessTreeEntry): void => {
    if (visited.has(entry.pid)) return
    visited.add(entry.pid)
    for (const child of byParent.get(entry.pid) ?? []) visit(child)
    result.push({ pid: entry.pid, started: entry.started })
  }
  visit(root)
  return result
}

class LinuxProcessInspector extends PosixProcessInspector {
  constructor(
    private readonly arch: NodeJS.Architecture,
    internals: ProcessInspectorInternals,
  ) {
    super(internals)
  }

  foregroundPgid(shellPid: number): number | undefined {
    const tpgid = readLinuxStat(this.internals, shellPid)?.tpgid
    return tpgid !== undefined && tpgid > 0 ? tpgid : undefined
  }

  isStdinWaiting(pgid: number, shellPid: number): boolean {
    const tables = linuxSyscallTables(this.arch)
    if (tables === undefined) return false
    const shell = readLinuxStat(this.internals, shellPid)
    if (shell === undefined) return false
    const terminalDevice = readLinuxTerminalDevice(this.internals, shellPid, shell.ttyDevice)
    if (terminalDevice === undefined) return false
    for (const pid of numericEntries(this.internals, '/proc') ?? []) {
      const process = readLinuxStat(this.internals, pid)
      if (process?.pgrp !== pgid) continue
      for (const tid of numericEntries(this.internals, `/proc/${pid}/task`) ?? []) {
        const syscall = readSyscall(this.internals, pid, tid)
        if (syscall !== undefined
          && syscallWaitsOnStdin(this.internals, pid, tid, syscall, tables)
          && readLinuxTerminalDevice(this.internals, pid, process.ttyDevice, tid) === terminalDevice) return true
      }
    }
    return false
  }

  isAlive(identity: ProcessIdentity): boolean {
    const stat = readLinuxStat(this.internals, identity.pid)
    return stat?.started === identity.started && !quiescent(stat.state)
  }

  snapshot(): ProcessSnapshot {
    const pids = numericEntries(this.internals, '/proc')
    if (pids === undefined) throw new Error('Cannot inspect processes: /proc directory is unreadable')
    let complete = true
    const rows = pids.flatMap((pid) => {
      const stat = readLinuxStat(this.internals, pid)
      if (stat === undefined) complete = false
      return stat === undefined ? [] : [{
        pid,
        parentPid: stat.parentPid,
        started: stat.started,
        session: stat.session,
        state: stat.state,
      }]
    })
    return new PosixProcessSnapshot(rows, complete)
  }

}

// `ps` exposes neither the session id nor a state column in this format, so a
// macOS row can answer presence and parentage but never session membership.
function macProcessTable(internals: ProcessInspectorInternals): { rows: ProcessRow[]; complete: boolean } {
  let complete = true
  const rows = internals.exec('/bin/ps', ['-axo', 'pid=,ppid=,lstart=']).split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
      if (line.trim().length > 0) complete = false
      return []
    }
    return [{
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      started: match[3],
      session: undefined,
      state: undefined,
    }]
  })
  return { rows, complete }
}

class MacProcessInspector extends PosixProcessInspector {
  foregroundPgid(shellPid: number): number | undefined {
    try {
      const value = Number(this.internals.exec('/bin/ps', ['-o', 'tpgid=', '-p', String(shellPid)]).trim())
      return Number.isSafeInteger(value) && value > 0 ? value : undefined
    } catch (_missingProcess) {
      return undefined
    }
  }

  isStdinWaiting(_pgid: number, _shellPid: number): boolean {
    return false
  }

  isAlive(identity: ProcessIdentity): boolean {
    return macProcessTable(this.internals).rows
      .some(entry => entry.pid === identity.pid && entry.started === identity.started)
  }

  snapshot(): ProcessSnapshot {
    const table = macProcessTable(this.internals)
    return new PosixProcessSnapshot(table.rows, table.complete)
  }

}

/**
 * Create the supported platform inspector or fail at plugin load.
 * @param platform - target Node platform.
 * @param arch - target CPU architecture for Linux syscall numbers.
 * @param internals - filesystem/process boundary, injectable for deterministic tests.
 * @returns Platform process inspector.
 */
export function createProcessInspector(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
  internals: ProcessInspectorInternals = DEFAULT_INTERNALS,
): ProcessInspector {
  if (platform === 'linux') return new LinuxProcessInspector(arch, internals)
  if (platform === 'darwin') return new MacProcessInspector(internals)
  if (platform === 'win32') return createWindowsProcessInspector()
  throw new Error(`subprocess-local: terminal inspection is unsupported on platform ${platform}`)
}
