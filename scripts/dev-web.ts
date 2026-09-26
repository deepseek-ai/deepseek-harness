/**
 * The Web development loop: build once, serve through `dsh web`, and keep every
 * browser-side artifact rebuilt on source edits, in one terminal.
 *
 * Stages, in order: `pnpm run build` (skipped by `--skip-build`), three
 * long-lived watchers, then `dsh web` (skipped by `--no-serve`). The watchers
 * exist because the compile shell links built lib products rather than
 * sources: `tsc -b tsconfig.client.json --watch` emits `lib/types` (the tsdown
 * lib entries are that emit, not `src`), tsdown watch bundles `lib/index.js`
 * and `lib/client.js`, and `vite build --watch` rewrites `apps/web/dist`, which
 * `dsh web` serves. A missing watcher does not fail — it silently shows the
 * previous artifact, so an edit appears to do nothing; any stage exiting on its
 * own therefore stops the loop with exit code 1.
 *
 * Reload signaling is not this script's business — the host webserver
 * stat-polls the bundles it serves and broadcasts `rebuilt` frames itself, so
 * any process that rewrites `lib/client.js` files triggers reloads.
 *
 * MUST NOT run beside `pnpm run build`: both write the same `lib/` and
 * `apps/web/dist/` trees. The build stage here finishes before any watcher starts.
 *
 * Usage: `pnpm run dev:web [--skip-build] [--no-serve] [--poll[=ms]] [dsh web arguments]`.
 * `--skip-build` requires the artifact tree from a prior complete build: every
 * watcher is incremental over the previous stage's output and none of them
 * bootstraps a missing tree. `--no-serve` keeps only the watchers, for a
 * `dsh web` started elsewhere. `--poll` switches the source watchers to polling
 * (default 500ms): network mounts (weka) deliver no inotify events, so native
 * watching sees the initial build only and never a source change. Polling has
 * to reach tsc too — a native-watching tsc never re-emits `lib/types`, which
 * strands the other two stages on stale input.
 *
 * Shutdown: Ctrl+C reaches every stage through the terminal's process group, so
 * the script only waits for them and escalates survivors; SIGTERM is addressed
 * to this process alone and is forwarded once. The exit code is 130 after
 * SIGINT, 0 after SIGTERM, and 1 when a stage exited on its own.
 *
 * Each package keeps its own tsdown.config.ts untouched: this script layers
 * `watch` through API-level inline config (tsdown workspace mode fills inline
 * keys under each package's file config, and no package config defines it).
 */
import { globSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { build } from 'tsdown'
import type { TsdownBundle } from 'tsdown'
import {
  CLIENT_BUILD_PROFILE_SELECTOR,
  clientBuildProcessEnvironment,
  repositoryClientBuildEnvironment,
} from './client-build-environment.ts'
import { pnpmInvocation } from './pnpm-invocation.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** Client-face type emit feeding every tsdown lib entry in the watch set. */
const CLIENT_TYPE_PROGRAM = 'tsconfig.client.json'

/** Compile-shell workspace whose dist `dsh web` serves. */
const SHELL_PACKAGE = '@deepseek-ai/dsh-web-frontend'

/**
 * Test infrastructure builds through the client preset but never enters the
 * shell's module graph, so it is not a dev-loop artifact.
 */
const TEST_INFRASTRUCTURE_PREFIX = 'packages/test-support/'

/**
 * Sample one local public environment for every long-lived watcher stage.
 * @param root - repository root supplying version and Git metadata.
 * @param environment - watcher launch environment supplying public extensions.
 * @returns process environment shared by tsdown and spawned watcher stages.
 */
export function devWebBuildEnvironment(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return clientBuildProcessEnvironment(environment, repositoryClientBuildEnvironment(root, environment))
}

/** Resolved `dev-web` command line: the script's own flags plus the arguments forwarded to `dsh web`. */
export interface DevWebArguments {
  /** Skip the complete `pnpm run build` that otherwise precedes the watchers. */
  readonly skipBuild: boolean
  /** Start `dsh web`; false keeps only the rebuild watchers beside an already running server. */
  readonly serve: boolean
  /** Source-watcher polling interval in milliseconds; undefined selects native watching. */
  readonly pollInterval: number | undefined
  /** Arguments forwarded verbatim to `dsh web`, in order. */
  readonly appArgs: readonly string[]
}

/** Polling interval selected by a bare `--poll`. */
const DEFAULT_POLL_INTERVAL = 500

/**
 * Parse the script's command line. `--skip-build`, `--no-serve`, and `--poll[=ms]`
 * belong to this script; a bare `--` is dropped; every other token is forwarded
 * to `dsh web`.
 * @param argv - arguments after the script path.
 * @returns the resolved flags and forwarded arguments.
 * @throws Error when `--poll` carries a non-positive or non-integer interval, or
 * when `--no-serve` leaves forwarded arguments without a `dsh web` process.
 */
export function parseDevWebArguments(argv: readonly string[]): DevWebArguments {
  let skipBuild = false
  let serve = true
  let pollInterval: number | undefined
  const appArgs: string[] = []
  for (const arg of argv) {
    // `pnpm run` forwards a `--` separator verbatim; it carries no meaning here.
    if (arg === '--') continue
    if (arg === '--skip-build') skipBuild = true
    else if (arg === '--no-serve') serve = false
    else if (arg === '--poll' || arg.startsWith('--poll=')) {
      pollInterval = arg === '--poll' ? DEFAULT_POLL_INTERVAL : Number(arg.slice('--poll='.length))
      if (!Number.isInteger(pollInterval) || pollInterval <= 0) throw new Error(`dev-web: invalid --poll interval "${arg}"`)
    } else appArgs.push(arg)
  }
  if (!serve && appArgs.length > 0) {
    throw new Error(`dev-web: --no-serve leaves no dsh web process for ${appArgs[0] ?? ''}`)
  }
  return { skipBuild, serve, pollInterval, appArgs }
}

/**
 * Discover the watch workspace by declaration: every packages/<group>/<name>
 * whose package.json carries `dsh.client` with platform "web" is a client
 * plugin bundle emitter. Scanned once at startup — a package added while
 * watching means restarting this script.
 * @param root - repository root containing the grouped package directories.
 * @returns workspace-relative plugin package directories.
 */
export function discoverPluginDirs(root = repoRoot): string[] {
  const dirs: string[] = []
  for (const manifestPath of globSync('packages/*/*/package.json', { cwd: root }).sort()) {
    const manifest = JSON.parse(readFileSync(join(root, manifestPath), 'utf8')) as {
      dsh?: { client?: { platform?: unknown } }
    }
    if (manifest.dsh?.client?.platform === 'web') dirs.push(dirname(manifestPath).split(sep).join('/'))
  }
  return dirs
}

/**
 * Discover the statically linked library packages: the other half of the same
 * partition {@link discoverPluginDirs} takes. A package that builds through the
 * client preset without declaring `dsh.client` has no loader-delivered browser
 * half, so the compile shell links its `lib/index.js` instead — and an edit to
 * its source reaches the browser only once that bundle is rewritten. Deriving
 * the set from the build preset rather than a hand list keeps it correct when
 * dependency sections move around; deriving it from `dependencies` would not,
 * because client packages declare their build inputs as devDependencies.
 * @param root - repository root containing the grouped package directories.
 * @returns workspace-relative library package directories.
 */
export function discoverLibraryDirs(root = repoRoot): string[] {
  const dirs: string[] = []
  for (const configPath of globSync('packages/*/*/tsdown.config.ts', { cwd: root }).sort()) {
    const dir = dirname(configPath).split(sep).join('/')
    if (dir.startsWith(TEST_INFRASTRUCTURE_PREFIX)) continue
    if (!readFileSync(join(root, configPath), 'utf8').includes('tsdown.client.ts')) continue
    const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) as {
      dsh?: { client?: unknown }
    }
    if (manifest.dsh?.client === undefined) dirs.push(dir)
  }
  return dirs
}

/**
 * Start the tsdown watch build used by `pnpm run dev:web`.
 * @param root - repository or fixture root passed to tsdown.
 * @param pluginDirs - workspace-relative package directories to watch.
 * @param pollInterval - optional source-watcher polling interval in milliseconds.
 * @returns live bundles after every watcher has completed its initial build.
 */
export async function watchClientPlugins(
  root: string,
  pluginDirs: readonly string[],
  pollInterval?: number,
): Promise<TsdownBundle[]> {
  let resolveInitialBuilds: (() => void) | undefined
  const initialBuilds = new Promise<void>((resolve) => { resolveInitialBuilds = resolve })
  const initialized = new WeakSet<object>()
  const readiness: { expectedBuilds?: number; initializedBuilds: number } = { initializedBuilds: 0 }
  const bundles = await build({
    cwd: root,
    workspace: [...pluginDirs],
    watch: true,
    hooks: {
      'build:done': ({ options }) => {
        if (initialized.has(options)) return
        initialized.add(options)
        readiness.initializedBuilds += 1
        if (
          readiness.expectedBuilds !== undefined
          && readiness.initializedBuilds >= readiness.expectedBuilds
        ) resolveInitialBuilds?.()
      },
    },
    ...pollInterval !== undefined
      ? { inputOptions: { watch: { watcher: { usePolling: true, pollInterval } } } }
      : {},
  })
  readiness.expectedBuilds = bundles.length
  if (readiness.initializedBuilds >= readiness.expectedBuilds) resolveInitialBuilds?.()
  await initialBuilds
  return bundles
}

/** One long-lived stage process as the supervisor observes it. */
export interface StageHandle {
  /** Command label used in diagnostics. */
  readonly name: string
  /** Settles with the exit code, or null when a signal ended the stage. */
  readonly exited: Promise<number | null>
  /**
   * Deliver one signal; a no-op once the stage has exited.
   * @param signal - the signal to send.
   */
  kill(signal: NodeJS.Signals): void
}

/** How a requested stop reaches the stages. */
export interface StageStop {
  /** Signal sent to every live stage first; omitted when the terminal already delivered SIGINT to them. */
  readonly signal?: NodeJS.Signals | undefined
  /** Milliseconds to wait for exits before escalating to SIGTERM, and again before SIGKILL. */
  readonly graceMs: number
}

/**
 * Own the live stages: report a stage that exits before a stop was requested,
 * and on a requested stop signal, wait, and escalate until every stage has exited.
 */
export class StageSupervisor {
  private readonly live = new Set<StageHandle>()
  private stopping = false

  /**
   * @param onStale - receives the stage name and exit code when a stage exits before a stop was requested.
   */
  constructor(private readonly onStale: (stage: string, code: number | null) => void) {}

  /**
   * Track one started stage until it exits.
   * @param stage - the stage to supervise.
   */
  add(stage: StageHandle): void {
    this.live.add(stage)
    void stage.exited.then((code) => {
      this.live.delete(stage)
      if (!this.stopping) this.onStale(stage.name, code)
    })
  }

  /**
   * Stop every live stage and resolve once all of them have exited.
   * @param stop - initial signal and the grace period between escalation steps.
   */
  async stop(stop: StageStop): Promise<void> {
    this.stopping = true
    const escalation: (NodeJS.Signals | undefined)[] = [stop.signal]
    if (stop.signal !== 'SIGTERM') escalation.push('SIGTERM')
    for (const signal of escalation) {
      if (this.live.size === 0) return
      if (signal !== undefined) for (const stage of this.live) stage.kill(signal)
      await this.settled(stop.graceMs)
    }
    for (const stage of this.live) stage.kill('SIGKILL')
    await Promise.all([...this.live].map(stage => stage.exited))
  }

  private async settled(graceMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      Promise.all([...this.live].map(stage => stage.exited)),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs) }),
    ])
    clearTimeout(timer)
  }
}

/**
 * Grace period per escalation step. `dsh web` gives its plugin tree five seconds
 * to dispose after the first signal; escalating earlier would turn the graceful
 * drain into a forced exit.
 */
const STOP_GRACE_MS = 6_000

/**
 * Spawn one long-lived stage with inherited stdio and hand it to the supervisor.
 * @param supervisor - owner that reports an unexpected exit and stops the stage on shutdown.
 * @param name - command label used in diagnostics.
 * @param command - executable, resolved from the workspace bins when `local` is set.
 * @param args - command arguments.
 * @param local - whether to resolve `command` from the workspace's installed bins.
 */
function spawnStage(
  supervisor: StageSupervisor,
  name: string,
  command: string,
  args: readonly string[],
  local: boolean,
): void {
  const child = execa(command, [...args], {
    cwd: repoRoot,
    stdio: 'inherit',
    preferLocal: local,
    reject: false,
  })
  supervisor.add({
    name,
    exited: child.then(result => result.exitCode ?? null),
    kill(signal) { child.kill(signal) },
  })
}

/**
 * Run the complete repository build with the launch environment untouched:
 * `scripts/build.ts` samples the public client values itself.
 * @returns the build's exit code, or null when a signal ended it.
 */
async function runBuild(): Promise<number | null> {
  const invocation = pnpmInvocation(['run', 'build'])
  const result = await execa(invocation.command, invocation.args, { cwd: repoRoot, stdio: 'inherit', reject: false })
  return result.exitCode ?? null
}

const invokedPath = process.argv[1]
const isMain = invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href
if (isMain) {
  let options: DevWebArguments
  try {
    options = parseDevWebArguments(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    console.error('dev-web: usage: pnpm run dev:web [--skip-build] [--no-serve] [--poll[=ms]] [dsh web arguments]')
    process.exit(1)
  }

  // Shutdown is requested once, by a terminal signal or by a stage exiting on
  // its own; `signal` stays unset for SIGINT because the terminal's process
  // group already delivered it to every stage.
  const shutdown = Promise.withResolvers<number>()
  const requested: { code?: number; signal?: NodeJS.Signals } = {}
  const shutdownRequested = (): boolean => requested.code !== undefined
  const requestShutdown = (code: number, signal: NodeJS.Signals | undefined): void => {
    if (shutdownRequested()) return
    requested.code = code
    if (signal !== undefined) requested.signal = signal
    shutdown.resolve(code)
  }
  const supervisor = new StageSupervisor((stage, code) => {
    console.error(`dev-web: ${stage} exited (code ${String(code)}); stopping the other stages`)
    requestShutdown(1, 'SIGTERM')
  })
  // Persistent listeners, not `once`: the tsdown watchers bundle signal-exit,
  // which re-raises a signal whenever it finds no other listener left and would
  // terminate this process in the middle of the teardown below.
  process.on('SIGINT', () => { requestShutdown(130, undefined) })
  process.on('SIGTERM', () => { requestShutdown(0, 'SIGTERM') })

  const buildExit = options.skipBuild ? 0 : await runBuild()
  if (shutdownRequested()) process.exit(await shutdown.promise)
  if (buildExit !== 0) {
    console.error(`dev-web: pnpm run build exited (code ${String(buildExit)})`)
    process.exit(1)
  }

  const buildEnvironment = devWebBuildEnvironment(repoRoot, process.env)
  for (const name of Object.keys(process.env)) {
    if (name === CLIENT_BUILD_PROFILE_SELECTOR || name.startsWith('DSH_CLIENT_')) {
      Reflect.deleteProperty(process.env, name)
    }
  }
  for (const [name, value] of Object.entries(buildEnvironment)) {
    if (name.startsWith('DSH_CLIENT_') && value !== undefined) process.env[name] = value
  }

  const pluginDirs = discoverPluginDirs()
  const libraryDirs = discoverLibraryDirs()
  if (pluginDirs.length === 0) {
    console.error('dev-web: no dsh.client (platform "web") packages found under packages/')
    process.exit(1)
  }
  if (libraryDirs.length === 0) {
    console.error('dev-web: no client-preset library packages found under packages/ — the compile shell links their lib products, so an empty set means the discovery predicate is stale')
    process.exit(1)
  }

  // tsc has no polling interval flag, so `--poll` selects its fixed-interval
  // watchers rather than an interval. Dropping that translation leaves tsc
  // natively watching on a network mount where inotify never fires: it stops
  // re-emitting lib/types, and the two later stages then rebuild forever from
  // stale input without printing anything.
  spawnStage(supervisor, `tsc -b ${CLIENT_TYPE_PROGRAM} --watch`, 'tsc', [
    '-b', CLIENT_TYPE_PROGRAM, '--watch', '--preserveWatchOutput',
    ...options.pollInterval !== undefined
      ? ['--watchFile', 'fixedPollingInterval', '--watchDirectory', 'fixedPollingInterval']
      : [],
  ], true)

  // tsdown's initial builds are awaited before the dist watcher starts so vite's
  // first build reads current lib bundles rather than whatever the last full
  // build left. Its own watch then covers later lib rewrites — those files are
  // in its module graph.
  const bundles = await watchClientPlugins(repoRoot, [...pluginDirs, ...libraryDirs], options.pollInterval)
  if (!shutdownRequested()) {
    // Through the shell's own `watch` script rather than vite's API: vite is not a
    // repository-root dependency, and more importantly the vite root is its
    // working directory — `resolve.dedupe` resolves react from that root, so
    // running vite from anywhere but apps/web silently switches which react copy
    // the bundle gets.
    spawnStage(supervisor, 'vite build --watch', 'pnpm', ['--filter', SHELL_PACKAGE, 'run', 'watch'], false)
    // The same launch vector as the root `dsh` script, so the served Host runs
    // from source exactly as `pnpm dsh web` would.
    if (options.serve) {
      spawnStage(supervisor, 'dsh web', process.execPath, [
        '--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', ...options.appArgs,
      ], false)
    }
    console.log(
      `dev-web: watching ${String(pluginDirs.length)} dsh.client plugin packages`
      + ` and ${String(libraryDirs.length)} statically linked library packages`
      + (options.pollInterval !== undefined ? ` (polling ${String(options.pollInterval)}ms)` : '')
      + `, plus tsc -b ${CLIENT_TYPE_PROGRAM} and the ${SHELL_PACKAGE} dist build`
      + (options.serve ? ', serving through dsh web' : '')
      + ':\n  '
      + [...pluginDirs, ...libraryDirs].join('\n  '),
    )
  }

  const exitCode = await shutdown.promise
  await supervisor.stop({ signal: requested.signal, graceMs: STOP_GRACE_MS })
  for (const bundle of bundles) await bundle[Symbol.asyncDispose]()
  process.exit(exitCode)
}
