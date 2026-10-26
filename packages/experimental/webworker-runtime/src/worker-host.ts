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
 * image, over the profile the image's own app-boot initializes from the shipped
 * template and composes from the bundles the image carries, so profile
 * composition, entry mounting, the activation audit, and its diagnostics are the
 * same code the Node deployment runs. The Worker supplies module loading, the
 * platform overlay, and the command line.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/worker-host
 */
import { setActiveModuleLoader, WorkerModuleLoader, type StaticModuleFactory } from './module-system/module-loader.ts'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import type { HostConnectionHandle, PeerScope } from '@deepseek-ai/dsh-client-connection'
import type { AlsCausality } from './polyfill/async-context/als-runtime.ts'
import { join } from './module-system/posix-path.ts'
import { installProcessGlobal } from './node/globals/process.ts'
import type { RequestListener } from './transport/synthetic-http.ts'
import { TunnelServer, type TunnelPort } from './transport/tunnel.ts'
import { inflateImage, inflateImageStream } from './storage/image-gzip.ts'
import { loadVfsImage, loadVfsOverlay, MemoryVfs } from './storage/memory.ts'
import { setActiveVfs } from './storage/active.ts'
import { setTextViewer } from './shell/process/xdg-open.ts'
import { packPackageAssets } from './package-assets.ts'
import {
  DEFAULT_ROOT, IMAGE_EMPTY_DIRECTORIES, IMAGE_HOME_DIRECTORY, IMAGE_MANIFEST_PATH, LOWERING_VERSION,
} from './image-layout.ts'
import { parseImageManifest, type ImageManifest } from './image-manifest.ts'

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
  logger: { exporter(exporter: LogExporter): unknown }
  get(service: string): unknown
  provide(name: string, value: unknown): void
  plugin(plugin: unknown, config?: unknown): Promise<unknown>
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
  /**
   * Inner arguments the tree parses. The default binds the web server to the
   * loopback authority the tunnel synthesizes.
   */
  readonly cmdlineArgs?: readonly string[]
  /** Port named on the default command line; defaults to {@link DEFAULT_PORT}. */
  readonly port?: number
  /** Environment for the process shim; `DSH_HOME` defaults to `<root>/home`. */
  readonly env?: Readonly<Record<string, string>>
  /**
   * Image manifest path; defaults to `<root>/config/vfs-manifest.json`. Its
   * `lowered` field must name this build's wrapper contract, and its lazy
   * archives resolve against the image URL.
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
  const port = options.port ?? DEFAULT_PORT
  const tunnel = new TunnelServer({
    port: requireGlobalPort(options.channel),
    requestListener: options.requestListener,
    ...options.privilegedMethods === undefined ? {} : { privilegedMethods: options.privilegedMethods },
    ...options.unaryApiLane === undefined ? {} : { unaryApiLane: options.unaryApiLane },
  })
  setTextViewer((path, text) => { tunnel.viewText(path, text) })

  let vfs: MemoryVfs | undefined
  let modules: WorkerModuleLoader | undefined
  let context: HostContext | undefined

  const start = async (): Promise<void> => {
    try {
      const home = join(root, IMAGE_HOME_DIRECTORY)
      const processShim = installProcessGlobal({ cwd: root, env: { DSH_HOME: home, HOME: home, ...options.env } })

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
      const manifest = readImageManifest(mounted, manifestPath)
      deferLazyArchives(mounted, manifest, root, options.image)
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

      const require = loader.requireFrom(root)
      const appBoot = require('@deepseek-ai/dsh-app-boot') as AppBootFace
      const { DSH_LAUNCH_ENVIRONMENT_KEY } = require('@deepseek-ai/dsh-launch-environment') as {
        DSH_LAUNCH_ENVIRONMENT_KEY: string
      }
      const cmdline = require('@deepseek-ai/dsh-cmdline') as {
        provideCmdline(ctx: unknown, host: {
          args: readonly string[]
          exit: (code: number) => void
          ready: { onReady(listener: () => void): () => void }
        }): void
      }
      // Resolved once the tunnel serves; a failed start never resolves it.
      const started = Promise.withResolvers<void>()

      const { patches, profile, environment } = prepareProfile(appBoot, mounted, manifest, root, processShim.env)
      const profileConfig = join(profile.dir, 'cordis.yml')
      const ctx = await appBoot.boot(BIN_NAME, profileConfig, patches, async (hostCtx) => {
        hostCtx.provide('profileContext', profile)
        hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
        installLogSink(hostCtx, require)
        // Package lookup without a runtime resolution: the Worker loader owns
        // module resolution, so only manifest lookup over the image applies.
        await hostCtx.plugin(appBoot.PluginPackages, {})
        cmdline.provideCmdline(hostCtx, {
          args: [...(options.cmdlineArgs ?? ['--host', '127.0.0.1', '--port', String(port), '--no-open'])],
          exit: (code: number) => { console.warn(`webworker host: tree requested exit(${String(code)})`) },
          ready: {
            onReady: (listener) => {
              let pending = true
              void started.promise.then(() => { if (pending) listener() })
              return () => { pending = false }
            },
          },
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
      console.info(`webworker host: tree active (modules=${String(usage.modules)}, data overlays=${String(overlays.length)}, lazy archives=${String(manifest.lazy.length)}, direct lane=connection.createSharedFetchHandler, als causality=${options.alsCausality === undefined ? 'inert' : 'snapshot/restore'}, image lowering=${LOWERING_VERSION})`)

      // The worker tree serves only the page that spawned it, so every call speaks for the browser Peer.
      const peer = connection.browserPeer
      tunnel.serve({
        directFetch: (request: Request) => handler.fetch(request, peer),
        bootPayload: () => readBootPayload(ctx, peer),
        packageAssets: () => packPackageAssets(mounted, root),
        openStream: (endpoint, payload, uplink, signal) =>
          typertGateway.wireStream.open(endpoint, payload, uplink, peer, signal),
        streamFailure: typertGateway.wireStream.failure,
      })
      started.resolve()
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

/** Diagnostic prefix the launcher passes to app-boot; the Worker boots the same profile code. */
const BIN_NAME = 'dsh'

/** The app-boot members the Worker boots the tree with, as the image's own app-boot exports them. */
interface AppBootFace {
  boot(
    binName: string,
    configPath: string,
    patches: unknown[],
    prepare: (ctx: HostContext) => Promise<void>,
  ): Promise<HostContext>
  loadProfile(binName: string, name: string, installAnchor: string, home: string): LoadedProfile
  reportSkippedBundles(binName: string, profile: LoadedProfile): void
  readProfilePatches(binName: string, context: ProfileContext, initialProfile: LoadedProfile): unknown[]
  loadLayeredEnv(binName: string, cwd: string): unknown
  PluginPackages: unknown
}

/** The loaded-profile fields the Worker reads; app-boot's `Profile`. */
interface LoadedProfile {
  readonly name: string
  readonly dir: string
  readonly patchPath: string
  readonly layers: readonly { readonly packageName: string }[]
}

/**
 * Read and validate the mounted image's manifest.
 *
 * The manifest the packer writes is the single source of truth: the worker holds
 * no transform, so an image that was never lowered — or was lowered against
 * different wrapper semantics — cannot be recovered at load and must be rebuilt.
 * @param vfs - Mounted filesystem.
 * @param path - Manifest path inside the image.
 * @returns The validated manifest.
 * @throws When the manifest is missing, malformed, or names another contract.
 */
function readImageManifest(vfs: MemoryVfs, path: string): ImageManifest {
  if (!vfs.existsSync(path)) {
    throw new Error(`webworker host: ${path} is missing, so the image records no lowering; rebuild the image`)
  }
  return parseImageManifest(JSON.parse(vfs.readFileSync(path, 'utf8') as string), path)
}

/**
 * Register the manifest's lazy archives; each is fetched beside the image on
 * the first asynchronous read of a file it carries.
 * @param vfs - Mounted filesystem.
 * @param manifest - Validated image manifest.
 * @param root - Virtual root the archives' entries mount under.
 * @param image - The image bytes or URL; archive names resolve against a URL.
 * @throws When the image registers lazy archives but arrived as bytes, leaving them unlocatable.
 */
function deferLazyArchives(vfs: MemoryVfs, manifest: ImageManifest, root: string, image: Uint8Array | string): void {
  if (manifest.lazy.length === 0) return
  if (typeof image !== 'string') {
    throw new Error('webworker host: the image registers lazy archives, which only an image fetched from a URL can locate')
  }
  const base = new URL(image, (globalThis as { location?: { href: string } }).location?.href)
  for (const archive of manifest.lazy) {
    const url = new URL(archive.archive, base).href
    vfs.deferArchive({ name: archive.archive, root, files: archive.files, load: () => readImage(url) })
  }
}

/**
 * Prepare the profile the served launcher would boot: the image's app-boot
 * initializes the manifest's shipped profile template under the Worker home
 * and composes its bundle layers, user layer, and home layer. The profile
 * context carries the launcher's facts with no command-line overlay; the
 * image's home patch, written by the packer, carries the Worker's required
 * row config (`PLATFORM_ENTRY_CONFIG` in `image-layout.ts`).
 * @param appBoot - The image's app-boot.
 * @param vfs - Filesystem holding the profile.
 * @param manifest - Validated image manifest naming the profile and installation.
 * @param root - Virtual root, the process working directory.
 * @param env - The process shim's environment, after the launch layers applied.
 * @returns Effective boot patches, the profile context, and the launch environment snapshot.
 * @throws When the image names no installation manifest to anchor bundle resolution.
 */
function prepareProfile(
  appBoot: AppBootFace,
  vfs: MemoryVfs,
  manifest: ImageManifest,
  root: string,
  env: Readonly<Record<string, string>>,
): { patches: unknown[]; profile: ProfileContext; environment: unknown } {
  if (manifest.installation === undefined) {
    throw new Error('webworker host: the image names no installation manifest, so no profile bundle can resolve; rebuild the image')
  }
  const home = join(root, IMAGE_HOME_DIRECTORY)
  const installAnchor = join(root, 'node_modules', manifest.installation, 'package.json')
  const environment = appBoot.loadLayeredEnv(BIN_NAME, root)
  const loaded = appBoot.loadProfile(BIN_NAME, manifest.profile, installAnchor, home)
  appBoot.reportSkippedBundles(BIN_NAME, loaded)
  // The empty root list the include anchors at; the launcher rewrites it on every boot.
  vfs.writeFileSync(join(loaded.dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: loaded.name, dir: loaded.dir, patchPath: loaded.patchPath, installAnchor, cwd: root, home,
    startedBundles: loaded.layers.map(layer => layer.packageName),
    overlays: [], telemetryDisabledEnv: env.DSH_TELEMETRY_DISABLED,
  }
  return { patches: appBoot.readProfilePatches(BIN_NAME, profile, loaded), profile, environment }
}

/**
 * Assemble the payload the page's pre-Cordis bootstrap needs: the structured
 * index injection table the served form renders into index.html. Collected
 * from the in-process webserver service, never from the API surface, because
 * the page has no Cordis tree yet.
 * @param ctx - Booted host context.
 * @param peer - the browser Peer the page speaks for.
 * @returns Boot payload for `GET /__boot__`.
 */
function readBootPayload(ctx: HostContext, peer: PeerScope): { injections: unknown } {
  const webServer = ctx.get('webServer') as { collectIndexInjections(peer: PeerScope): unknown } | undefined
  if (webServer === undefined) {
    throw new Error('webworker host: no webServer service, so the page cannot receive its boot injections')
  }
  return { injections: webServer.collectIndexInjections(peer) }
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
