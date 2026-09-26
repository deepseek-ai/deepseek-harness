/**
 * Worker assembly entry: the whole harness Cordis tree inside one dedicated
 * Web Worker.
 *
 * Every platform object arrives through options — the `node:*` proxy table, the
 * request listener the app's fake `node:http` captured, the image bytes — so this
 * package never reaches back into the application that composes it. **Platform
 * readiness before the call is the caller's responsibility**: anything the
 * proxies need initialized (the zstd WebAssembly module, for one) must be ready
 * before {@link startWorkerHost} runs.
 *
 * Construction is split in two on purpose. {@link createWorkerHost} is
 * synchronous so the worker can accept messages and queue requests that arrive
 * during boot; {@link WorkerHost.start} then mounts the image, the module
 * loader, and the tree. {@link startWorkerHost} performs both and installs the
 * message handler before its first await.
 *
 * The tree itself boots through the host's own `boot()` glue loaded from the
 * image, so entry mounting, the activation audit, and its diagnostics are the
 * same code the Node deployment runs. The Worker supplies module loading,
 * profile locations, and the command line.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/worker-host
 */
import { setActiveModuleLoader, WorkerModuleLoader, type StaticModuleFactory } from './module-system/module-loader.ts'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { AlsCausality } from './polyfill/async-context/als-runtime.ts'
import { dirname, join } from './module-system/posix-path.ts'
import { installProcessGlobal } from './node/globals/process.ts'
import type { RequestListener } from './transport/synthetic-http.ts'
import { TunnelServer, type TunnelPort } from './transport/tunnel.ts'
import { inflateImage, inflateImageStream } from './storage/image-gzip.ts'
import { loadVfsImage, loadVfsOverlay, MemoryVfs } from './storage/memory.ts'
import { setActiveVfs } from './storage/active.ts'
import {
  DEFAULT_ROOT, IMAGE_CONFIG_PATH, IMAGE_EMPTY_DIRECTORIES, IMAGE_HOME_DIRECTORY, IMAGE_MANIFEST_PATH,
  LOWERING_VERSION,
} from './image-layout.ts'

export { DEFAULT_ROOT } from './image-layout.ts'

/** Port reported to the tree when the caller names none; the bind is fake either way. */
export const DEFAULT_PORT = 3080

// Every literal `require`/`resolve` of an image package below must appear in
// the packer's IMAGE_ENTRY_SEEDS: no image file references these requests, so
// the reachability sweep only keeps them when seeded.

/** One structured log record, as cordis delivers it to an exporter. */
export interface LogMessage {
  readonly name: string
  readonly type: 'error' | 'info' | 'warn' | 'debug'
  readonly args: readonly unknown[]
}

/** The exporter face `ctx.logger.exporter()` accepts. */
export interface LogExporter {
  readonly colors: false
  /** Verbosity gate, per logger name or `default`; cordis drops a message when its level exceeds this. */
  readonly levels: { readonly default: number }
  export(message: LogMessage): void
}

/** Minimal view of the Cordis context the entry itself touches. */
export interface HostContext {
  loader: { internal: unknown }
  logger: { exporter(exporter: LogExporter): unknown }
  get(service: string): unknown
  provide(name: string, value: unknown): void
  fiber: { dispose(): Promise<void> }
}

/** Construction inputs for {@link createWorkerHost}. */
export interface WorkerHostOptions {
  /**
   * Modules served from the worker bundle rather than the image: the `node:*`
   * proxies, the not-implemented stubs for excluded npm packages, and anything else whose
   * platform behavior differs. `node:process` and `process` are added when absent,
   * as factories reading the installed global.
   */
  readonly staticModules: Readonly<Record<string, StaticModuleFactory>>
  /** Prefix-matched proxies, for packages whose subpaths are open-ended. */
  readonly staticModulePrefixes?: Readonly<Record<string, StaticModuleFactory>>
  /**
   * The webserver's request listener, captured by the app's fake `node:http`.
   * Awaited on first tunnel use, so it may resolve after the tree binds.
   */
  readonly requestListener: () => Promise<RequestListener>
  /** Image bytes, or the URL the worker fetches them from. */
  readonly image: Uint8Array | string
  /** Ordered data overlays applied after the base image and before boot. */
  readonly overlays?: readonly (Uint8Array | string)[]
  /** Virtual root; defaults to {@link DEFAULT_ROOT}. */
  readonly root?: string
  /** Composed configuration inside the image; defaults to `<root>/config/cordis.yml`. */
  readonly configPath?: string
  /**
   * Inner arguments the tree parses. The default binds the web server to the
   * loopback authority the tunnel synthesizes, which also keeps
   * `networkInterfaces()` out of the trust snapshot.
   */
  readonly cmdlineArgs?: readonly string[]
  /** Port named on the default command line; defaults to {@link DEFAULT_PORT}. */
  readonly port?: number
  /** Environment for the process shim; `DSH_HOME` defaults to `<root>/home`. */
  readonly env?: Readonly<Record<string, string>>
  /**
   * Image manifest path; defaults to `<root>/config/vfs-manifest.json`. Its
   * `lowered` field must name this build's wrapper contract.
   */
  readonly manifestPath?: string
  /**
   * Ambient-store snapshot face exported by the app's `node:async_hooks` proxy.
   * The rewrite that carries stores across suspension points moves state through
   * it; the proxy remains the only owner of that state.
   */
  readonly alsCausality?: AlsCausality
  /** Privileged API methods that skip the route lane; see {@link TunnelServer}. */
  readonly privilegedMethods?: ReadonlySet<string>
  /** Escape hatch for the unary `/api` lane; see {@link TunnelServer}. */
  readonly unaryApiLane?: 'route' | 'direct'
  /** Channel back to the page; defaults to the worker global scope. */
  readonly channel?: TunnelPort
}

/** The assembled worker host. */
export interface WorkerHost {
  /** Feed one `postMessage` payload; safe before {@link WorkerHost.start}. */
  handleMessage(data: unknown): void
  /**
   * Mount the image and boot the tree, then start serving queued requests.
   * @returns Resolves once the tree is active and the tunnel is serving.
   */
  start(): Promise<void>
  /** Dispose the tree; the tunnel keeps refusing afterwards. */
  stop(): Promise<void>
  /** Filesystem the tree reads, once {@link WorkerHost.start} mounted it. */
  readonly vfs: MemoryVfs | undefined
  /** Module loader behind the Cordis module seam. */
  readonly modules: WorkerModuleLoader | undefined
}

function requireGlobalPort(channel: TunnelPort | undefined): TunnelPort {
  if (channel !== undefined) return channel
  const scope = globalThis as { postMessage?: TunnelPort['postMessage'] }
  const post = scope.postMessage
  if (typeof post !== 'function') {
    throw new Error('webworker host: no channel; pass options.channel outside a dedicated worker')
  }
  return { postMessage: (message, transfer) => { post(message, transfer) } }
}

async function readImage(image: Uint8Array | string): Promise<Uint8Array> {
  if (typeof image !== 'string') return await inflateImage(image, 'the image bytes given to createWorkerHost')
  const response = await fetch(image)
  if (!response.ok) throw new Error(`webworker host: image fetch failed with ${String(response.status)} for ${image}`)
  if (response.body === null) throw new Error(`webworker host: image response for ${image} carried no body`)
  // Inflated off the response stream: the archive is built while the rest of the
  // image is still arriving.
  return await inflateImageStream(response.body, image)
}

/**
 * Build the worker host without touching the network or the image.
 * @param options - Assembly inputs.
 * @returns Handle whose `handleMessage` is ready immediately.
 */
export function createWorkerHost(options: WorkerHostOptions): WorkerHost {
  const root = options.root ?? DEFAULT_ROOT
  const configPath = options.configPath ?? join(root, IMAGE_CONFIG_PATH)
  const port = options.port ?? DEFAULT_PORT
  const tunnel = new TunnelServer({
    port: requireGlobalPort(options.channel),
    requestListener: options.requestListener,
    ...options.privilegedMethods === undefined ? {} : { privilegedMethods: options.privilegedMethods },
    ...options.unaryApiLane === undefined ? {} : { unaryApiLane: options.unaryApiLane },
  })

  let vfs: MemoryVfs | undefined
  let modules: WorkerModuleLoader | undefined
  let context: HostContext | undefined

  const start = async (): Promise<void> => {
    try {
      const home = join(root, IMAGE_HOME_DIRECTORY)
      installProcessGlobal({ cwd: root, env: { DSH_HOME: home, HOME: home, ...options.env } })

      const [bytes, overlays] = await Promise.all([
        readImage(options.image),
        Promise.all((options.overlays ?? []).map(readImage)),
      ])
      const mounted = loadVfsImage(bytes, root)
      for (const overlay of overlays) loadVfsOverlay(overlay, root, mounted)
      // Belt and braces over the image's own empty-directory entries: a hand
      // -built image without them still boots.
      for (const directory of IMAGE_EMPTY_DIRECTORIES) {
        mounted.seedDirectory(join(root, directory.replace(/\/$/, '')))
      }
      setActiveVfs(mounted)
      vfs = mounted

      const manifestPath = options.manifestPath ?? join(root, IMAGE_MANIFEST_PATH)
      requireLoweredImage(mounted, manifestPath)
      const staticModules: Record<string, StaticModuleFactory> = { ...options.staticModules }
      // Read at require time, not here: the table entry then answers whichever
      // global `installProcessGlobal` left in place, in this role's order.
      for (const key of ['node:process', 'process']) {
        staticModules[key] ??= (): unknown => (globalThis as { process?: unknown }).process
      }
      const loader = new WorkerModuleLoader({
        vfs: mounted,
        root,
        staticModules,
        ...options.staticModulePrefixes === undefined ? {} : { staticModulePrefixes: options.staticModulePrefixes },
        ...options.alsCausality === undefined ? {} : { alsCausality: options.alsCausality },
      })
      setActiveModuleLoader(loader)
      modules = loader

      const require = loader.requireFrom(dirname(configPath))
      const appBoot = require('@deepseek-ai/dsh-app-boot') as {
        boot(
          binName: string,
          configPath: string,
          patches: unknown[],
          prepare: (ctx: HostContext) => void,
        ): Promise<HostContext>
      }
      const cmdline = require('@deepseek-ai/dsh-cmdline') as {
        provideCmdline(ctx: unknown, host: { args: readonly string[]; exit: (code: number) => void }): void
      }

      const { patches, profile } = bootPatches(loader, mounted, configPath, root)
      const profileConfig = join(profile.dir, 'cordis.yml')
      const ctx = await appBoot.boot('dsh-webworker', profileConfig, patches, (hostCtx) => {
        hostCtx.provide('profileContext', profile)
        // Before any entry mounts: the Loader would otherwise fall back to the
        // runtime's own dynamic import for every row.
        hostCtx.loader.internal = loader.internal
        installLogSink(hostCtx, require)
        cmdline.provideCmdline(hostCtx, {
          args: [...(options.cmdlineArgs ?? ['--host', '127.0.0.1', '--port', String(port), '--no-open'])],
          exit: (code: number) => { console.warn(`webworker host: tree requested exit(${String(code)})`) },
        })
      })
      context = ctx

      const connection = ctx.get('connection') as HostConnectionHandle | undefined
      if (connection === undefined) throw new Error('webworker host: the tree activated without a Connection service')
      const typertGateway = ctx.get('typertGateway') as TypertGateway | undefined
      if (typertGateway === undefined) {
        throw new Error('webworker host: the tree activated without a typertGateway service')
      }
      const handler = connection.createSharedFetchHandler('/api')
      const usage = loader.usage()
      console.info(`webworker host: tree active (modules=${String(usage.modules)}, data overlays=${String(overlays.length)}, direct lane=connection.createSharedFetchHandler, als causality=${options.alsCausality === undefined ? 'inert' : 'snapshot/restore'}, image lowering=${LOWERING_VERSION})`)

      tunnel.serve({
        directFetch: (request: Request) => handler.fetch(request),
        bootPayload: () => readBootPayload(ctx),
        // The worker tree serves its own page: every stream speaks for the operator.
        openStream: (endpoint, payload, uplink, signal) =>
          typertGateway.wireStream.open(endpoint, payload, uplink, undefined, signal),
        streamFailure: typertGateway.wireStream.failure,
      })
    } catch (reason) {
      tunnel.fail(reason)
      throw reason
    }
  }

  return {
    handleMessage: (data: unknown): void => { tunnel.handleMessage(data) },
    start,
    stop: async (): Promise<void> => {
      tunnel.fail(new Error('webworker host: the tree was disposed'))
      await context?.fiber.dispose()
    },
    get vfs(): MemoryVfs | undefined {
      return vfs
    },
    get modules(): WorkerModuleLoader | undefined {
      return modules
    },
  }
}

/** The cordis message renderer this sink formats through. */
export interface LogRenderer {
  format(exporter: LogExporter, message: LogMessage): string
}

/**
 * Send the tree's own warnings and errors to the worker console.
 *
 * Cordis's `LoggerService` always exists and always accepts messages, but with
 * no exporter mounted it only fills a ring buffer — and no profile in this
 * repository mounts one, so `ctx.logger.warn(...)` reaches nothing. A provider
 * that fails and is skipped (the skill registry logs exactly that) then looks
 * identical to one that found nothing, which is how an empty skill catalog hid a
 * filesystem fault twice.
 *
 * Warnings and errors only: `info`/`debug` from 131 plugin rows would bury the
 * page console, and this exists to make failures visible rather than to trace.
 * @param ctx - Host context, before any entry mounts.
 * @param require - Image resolver, for cordis's own message renderer.
 */
export function installLogSink(ctx: HostContext, require: (specifier: string) => unknown): void {
  const { Logger } = require('@deepseek-ai/cordis') as { Logger: LogRenderer }
  const exporter: LogExporter = {
    colors: false,
    // cordis compares `exporter.levels ?? logger.level ?? INFO` against the
    // message level and drops anything higher, and its scale counts UP with
    // verbosity (ERROR 0, INFO 1, WARN 2, DEBUG 3). An exporter that declares no
    // level therefore admits errors and info but silently drops every warning —
    // which is what the built-in ring-buffer exporter does, so the skipped-provider
    // warning this sink exists for never even reached the buffer.
    levels: { default: 2 },
    export: (message) => {
      if (message.type !== 'warn' && message.type !== 'error') return
      const line = `${message.name}: ${Logger.format(exporter, message)}`
      if (message.type === 'error') console.error(line)
      else console.warn(line)
    },
  }
  ctx.logger.exporter(exporter)
}

/**
 * Require the mounted image to carry bodies this build can wrap.
 *
 * The manifest the packer writes is the single source of truth: the worker holds
 * no transform, so an image that was never lowered — or was lowered against
 * different wrapper semantics — cannot be recovered at load and must be rebuilt.
 * @param vfs - Mounted filesystem.
 * @param path - Manifest path inside the image.
 * @throws When the manifest is missing, unreadable, or names another contract.
 */
function requireLoweredImage(vfs: MemoryVfs, path: string): void {
  if (!vfs.existsSync(path)) {
    throw new Error(`webworker host: ${path} is missing, so the image records no lowering; rebuild the image`)
  }
  const parsed: unknown = JSON.parse(vfs.readFileSync(path, 'utf8') as string)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`webworker host: ${path} does not hold an object`)
  }
  const lowered = (parsed as { lowered?: unknown }).lowered
  if (lowered !== LOWERING_VERSION) {
    throw new Error(`webworker host: image was lowered by ${String(lowered)}, this build runs ${LOWERING_VERSION}; rebuild the image`)
  }
}

/**
 * Prepare an editable VFS profile from the packed rows and deployment overlays.
 * ConfigEditor writes overrides beside the insertion rows; reconciliation starts
 * at the empty profile root and retains the Worker deployment overlays.
 * @param loader - Module loader, for the image's YAML reader.
 * @param vfs - Filesystem holding the composed configuration.
 * @param configPath - Composed configuration path.
 * @param root - Virtual root.
 * @returns Profile locations and effective boot patches.
 */
function bootPatches(
  loader: WorkerModuleLoader,
  vfs: MemoryVfs,
  configPath: string,
  root: string,
): { patches: unknown[]; profile: ProfileContext } {
  const text = vfs.readFileSync(configPath, 'utf8') as string
  const include = loader.load(loader.resolve('@deepseek-ai/cordis-plugin-include', root)) as { entryListSchema: unknown }
  const yaml = loader.load(loader.resolve('js-yaml', root)) as {
    load(source: string, options: { schema: unknown }): unknown
    dump(value: unknown, options: { schema: unknown }): string
  }
  let rows: unknown
  if (configPath.endsWith('.json')) {
    rows = JSON.parse(text)
  } else {
    // The roster's `!!js` scalars need Include's own YAML dialect.
    rows = yaml.load(text, { schema: include.entryListSchema })
  }
  const find = (entries: unknown, id: string): Record<string, unknown> | undefined => {
    if (!Array.isArray(entries)) return undefined
    for (const entry of entries as Array<Record<string, unknown>>) {
      if (entry.id === id) return entry
      const nested = find(entry.config, id)
      if (nested !== undefined) return nested
    }
    return undefined
  }
  const configOf = (row: Record<string, unknown>): Record<string, unknown> =>
    (typeof row.config === 'object' && row.config !== null && !Array.isArray(row.config)
      ? row.config
      : {}) as Record<string, unknown>

  const patches: Array<ProfileContext['overlays'][number]> = []
  // The image has no package manager or Node module-reload cache. ConfigEditor
  // reconciles writes directly; Loader commits accepted live values.
  for (const id of ['hmr', 'plugin-manager']) {
    if (find(rows, id) !== undefined) patches.push({ id, disabled: true })
  }
  // The worker carries no compression codec, and the VFS is in-memory anyway:
  // the JSONL backend's plaintext path is the composition's one legal encoding.
  const jsonl = find(rows, 'session-persistence-jsonl')
  if (jsonl !== undefined) {
    patches.push({ id: 'session-persistence-jsonl', config: { ...configOf(jsonl), compression: 'none' } })
  }
  const dir = join(root, IMAGE_HOME_DIRECTORY, 'profiles/preview')
  const profile: ProfileContext = {
    name: 'preview', dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(dir, 'package.json'), cwd: root,
    home: join(root, IMAGE_HOME_DIRECTORY), startedBundles: [],
    overlays: patches, telemetryDisabledEnv: undefined,
  }
  vfs.seed(join(dir, 'package.json'), '{"private":true,"dsh":{"profile":{"bundles":[]}}}\n')
  vfs.seed(join(dir, 'cordis.yml'), '[]\n')
  if (!vfs.existsSync(profile.patchPath)) {
    vfs.seed(profile.patchPath, yaml.dump([{ insert: rows }], { schema: include.entryListSchema }))
  }
  const appBoot = loader.load(loader.resolve('@deepseek-ai/dsh-app-boot', root)) as {
    readProfilePatches(binName: string, profile: ProfileContext): unknown[]
  }
  return { patches: appBoot.readProfilePatches('dsh-webworker', profile), profile }
}

/**
 * Assemble the payload the page's pre-Cordis bootstrap needs: the structured
 * index injection table the served form renders into index.html. Collected
 * from the in-process webserver service, never from the API surface, because
 * the page has no Cordis tree yet.
 * @param ctx - Booted host context.
 * @returns Boot payload for `GET /__boot__`.
 */
function readBootPayload(ctx: HostContext): { injections: unknown } {
  const webServer = ctx.get('webServer') as { collectIndexInjections(): unknown } | undefined
  if (webServer === undefined) {
    throw new Error('webworker host: no webServer service, so the page cannot receive its boot injections')
  }
  return { injections: webServer.collectIndexInjections() }
}

/**
 * Install the message handler and boot the tree.
 *
 * The handler is attached before the first await, so requests that arrive
 * during boot queue instead of being dropped. A boot failure refuses the queue
 * with 503 and rejects.
 * @param options - Assembly inputs; `channel` also replaces the message source.
 * @returns Resolves once the tunnel is serving.
 */
export async function startWorkerHost(options: WorkerHostOptions): Promise<void> {
  const host = createWorkerHost(options)
  if (options.channel === undefined) {
    const scope = globalThis as { addEventListener?: (type: string, listener: (event: MessageEvent) => void) => void }
    if (typeof scope.addEventListener !== 'function') {
      throw new Error('webworker host: no message source; pass options.channel outside a dedicated worker')
    }
    scope.addEventListener('message', (event: MessageEvent) => { host.handleMessage(event.data) })
  }
  await host.start()
}
