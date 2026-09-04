/**
 * Windows process-table operations for terminal readiness, signalling, and
 * teardown: Toolhelp32 snapshot enumeration with GetProcessTimes creation-time
 * identity and process-handle wait-state liveness, the shell pid as a pseudo
 * process group (Windows has no POSIX groups), and taskkill tree signalling.
 * The koffi bindings load lazily so
 * non-Windows processes never touch Win32 libraries; all decision logic takes
 * an injectable internals boundary so suites can pin it on any host.
 * @module dsh-subprocess-local/windows-inspector
 */

import { spawnSync } from 'node:child_process'
import koffi from 'koffi'
import type { SubprocessTerminalSignal } from '@deepseek-ai/dsh-subprocess'
import type { ProcessIdentity, ProcessInspector, ProcessSnapshot } from './process-inspector.ts'

/** One Toolhelp32 process-table row. */
export interface ProcessEntry {
  pid: number
  parentPid: number
}

/** Creation identity plus the process object's current wait state. */
export interface WindowsProcessState {
  /** GetProcessTimes creation identity used to fence PID reuse. */
  started: string
  /** Whether a zero-time process-handle wait reports the process still running. */
  active: boolean
}

/** Injectable Windows process operations used by one local PTY session. */
export interface WindowsProcessInspectorInternals {
  /** Enumerate the current process table (pid/parent pairs). */
  snapshot(): ProcessEntry[]
  /** Return one process's creation identity and wait state, or undefined when unreadable. */
  processState(pid: number): WindowsProcessState | undefined
  /** Terminate one process tree; `force` maps to taskkill `/F`. */
  taskkill(pid: number, force: boolean): void
}

/**
 * Walk a process table from one root in children-first order, retaining only
 * members whose start identity is readable (unreadable members are detector
 * misses, exactly like an unreadable `/proc` entry on Linux).
 * @param entries - the process table snapshot.
 * @param rootPid - the tree root to descend from.
 * @param started - creation-time identity resolver for one member.
 * @returns the root and its current transitive descendants, children first.
 */
/* jscpd:ignore-start -- the Windows inspector deliberately mirrors process-inspector.ts:
   the decision logic (tree walk, identity fencing, group signalling) is the same contract over
   Win32 primitives, per the persistent-pty note 2026-08-11-pwsh-persistent-pty. */
export function windowsProcessTree(
  entries: ProcessEntry[],
  rootPid: number,
  started: (pid: number) => string | undefined,
): ProcessIdentity[] {
  const byPid = new Map(entries.map(entry => [entry.pid, entry]))
  const root = byPid.get(rootPid)
  if (root === undefined) return []
  const byParent = new Map<number, ProcessEntry[]>()
  for (const entry of entries) {
    const children = byParent.get(entry.parentPid) ?? []
    children.push(entry)
    byParent.set(entry.parentPid, children)
  }
  const visited = new Set<number>()
  const result: ProcessIdentity[] = []
  const visit = (entry: ProcessEntry): void => {
    if (visited.has(entry.pid)) return
    visited.add(entry.pid)
    for (const child of byParent.get(entry.pid) ?? []) visit(child)
    const identity = started(entry.pid)
    if (identity !== undefined) result.push({ pid: entry.pid, started: identity })
  }
  visit(root)
  return result
}

/**
 * Windows {@link ProcessInspector}. The shell pid stands in for a foreground
 * process group: it is a stable pseudo-group that lets the prompt-marker
 * readiness path compare foreground identities, while every actual signal
 * targets the console-wide tree through taskkill (SIGINT is delivered by the
 * terminal handle as a `\x03` input write and never reaches this layer).
 */
export class WindowsProcessInspector implements ProcessInspector {
  constructor(
    private readonly internals: WindowsProcessInspectorInternals = defaultWindowsProcessInternals(),
  ) {}

  foregroundPgid(shellPid: number): number {
    return shellPid
  }

  isStdinWaiting(_pgid: number, _shellPid: number): boolean {
    return false
  }

  isAlive(identity: ProcessIdentity): boolean {
    const state = this.internals.processState(identity.pid)
    return state?.active === true && state.started === identity.started
  }

  snapshot(): ProcessSnapshot {
    // Enumerated on the first question that reads the table. Liveness never
    // does — wait state is a per-handle question here — so the Windows
    // teardown poll, which asks only for liveness, pays no Toolhelp32 walk.
    let entries: ProcessEntry[] | undefined
    return {
      tree: rootPid => windowsProcessTree(
        entries ??= this.internals.snapshot(),
        rootPid,
        pid => this.internals.processState(pid)?.started,
      ),
      // Windows has no POSIX sessions; the shell pid stands in as a pseudo group.
      session: () => [],
      alive: identity => this.isAlive(identity),
    }
  }

  signalGroup(pgid: number, signal: SubprocessTerminalSignal): void {
    this.internals.taskkill(pgid, signal === 'SIGKILL')
  }

  signalProcess(identity: ProcessIdentity, signal: 'SIGTERM' | 'SIGKILL'): void {
    if (this.isAlive(identity)) this.internals.taskkill(identity.pid, signal === 'SIGKILL')
  }
}
/* jscpd:ignore-end */

/**
 * Create the Windows process inspector.
 * @param internals - injectable process operations; defaults to the koffi-backed table.
 * @returns the Windows inspector.
 */
export function createWindowsProcessInspector(
  internals: WindowsProcessInspectorInternals = defaultWindowsProcessInternals(),
): WindowsProcessInspector {
  return new WindowsProcessInspector(internals)
}

/** Terminate one Windows process tree with taskkill, contained like POSIX group signalling. */
function taskkillTree(pid: number, force: boolean): void {
  if (pid <= 0) return
  // Outcome deliberately unchecked: an already-absent tree, exit races, and a
  // missing taskkill binary are as tolerable here as ESRCH is for POSIX.
  spawnSync('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], {
    stdio: 'ignore',
    windowsHide: true,
  })
}

declare const nativePtr: unique symbol
/** Koffi 3 native pointer (a BigInt address), branded so it cannot silently enter numeric contexts. */
export type NativePtr = bigint & { readonly [nativePtr]: true }

/**
 * True for NULL and INVALID_HANDLE_VALUE returns from Win32 handle APIs.
 * @param value - a handle as koffi may hand it back (pointer, null, or 0n).
 * @returns whether the value signals an invalid handle.
 */
export function isInvalidHandle(value: NativePtr | null | undefined): boolean {
  if (value === null || value === undefined) return true
  const asBigInt = value as bigint
  return asBigInt === 0n || asBigInt === 0xFFFFFFFFFFFFFFFFn || asBigInt === -1n
}

/** The lazy koffi binding table: every Win32 call the Windows inspector uses. */
interface Win32Bindings {
  createToolhelp32Snapshot(flags: number, processId: number): NativePtr
  process32FirstW(snapshot: NativePtr, entry: NativePtr): number
  process32NextW(snapshot: NativePtr, entry: NativePtr): number
  openProcess(desiredAccess: number, inheritHandle: number, pid: number): NativePtr
  getProcessTimes(
    process: NativePtr,
    creation: NativePtr,
    exit: NativePtr,
    kernel: NativePtr,
    user: NativePtr,
  ): number
  waitForSingleObject(handle: NativePtr, milliseconds: number): number
  closeHandle(handle: NativePtr): number
}

const PVOID: ReturnType<typeof koffi.pointer> = koffi.pointer('void')

/**
 * Resolve the koffi Win32 struct types once. Registration is lazy and cached
 * because koffi's type registry is global per process: test runners that
 * re-evaluate this module (a hoisted `vi.mock` re-imports the graph) must not
 * re-register the names.
 */
function win32Structs(): { PROCESSENTRY32W: ReturnType<typeof koffi.struct>; FILETIME: ReturnType<typeof koffi.struct> } {
  if (cachedStructs !== undefined) return cachedStructs
  // koffi PROCESSENTRY32W layout (tlhelp32.h); the size assert pins the x64 layout.
  const PROCESSENTRY32W = koffi.struct('PROCESSENTRY32W', {
    dwSize: 'uint32',
    cntUsage: 'uint32',
    th32ProcessID: 'uint32',
    th32DefaultHeapID: PVOID,
    th32ModuleID: 'uint32',
    cCntThreads: 'uint32',
    th32ParentProcessID: 'uint32',
    pcPriClassBase: 'int32',
    dwFlags: 'uint32',
    szExeFile: koffi.array('char16', 260),
  })
  // koffi FILETIME layout (minwinbase.h): two 32-bit halves of the 64-bit timestamp.
  const FILETIME = koffi.struct('FILETIME', {
    dwLowDateTime: 'uint32',
    dwHighDateTime: 'uint32',
  })
  /* v8 ignore start -- a layout-mismatch guard fires only on ABI breakage; the windows-native suites exercise the real struct. */
  if (PROCESSENTRY32W.size !== 568) {
    throw new Error(`PROCESSENTRY32W layout mismatch: koffi computed ${PROCESSENTRY32W.size}, Windows headers say 568`)
  }
  /* v8 ignore stop */
  cachedStructs = { PROCESSENTRY32W, FILETIME }
  return cachedStructs
}

let cachedStructs: ReturnType<typeof win32Structs> | undefined

const TH32CS_SNAPPROCESS = 0x2
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const SYNCHRONIZE = 0x00100000
const WAIT_OBJECT_0 = 0
const WAIT_TIMEOUT = 0x102

let cachedBindings: Win32Bindings | undefined

/**
 * Resolve the lazy Win32 bindings (throws the first binding failure, fail-closed).
 * @returns the cached binding table.
 */
function win32Bindings(): Win32Bindings {
  if (cachedBindings !== undefined) return cachedBindings
  const { PROCESSENTRY32W, FILETIME } = win32Structs()
  const kernel32 = koffi.load('kernel32.dll')
  const bind = (
    name: string,
    result: ReturnType<typeof koffi.pointer> | string,
    args: Array<ReturnType<typeof koffi.pointer> | string>,
  ): unknown => kernel32.func('__stdcall', name, result, args)
  cachedBindings = {
    createToolhelp32Snapshot: bind('CreateToolhelp32Snapshot', PVOID, ['uint32', 'uint32']),
    process32FirstW: bind('Process32FirstW', 'int', [PVOID, koffi.pointer(PROCESSENTRY32W)]),
    process32NextW: bind('Process32NextW', 'int', [PVOID, koffi.pointer(PROCESSENTRY32W)]),
    openProcess: bind('OpenProcess', PVOID, ['uint32', 'int', 'uint32']),
    getProcessTimes: bind('GetProcessTimes', 'int', [
      PVOID,
      koffi.pointer(FILETIME),
      koffi.pointer(FILETIME),
      koffi.pointer(FILETIME),
      koffi.pointer(FILETIME),
    ]),
    waitForSingleObject: bind('WaitForSingleObject', 'uint32', [PVOID, 'uint32']),
    closeHandle: bind('CloseHandle', 'int', [PVOID]),
  } as unknown as Win32Bindings
  return cachedBindings
}

/**
 * Allocate koffi memory as a branded {@link NativePtr}; koffi's TS types are
 * `any`, so the cast goes through `unknown` to keep the unsafe surface here.
 * @param type - the koffi type to allocate.
 * @param count - element count.
 * @returns the branded allocation pointer.
 */
function allocNative(type: Parameters<typeof koffi.alloc>[0], count: number): NativePtr {
  const value: unknown = koffi.alloc(type, count)
  return value as NativePtr
}

/** Enumerate the current process table through Toolhelp32. */
function snapshotWindowsProcesses(bindings: Win32Bindings): ProcessEntry[] {
  const { PROCESSENTRY32W } = win32Structs()
  const snapshot = bindings.createToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
  /* v8 ignore next -- an invalid snapshot for the process flag is not producible through the public API;
     the guard mirrors POSIX's unreadable-proc tolerance and isInvalidHandle is unit-tested. */
  if (isInvalidHandle(snapshot)) return []
  const entries: ProcessEntry[] = []
  try {
    const entry = allocNative(PROCESSENTRY32W, 1)
    koffi.encode(entry, 'uint32', PROCESSENTRY32W.size)
    let ok = bindings.process32FirstW(snapshot, entry)
    while (ok !== 0) {
      const record = koffi.decode(entry, PROCESSENTRY32W) as {
        th32ProcessID: number
        th32ParentProcessID: number
      }
      entries.push({ pid: record.th32ProcessID, parentPid: record.th32ParentProcessID })
      ok = bindings.process32NextW(snapshot, entry)
    }
  } finally {
    bindings.closeHandle(snapshot)
  }
  return entries
}

/** Read one process's creation identity and current wait state. */
function windowsProcessState(bindings: Win32Bindings, pid: number): WindowsProcessState | undefined {
  const { FILETIME } = win32Structs()
  const handle = bindings.openProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid)
  if (isInvalidHandle(handle)) return undefined
  try {
    const creation = allocNative(FILETIME, 1)
    const exit = allocNative(FILETIME, 1)
    const kernel = allocNative(FILETIME, 1)
    const user = allocNative(FILETIME, 1)
    /* v8 ignore next -- a GetProcessTimes failure after a successful open races process exit and
       cannot be staged deterministically; the absent-process path is covered and the caller
       treats undefined as a detector miss. */
    if (bindings.getProcessTimes(handle, creation, exit, kernel, user) === 0) return undefined
    const record = koffi.decode(creation, FILETIME) as { dwLowDateTime: number; dwHighDateTime: number }
    const wait = bindings.waitForSingleObject(handle, 0)
    /* v8 ignore next -- an opened process handle has exactly one of these two
       zero-time wait states; an unexpected Win32 failure is an unreadable process. */
    if (wait !== WAIT_OBJECT_0 && wait !== WAIT_TIMEOUT) return undefined
    return {
      started: `${record.dwHighDateTime}:${record.dwLowDateTime}`,
      active: wait === WAIT_TIMEOUT,
    }
  } finally {
    bindings.closeHandle(handle)
  }
}

/** The koffi-backed default internals; bindings resolve lazily on first use. */
function defaultWindowsProcessInternals(): WindowsProcessInspectorInternals {
  return {
    snapshot: () => snapshotWindowsProcesses(win32Bindings()),
    processState: pid => windowsProcessState(win32Bindings(), pid),
    taskkill: taskkillTree,
  }
}
