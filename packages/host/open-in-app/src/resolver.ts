/**
 * Platform resolution for the open-in-app catalog: each entry's locator
 * chain resolves to a verified {@link OpenInAppResolvedLaunch} — a
 * launcher this host actually holds — and one resolution pass yields the
 * map the routes serve and launch from, so a click never re-runs detection.
 * PATH names resolve in-process through the injected subprocess capability;
 * the remaining host commands (`xcode-select`, `reg.exe`) run through
 * `@deepseek-ai/dsh-native-command` (argv, never a shell). Application
 * adapters spawn detached with a credential-scrubbed environment and their
 * declared Windows visibility policy ({@link launchDetachedApp}); `shell-open`
 * launches (the file managers) go through the same package's path opener —
 * the OS shell's open verb — instead of a direct spawn.
 */

import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir, platform as osPlatform } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import {
  canOpenNativePath, openNativePath, runNativeCommand, type NativeCommandRunner,
} from '@deepseek-ai/dsh-native-command'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import {
  OPEN_IN_APP_CATALOG, PATH_TOKEN,
  type OpenInAppApp, type OpenInAppLaunch, type OpenInAppLocator, type OpenInAppPlatformSpec,
} from './catalog.ts'

/** Where this host holds one resolved application's icon pixels. */
export type OpenInAppIconSource =
  | { readonly kind: 'app-bundle'; readonly path: string }
  | { readonly kind: 'executable'; readonly path: string }

/** One entry's verified launchers and icon source on this host. */
export interface OpenInAppResolvedLaunch {
  readonly launch: OpenInAppLaunch
  readonly fallbackLaunch?: OpenInAppLaunch | undefined
  /**
   * Icon pixels source; absent on Linux (the icon route follows the spec's
   * desktop entry instead) and for launchers with no artwork of their own.
   */
  readonly icon?: OpenInAppIconSource | undefined
}

/** One detached GUI launch: spawn, then watch the window for early failure. */
export type OpenInAppLauncher = (
  command: string,
  args: readonly string[],
  options: {
    readonly watchMs: number
    readonly env?: Readonly<Record<string, string>> | undefined
    readonly windowsHide?: boolean | undefined
  },
) => Promise<void>

/** How one launch attempt ended; `missing` marks a stale resolution (ENOENT). */
export type OpenInAppLaunchOutcome = 'launched' | 'missing' | 'failed'

/**
 * Launch one application adapter detached from this process: the child gets a
 * credential-scrubbed environment (never the harness's `*KEY*`/`*SECRET*`
 * variables) plus the adapter's explicit environment entries, holds no stdio
 * pipe, and outlives dsh. Windows GUI processes remain visible unless the
 * adapter explicitly hides its own CLI process. Launch success is decoupled
 * from process exit — launchers such as kitty or the JetBrains IDEs stay in
 * the foreground for their whole window lifetime, so the watch window only
 * catches launchers that fail immediately: rejects on a spawn failure and on
 * a nonzero exit inside the window; a child still running when the window
 * closes is unrefed and counted launched, never killed.
 * @param command - executable path or PATH name.
 * @param args - argv (never a shell string).
 * @param options - watch-window length and adapter-specific process options.
 * @returns after the launch is counted successful; rejects on early failure.
 */
export const launchDetachedApp: OpenInAppLauncher = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: options.windowsHide,
      env: { ...scrubbedParentEnv(), ...options.env },
    })
    let settled = false
    const settle = (outcome: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(watch)
      child.unref()
      outcome()
    }
    const watch = setTimeout(() => { settle(resolve) }, options.watchMs)
    child.on('error', (error) => { settle(() => { reject(error) }) })
    child.on('exit', (code, signalName) => {
      if (code === 0) settle(resolve)
      else settle(() => { reject(new Error(`launcher exited with code ${String(code)}, signal ${String(signalName)}`)) })
    })
  })

/** Injectable platform facts for deterministic tests. */
export interface OpenInAppInternals {
  platform?: NodeJS.Platform
  /** Bundle-directory roots replacing `/Applications` and `~/Applications`. */
  applicationRoots?: readonly string[]
  /** Environment for `${VAR}`/`%VAR%` expansion in candidates and registry values. */
  env?: Readonly<Record<string, string | undefined>>
  /** Home directory replacing a leading `~/` in candidates. */
  home?: string
  run?: NativeCommandRunner
  launch?: OpenInAppLauncher
  /** In-process PATH-name resolution; null when the name is not on PATH. */
  resolveExecutable?: (name: string) => Promise<string | null>
}

/** Platform facts after the one explicit defaulting step at each public entry. */
export interface ResolvedInternals {
  platform: NodeJS.Platform
  applicationRoots: readonly string[]
  env: Readonly<Record<string, string | undefined>>
  home: string
  run: NativeCommandRunner
  launch: OpenInAppLauncher
  resolveExecutable: (name: string) => Promise<string | null>
}

/**
 * Resolve the injectable facts against the running host. `resolveExecutable`
 * has no host default — the plugin supplies the composition's subprocess
 * capability — so a caller that omits it fails loud here rather than
 * silently resolving every `cli` locator as missing.
 * @param internals - injectable facts.
 * @returns the completed facts.
 */
export function resolveInternals(internals: OpenInAppInternals): ResolvedInternals {
  const home = internals.home ?? homedir()
  const resolveExecutable = internals.resolveExecutable
  if (resolveExecutable === undefined) {
    throw new Error('open-in-app: internals.resolveExecutable is required (the subprocess capability provides it)')
  }
  return {
    platform: internals.platform ?? osPlatform(),
    applicationRoots: internals.applicationRoots ?? ['/Applications', join(home, 'Applications')],
    env: internals.env ?? process.env,
    home,
    run: internals.run ?? runNativeCommand,
    launch: internals.launch ?? launchDetachedApp,
    resolveExecutable,
  }
}

/** Closed-union exhaustiveness fence for the catalog's locator kinds. */
/* v8 ignore next 3 -- closed catalog union; only reached if an entry is forged */
function assertNever(value: never): never {
  throw new Error(`unhandled open-in-app catalog kind: ${JSON.stringify(value)}`)
}

/**
 * Run one bounded host command.
 * @param command - executable path or PATH name.
 * @param args - argv (never a shell string).
 * @param timeoutMs - command deadline.
 * @param internals - completed platform facts.
 * @returns stdout on exit 0; null on any failure (spawn, nonzero exit, timeout).
 */
export async function output(
  command: string, args: readonly string[], timeoutMs: number, internals: ResolvedInternals,
): Promise<string | null> {
  try {
    const { stdout } = await internals.run(command, args, AbortSignal.timeout(timeoutMs))
    return stdout
  } catch {
    // Swallows spawn, non-zero-exit, and timeout-abort failures alike: a
    // failed host command has exactly one meaning here — unavailable.
    return null
  }
}

/**
 * Probe one path as an existing directory.
 * @param path - candidate path.
 * @returns true when the path exists and is a directory.
 */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    // Swallows ENOENT/EACCES: an unreadable candidate is not a bundle.
    return false
  }
}

/**
 * Probe one path as an existing regular file.
 * @param path - candidate path.
 * @returns true when the path exists and is a regular file.
 */
export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    // Swallows ENOENT/EACCES: an unreadable candidate is not a launcher.
    return false
  }
}

/**
 * Expand `${VAR}` references and a leading `~/`. Expansion is string
 * substitution: a candidate keeps its template's `/` separators after the
 * expanded prefix, which Win32 path APIs accept.
 * @param template - candidate template.
 * @param internals - completed platform facts.
 * @returns the expanded candidate, or null when a variable is unset.
 */
export function expandCandidate(template: string, internals: ResolvedInternals): string | null {
  const unset: string[] = []
  const expanded = template.replace(/\$\{([^}]+)\}/g, (token, name: string) => {
    const value = internals.env[name]
    if (value === undefined) unset.push(name)
    return value ?? token
  })
  if (unset.length > 0) return null
  return expanded.startsWith('~/') ? join(internals.home, expanded.slice(2)) : expanded
}

/** Expand `%VAR%` references in a Windows registry value; null when a variable is unset. */
function expandRegistryValue(value: string, internals: ResolvedInternals): string | null {
  const unset: string[] = []
  const expanded = value.replace(/%([^%]+)%/g, (token, name: string) => {
    const found = internals.env[name]
    if (found === undefined) unset.push(name)
    return found ?? token
  })
  return unset.length > 0 ? null : expanded
}

/** One Windows Uninstall record's fields relevant to launcher derivation. */
interface WindowsInstallRecord {
  readonly displayName: string
  readonly installLocation?: string | undefined
  readonly displayIcon?: string | undefined
}

/** Lazily built Windows registry facts shared by one resolution pass. */
export interface WindowsRegistryView {
  /** Lower-cased registered executable name to its `App Paths` default value. */
  readonly appPaths: ReadonlyMap<string, string>
  readonly installRecords: readonly WindowsInstallRecord[]
}

/** `App Paths` roots, user hive first (per-user installs shadow machine ones). */
const APP_PATHS_ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
] as const

/** Uninstall-record roots: user hive, 64-bit machine hive, 32-bit machine view. */
const UNINSTALL_ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
] as const

/**
 * Parse `reg.exe query <root> /s` output into per-subkey string values.
 * `reg.exe` prints one key path line per subkey followed by indented value
 * lines; the value-name/type/data columns are matched by the `REG_*` type
 * token because the default-value marker localizes (`(Default)`, `(默认)`).
 * @param dump - raw `reg.exe` stdout.
 * @returns subkey path to its `REG_SZ`/`REG_EXPAND_SZ` values by value name
 *   (the default value under the name `(Default)` regardless of locale).
 */
export function parseRegistryDump(dump: string): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const keys = new Map<string, Map<string, string>>()
  let current: Map<string, string> | undefined
  for (const line of dump.split(/\r?\n/)) {
    if (/^HK/.test(line)) {
      current = new Map()
      keys.set(line.trim(), current)
      continue
    }
    const value = /^\s+(.*?)\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/.exec(line)
    if (value === null || current === undefined) continue
    // oxlint-disable-next-line typescript/no-non-null-assertion -- both capture groups exist on any match
    const [name, data] = [value[1]!, value[3]!]
    // reg.exe localizes the default-value marker; every locale wraps it in parentheses.
    current.set(/^\(.*\)$/.test(name) ? '(Default)' : name, data.trim())
  }
  return keys
}

/**
 * Build the Windows registry facts for one resolution pass: the `App Paths`
 * table and the Uninstall records, one `reg.exe query /s` per root. A root
 * that fails or is absent contributes nothing.
 * @param timeoutMs - per-`reg.exe` deadline.
 * @param internals - completed platform facts.
 * @returns the parsed view.
 */
export async function readWindowsRegistryView(
  timeoutMs: number, internals: ResolvedInternals,
): Promise<WindowsRegistryView> {
  const appPaths = new Map<string, string>()
  const installRecords: WindowsInstallRecord[] = []
  for (const root of APP_PATHS_ROOTS) {
    const dump = await output('reg.exe', ['query', root, '/s'], timeoutMs, internals)
    if (dump === null) continue
    for (const [key, values] of parseRegistryDump(dump)) {
      // Registry keys separate with '\' on every host this parser runs on
      // (tests parse fixtures on POSIX), so path.basename does not apply.
      const exe = key.slice(key.lastIndexOf('\\') + 1).toLowerCase()
      const target = values.get('(Default)')
      if (!exe.endsWith('.exe') || target === undefined || appPaths.has(exe)) continue
      const expanded = expandRegistryValue(target.replace(/^"|"$/g, ''), internals)
      if (expanded !== null) appPaths.set(exe, expanded)
    }
  }
  for (const root of UNINSTALL_ROOTS) {
    const dump = await output('reg.exe', ['query', root, '/s'], timeoutMs, internals)
    if (dump === null) continue
    for (const values of parseRegistryDump(dump).values()) {
      const displayName = values.get('DisplayName')
      if (displayName === undefined) continue
      installRecords.push({
        displayName,
        installLocation: values.get('InstallLocation'),
        displayIcon: values.get('DisplayIcon'),
      })
    }
  }
  return { appPaths, installRecords }
}

/** Pass-scoped lazy holder so one detection pass reads the registry at most once. */
class RegistryViewOnce {
  private view: Promise<WindowsRegistryView> | undefined
  constructor(private readonly timeoutMs: number, private readonly internals: ResolvedInternals) {}

  /** The pass's registry view, read on first use. */
  read(): Promise<WindowsRegistryView> {
    this.view ??= readWindowsRegistryView(this.timeoutMs, this.internals)
    return this.view
  }
}

/** The executable a Windows Uninstall record proves, or null when it proves none. */
async function recordLauncher(
  record: WindowsInstallRecord,
  relativeLauncher: string | undefined,
  internals: ResolvedInternals,
): Promise<string | null> {
  if (relativeLauncher !== undefined && record.installLocation !== undefined && record.installLocation !== '') {
    const expanded = expandRegistryValue(record.installLocation.replace(/^"|"$/g, ''), internals)
    if (expanded !== null) {
      const candidate = join(expanded, relativeLauncher)
      if (await isFile(candidate)) return candidate
    }
  }
  if (record.displayIcon !== undefined) {
    // DisplayIcon may carry a `,<index>` suffix and quotes around the path.
    const bare = record.displayIcon.replace(/,-?\d+$/, '').replace(/^"|"$/g, '').trim()
    const expanded = expandRegistryValue(bare, internals)
    if (expanded !== null && expanded.toLowerCase().endsWith('.exe') && await isFile(expanded)) return expanded
  }
  return null
}

/** Fields of one parsed XDG desktop entry the resolver and icon route read. */
export interface DesktopEntry {
  readonly exec?: string
  readonly tryExec?: string
  readonly icon?: string
}

/**
 * Parse the `[Desktop Entry]` section's `Exec`/`TryExec`/`Icon` keys.
 * @param text - desktop-entry file text.
 * @returns the recognized fields; keys outside the entry section are ignored.
 */
export function parseDesktopEntry(text: string): DesktopEntry {
  let inEntry = false
  const fields: { exec?: string; tryExec?: string; icon?: string } = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) {
      inEntry = trimmed === '[Desktop Entry]'
      continue
    }
    if (!inEntry) continue
    const separator = trimmed.indexOf('=')
    if (separator < 0) continue
    const key = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim()
    if (key === 'Exec') fields.exec = value
    else if (key === 'TryExec') fields.tryExec = value
    else if (key === 'Icon') fields.icon = value
  }
  return fields
}

/**
 * XDG data directories in precedence order (`XDG_DATA_HOME`, then `XDG_DATA_DIRS`).
 * @param internals - completed platform facts.
 * @returns the data directories, freedesktop defaults applied.
 */
export function xdgDataDirectories(internals: ResolvedInternals): readonly string[] {
  const dataHome = internals.env['XDG_DATA_HOME'] ?? join(internals.home, '.local', 'share')
  const dataDirs = internals.env['XDG_DATA_DIRS'] ?? '/usr/local/share:/usr/share'
  return [dataHome, ...dataDirs.split(':').filter(dir => dir !== '')]
}

/**
 * Read one desktop entry by id from the XDG application directories.
 * @param desktopId - entry id without the `.desktop` suffix.
 * @param internals - completed platform facts.
 * @returns the parsed entry, or null when no directory holds it.
 */
export async function findDesktopEntry(
  desktopId: string, internals: ResolvedInternals,
): Promise<DesktopEntry | null> {
  for (const dataDir of xdgDataDirectories(internals)) {
    const path = join(dataDir, 'applications', `${desktopId}.desktop`)
    try {
      return parseDesktopEntry(await readFile(path, 'utf8'))
    } catch {
      // Swallows ENOENT/EACCES: try the next data directory.
    }
  }
  return null
}

/**
 * The executable one desktop entry proves: a `TryExec` when present,
 * otherwise `Exec`'s first token (quoted or bare); absolute paths verify on
 * disk and bare names resolve in-process through the subprocess capability.
 */
async function desktopLauncher(entry: DesktopEntry, internals: ResolvedInternals): Promise<string | null> {
  const candidate = entry.tryExec ?? execCommand(entry.exec)
  if (candidate === null || candidate === '') return null
  if (isAbsolute(candidate)) return await isFile(candidate) ? candidate : null
  return internals.resolveExecutable(candidate)
}

/**
 * First token of an `Exec=` value.
 * @param exec - the raw `Exec=` value, when the entry carries one.
 * @returns the quoted path or the run up to whitespace; null when absent or blank.
 */
export function execCommand(exec: string | undefined): string | null {
  if (exec === undefined) return null
  const quoted = /^"([^"]+)"/.exec(exec)
  if (quoted?.[1] !== undefined) return quoted[1]
  const bare = /^\S+/.exec(exec)
  return bare === null ? null : bare[0]
}

/**
 * The catalog entry's spec for one platform.
 * @param app - catalog entry.
 * @param platform - host platform.
 * @returns the declared spec; undefined off the declared three platforms.
 */
export function specFor(app: OpenInAppApp, platform: NodeJS.Platform): OpenInAppPlatformSpec | undefined {
  return platform === 'darwin' || platform === 'win32' || platform === 'linux'
    ? app.platforms[platform]
    : undefined
}

/** Icon source for a resolved executable: Windows extracts from the binary itself. */
function executableIcon(path: string, internals: ResolvedInternals): OpenInAppIconSource | undefined {
  return internals.platform === 'win32' ? { kind: 'executable', path } : undefined
}

/** Resolve one locator to a verified launch, or null when it proves nothing. */
async function locate(
  locator: OpenInAppLocator,
  probeTimeoutMs: number,
  registry: RegistryViewOnce,
  internals: ResolvedInternals,
): Promise<OpenInAppResolvedLaunch | null> {
  switch (locator.kind) {
    case 'fixed': {
      // A fixed entry ships with its OS, so the icon path is trusted rather
      // than probed (a somehow-missing file surfaces as a 404 at extraction);
      // only an unset variable (`${SystemRoot}`) drops the icon claim.
      const iconPath = expandCandidate(locator.iconPath, internals)
      const icon = iconPath === null
        ? undefined
        : internals.platform === 'win32'
          ? { kind: 'executable' as const, path: iconPath }
          : { kind: 'app-bundle' as const, path: iconPath }
      return { launch: locator.launch, icon }
    }
    case 'app': {
      for (const root of internals.applicationRoots) {
        for (const fsName of locator.fsNames) {
          const bundle = join(root, fsName)
          if (await isDirectory(bundle)) {
            return {
              launch: { kind: 'argv', command: 'open', args: ['-a', bundle] },
              icon: { kind: 'app-bundle', path: bundle },
            }
          }
        }
      }
      return null
    }
    case 'xcode': {
      const developer = await output('xcode-select', ['-p'], probeTimeoutMs, internals)
      if (developer === null) return null
      const bundle = dirname(dirname(developer.trim()))
      if (!bundle.endsWith('.app') || !await isDirectory(bundle)) return null
      return {
        launch: { kind: 'argv', command: 'xed', args: [] },
        fallbackLaunch: { kind: 'argv', command: 'open', args: ['-a', bundle] },
        icon: { kind: 'app-bundle', path: bundle },
      }
    }
    case 'cli': {
      if (locator.requiresDesktop === true && !canOpenNativePath({
        platform: internals.platform,
        env: { ...internals.env },
      })) return null
      const found = await internals.resolveExecutable(locator.name)
      return found === null
        ? null
        : { launch: { kind: 'argv', command: found, args: locator.args }, icon: executableIcon(found, internals) }
    }
    case 'file': {
      for (const candidate of locator.candidates) {
        const path = expandCandidate(candidate, internals)
        if (path !== null && await isFile(path)) {
          return { launch: { kind: 'argv', command: path, args: locator.args }, icon: executableIcon(path, internals) }
        }
      }
      return null
    }
    case 'scan': {
      const root = expandCandidate(locator.root, internals)
      if (root === null) return null
      let entries: string[]
      try {
        entries = await readdir(root)
      } catch {
        // Swallows a missing/unreadable root: no install directory to scan.
        return null
      }
      // Version-suffixed directory names compare numeric-aware, newest first
      // ('2024.1.10' outranks '2024.1.9', which plain lexicographic misses).
      const versions = entries.filter(entry => entry.startsWith(locator.namePrefix))
        .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
      for (const version of versions) {
        const launcher = join(root, version, locator.relativeLauncher)
        if (await isFile(launcher)) {
          return { launch: { kind: 'argv', command: launcher, args: locator.args }, icon: executableIcon(launcher, internals) }
        }
      }
      return null
    }
    case 'app-paths': {
      const target = (await registry.read()).appPaths.get(locator.exe.toLowerCase())
      if (target === undefined || !await isFile(target)) return null
      return { launch: { kind: 'argv', command: target, args: locator.args }, icon: { kind: 'executable', path: target } }
    }
    case 'install-record': {
      for (const record of (await registry.read()).installRecords) {
        if (!record.displayName.startsWith(locator.displayNamePrefix)) continue
        const launcher = await recordLauncher(record, locator.relativeLauncher, internals)
        if (launcher !== null) {
          return { launch: { kind: 'argv', command: launcher, args: locator.args }, icon: { kind: 'executable', path: launcher } }
        }
      }
      return null
    }
    case 'github-desktop': {
      const root = expandCandidate(locator.root, internals)
      if (root === null) return null
      let versions: string[]
      try {
        versions = (await readdir(root))
          .filter(entry => entry.startsWith('app-'))
          .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
      } catch {
        // Swallows a missing/unreadable install root: GitHub Desktop is absent.
        return null
      }
      for (const version of versions) {
        const directory = join(root, version)
        const executable = join(directory, 'GitHubDesktop.exe')
        const cli = join(directory, 'resources', 'app', 'cli.js')
        if (await isFile(executable) && await isFile(cli)) {
          return {
            launch: {
              kind: 'argv',
              command: executable,
              args: [cli, 'open'],
              env: { ELECTRON_RUN_AS_NODE: '1' },
              windowsHide: true,
            },
            icon: { kind: 'executable', path: executable },
          }
        }
      }
      return null
    }
    case 'desktop': {
      const entry = await findDesktopEntry(locator.desktopId, internals)
      if (entry === null) return null
      const launcher = await desktopLauncher(entry, internals)
      return launcher === null ? null : { launch: { kind: 'argv', command: launcher, args: locator.args } }
    }
    /* v8 ignore next -- closed locator union */
    default: return assertNever(locator)
  }
}

/**
 * Resolve one catalog entry on this host: this platform's locators are tried
 * in order and the first verified launcher wins.
 * @param app - catalog entry.
 * @param probeTimeoutMs - per-command deadline for resolution host commands.
 * @param internals - platform and runner hooks for deterministic tests.
 * @returns the verified launch, or null when the entry is not installed here.
 */
export async function resolveLaunch(
  app: OpenInAppApp, probeTimeoutMs: number, internals: OpenInAppInternals = {},
): Promise<OpenInAppResolvedLaunch | null> {
  const resolved = resolveInternals(internals)
  return resolveWithRegistry(app, probeTimeoutMs, new RegistryViewOnce(probeTimeoutMs, resolved), resolved)
}

/** Resolve one entry against a pass-shared registry view. */
async function resolveWithRegistry(
  app: OpenInAppApp,
  probeTimeoutMs: number,
  registry: RegistryViewOnce,
  internals: ResolvedInternals,
): Promise<OpenInAppResolvedLaunch | null> {
  const platformSpec = specFor(app, internals.platform)
  if (platformSpec === undefined) return null
  for (const locator of platformSpec.locators) {
    const found = await locate(locator, probeTimeoutMs, registry, internals)
    if (found !== null) return found
  }
  return null
}

/**
 * Resolve the whole catalog once: every entry's verified launcher on this
 * host, in menu order. The Windows registry is read at most once per pass.
 * The returned map is the mutable authority the caller owns — the routes
 * serve its keys and launch from its values, and a stale entry is replaced
 * or removed in place after an `ENOENT` launch.
 * @param probeTimeoutMs - per-command deadline for resolution host commands.
 * @param internals - platform and runner hooks for deterministic tests.
 * @returns catalog id to verified launch, in catalog order.
 */
export async function resolveOpenInAppApps(
  probeTimeoutMs: number, internals: OpenInAppInternals = {},
): Promise<Map<string, OpenInAppResolvedLaunch>> {
  const resolved = resolveInternals(internals)
  const registry = new RegistryViewOnce(probeTimeoutMs, resolved)
  const entries = await Promise.all(OPEN_IN_APP_CATALOG.map(async app =>
    [app.id, await resolveWithRegistry(app, probeTimeoutMs, registry, resolved)] as const))
  const map = new Map<string, OpenInAppResolvedLaunch>()
  for (const [id, launch] of entries) {
    if (launch !== null) map.set(id, launch)
  }
  return map
}

/**
 * Substitute the directory token into one launch argv, appending the
 * directory when no arg carries one.
 */
function launchArgs(args: readonly string[], path: string): readonly string[] {
  return args.some(arg => arg.includes(PATH_TOKEN))
    ? args.map(arg => arg.replaceAll(PATH_TOKEN, path))
    : [...args, path]
}

/** Whether a launch rejection names a missing executable (a stale resolution). */
function isMissingExecutable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/**
 * Open one directory through the OS shell's open verb under the launch watch
 * window: the opener command completing inside the window decides the
 * outcome, and an opener still running when it closes counts as launched and
 * keeps running (a cold `powershell.exe` start can outlive the window; its
 * late settlement is swallowed because the request already answered).
 */
function runShellOpen(
  path: string, watchMs: number, internals: ResolvedInternals,
): Promise<OpenInAppLaunchOutcome> {
  const opening = openNativePath(path, new AbortController().signal, {
    platform: internals.platform, run: internals.run, env: internals.env,
  })
  return new Promise((resolve) => {
    const watch = setTimeout(() => {
      opening.catch(() => {
        // Late failure of an opener the window already counted as launched.
      })
      resolve('launched')
    }, watchMs)
    opening.then(
      () => {
        clearTimeout(watch)
        resolve('launched')
      },
      (error: unknown) => {
        clearTimeout(watch)
        resolve(isMissingExecutable(error) ? 'missing' : 'failed')
      },
    )
  })
}

/** Run one launcher and classify how the attempt ended. */
async function runLaunch(
  launch: OpenInAppLaunch, path: string, watchMs: number, internals: ResolvedInternals,
): Promise<OpenInAppLaunchOutcome> {
  switch (launch.kind) {
    case 'shell-open':
      return runShellOpen(path, watchMs, internals)
    case 'argv':
      try {
        await internals.launch(launch.command, launchArgs(launch.args, path), {
          watchMs,
          ...(launch.env === undefined ? {} : { env: launch.env }),
          ...(launch.windowsHide === undefined ? {} : { windowsHide: launch.windowsHide }),
        })
        return 'launched'
      } catch (error: unknown) {
        // A missing executable marks the resolution stale (the caller
        // re-resolves once); every other spawn or early-exit failure has one
        // meaning — the launcher never opened anything — and the caller may
        // still try a fallback.
        return isMissingExecutable(error) ? 'missing' : 'failed'
      }
    /* v8 ignore next -- closed launch union */
    default: return assertNever(launch)
  }
}

/**
 * Launch one resolved application on a directory: the primary launcher, then
 * the fallback when the primary fails inside the watch window.
 * @param resolved - the entry's verified launchers.
 * @param path - absolute workspace directory (already validated by the route).
 * @param watchMs - early-failure watch window per launcher (a child still
 * running when it closes counts as launched and keeps running).
 * @param internals - launcher hook for deterministic tests.
 * @returns how the attempt ended; `missing` when a tried launcher's
 *   executable is gone, which tells the caller to re-resolve once.
 */
export async function launchResolved(
  resolved: OpenInAppResolvedLaunch, path: string, watchMs: number, internals: OpenInAppInternals = {},
): Promise<OpenInAppLaunchOutcome> {
  const completed = resolveInternals(internals)
  const primary = await runLaunch(resolved.launch, path, watchMs, completed)
  if (primary === 'launched' || resolved.fallbackLaunch === undefined) return primary
  const fallback = await runLaunch(resolved.fallbackLaunch, path, watchMs, completed)
  if (fallback === 'launched') return 'launched'
  // Either tried launcher having vanished is grounds to refresh the resolution.
  return primary === 'missing' || fallback === 'missing' ? 'missing' : 'failed'
}
