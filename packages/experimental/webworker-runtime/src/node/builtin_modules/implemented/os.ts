/**
 * `node:os` for the worker: every value points into the VFS or reports the fixed
 * platform identity the host tree is built for (`linux`, one CPU). Values are
 * real rather than throwing because several `[Service.init]` bodies read them
 * during construction.
 */
import { DSH_HOME, DSH_TMP } from '../../../storage/paths.ts'
import type { CpuInfo, NetworkInterfaceInfo } from 'node:os'

/** Line ending of the virtual platform. */
export const EOL = '\n'

/**
 * Temporary directory.
 * @returns the VFS temp path.
 */
export function tmpdir(): string {
  return DSH_TMP
}

/**
 * Home directory.
 * @returns `$DSH_HOME` inside the VFS.
 */
export function homedir(): string {
  return DSH_HOME
}

/**
 * Platform identity.
 * @returns always 'linux'.
 */
export function platform(): NodeJS.Platform {
  return 'linux'
}

/**
 * Operating-system type.
 * @returns always 'Linux'.
 */
export function type(): string {
  return 'Linux'
}

/**
 * CPU architecture.
 * @returns always 'x64'.
 */
export function arch(): string {
  return 'x64'
}

/**
 * Kernel release.
 * @returns a synthetic release string.
 */
export function release(): string {
  return '0.0.0-dsh-worker'
}

/**
 * Host name.
 * @returns a synthetic name.
 */
export function hostname(): string {
  return 'dsh-worker'
}

/**
 * Usable parallelism.
 * @returns the browser's hardware concurrency, at least 1.
 */
export function availableParallelism(): number {
  return Math.max(1, navigator.hardwareConcurrency)
}

/**
 * CPU inventory.
 * @returns an empty list (no per-core facts inside a worker).
 */
export function cpus(): CpuInfo[] {
  return []
}

/**
 * Network interfaces.
 * @returns an empty record — a worker has no view of the host's network.
 */
export function networkInterfaces(): NodeJS.Dict<NetworkInterfaceInfo[]> {
  return {}
}

/** OS constants: only the signal table is read (terminal signal name mapping). */
export const constants = {
  signals: {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8,
    SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
  },
  errno: {},
  priority: {},
}

/** CommonJS interop marker: the worker loader hands `default` to default imports (see ./builtins.ts). */
export const __esModule = true

/**
 * The `node:os` declarations this module stands in for. `constants` keeps this
 * module's own value: Node declares the full `errno`, `priority`, and `dlopen`
 * tables, while only the signal-name mapping is read here.
 */
type NodeFace = Partial<Omit<typeof import('node:os'), 'constants'>> & Record<'constants', unknown>

/** CommonJS default export: the members `require()` hands a caller of this module. */
export default {
  EOL, tmpdir, homedir, platform, type, arch, release, hostname, availableParallelism, cpus,
  networkInterfaces, constants,
} satisfies NodeFace
