/**
 * Page half: everything a deployment needs to reach a worker-hosted harness.
 *
 * This is **pre-Cordis glue, not a client plugin**: it installs the transport
 * global and executes the boot injection table that the client plugin graph
 * is later loaded through, so it cannot itself be a graph row. A page imports
 * it directly and decides where the worker bundle and image live; nothing
 * here mounts into a shipped roster.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/client
 */
import { IMAGE_FILE_NAME } from '../image-layout.ts'
import type { ClientFileUploadHooks } from '@deepseek-ai/dsh-client-file-upload/types'
import { PREVIEW_FIXTURE_MANIFEST_FILE } from '../fixture-manifest.ts'
import { WorkerTunnel, type TunnelFetch } from './client.ts'
import { applyIndexInjections } from './apply-injections.ts'
import { choosePreviewSource } from './source-chooser.ts'

export { WorkerTunnel, type TunnelFetch } from './client.ts'
export { applyIndexInjections } from './apply-injections.ts'
export { IMAGE_FILE_NAME } from '../image-layout.ts'
export {
  parsePreviewFixtureManifest, PREVIEW_FIXTURE_MANIFEST_FILE, PREVIEW_FIXTURE_MANIFEST_VERSION,
  type PreviewFixtureManifest, type PreviewFixtureManifestEntry,
} from '../fixture-manifest.ts'

/** Transport global the connection plugin reads instead of building an HTTP carrier. */
interface ClientTransportGlobal {
  __DSH_TRANSPORT__?: {
    fetch: TunnelFetch
    openStream: (endpoint: string, payload: unknown, signal: AbortSignal) => AsyncIterable<unknown>
    loadBundle: (url: string) => Promise<void>
    /** The page spawned the worker the Host runs in, so the page owns it. */
    ownsHost: boolean
  }
}

/** Upload hook consumed by the independent Client file-upload service. */
interface ClientFileUploadGlobal {
  __DSH_FILE_UPLOAD__?: ClientFileUploadHooks
}

/** Inputs for {@link connectWorkerHost}. */
export interface WorkerHostConnectOptions {
  /**
   * VFS image URL, the one deployment-shaped input. Defaults to
   * {@link IMAGE_FILE_NAME} beside the page; a deployment that packs the
   * image elsewhere passes its own URL. Data overlays are independent.
   */
  readonly image?: string | URL
  /** Ordered data overlay URLs, resolved against the page like the base image. */
  readonly overlays?: readonly (string | URL)[]
}

/** Inputs for the optional pre-boot filesystem-source chooser. */
export interface WorkerHostSourceOptions {
  /** Base VFS image URL; defaults to {@link IMAGE_FILE_NAME} beside the page. */
  readonly image?: string | URL
  /** Fixture catalog URL; defaults to {@link PREVIEW_FIXTURE_MANIFEST_FILE} beside the image. */
  readonly fixtureManifest?: string | URL
}

/** Filesystem inputs selected before {@link connectWorkerHost}. */
export interface WorkerHostSource {
  /** Ordered data overlays to pass through unchanged to the Host connection. */
  readonly overlays: readonly URL[]
}

/** A page connected to a worker-hosted harness, ready to run a shell entry. */
export interface WorkerHostConnection {
  readonly worker: Worker
  readonly tunnel: WorkerTunnel
  /** Bundle transport for the shell's boot seam. */
  loadBundle(url: string): Promise<void>
}

/** Boot-readiness deferred shared with the client entry's pre-boot await. */
interface BootReadyGlobal {
  __DSH_BOOT_READY__?: PromiseWithResolvers<void>
}

function bootReadyGate(): PromiseWithResolvers<void> {
  return (globalThis as BootReadyGlobal).__DSH_BOOT_READY__ ??= Promise.withResolvers<void>()
}

/**
 * Install the page boot barrier before an asynchronous source chooser waits
 * for user input. The later {@link connectWorkerHost} call settles the same
 * barrier.
 */
function holdWorkerHostBoot(): void {
  const ready = bootReadyGate()
  // A chooser may remain open indefinitely; if a later connection fails before
  // the stock entry subscribes, retain the rejection without browser noise.
  void ready.promise.catch(() => {})
}

/**
 * Run the optional pre-boot source-selection stage. Calling this stage holds
 * the stock shell until the caller passes its result to {@link connectWorkerHost};
 * callers that need no chooser call `connectWorkerHost` directly and receive
 * the base image with an empty overlay list.
 * @param options - Base image and optional fixture-catalog locations.
 * @returns The ordered overlays selected by the user.
 */
export async function chooseWorkerHostSource(
  options: WorkerHostSourceOptions = {},
): Promise<WorkerHostSource> {
  holdWorkerHostBoot()
  const image = new URL(options.image ?? IMAGE_FILE_NAME, document.baseURI)
  const manifest = new URL(options.fixtureManifest ?? PREVIEW_FIXTURE_MANIFEST_FILE, image)
  try {
    const overlays = await choosePreviewSource(manifest)
    return { overlays }
  } catch (reason) {
    bootReadyGate().reject(reason)
    throw reason
  }
}

/**
 * Connect a spawned host worker and complete the pre-Cordis handshake.
 *
 * The caller constructs the Worker so its bundler resolves the bundle URL
 * statically; the opening `init` frame then carries the base image and ordered
 * overlay locations.
 *
 * Order is fixed by the web boot protocol: the transport global must exist
 * before any bundle executes; the injection table then reproduces the served
 * boot rows — the `__ModuleLoader__` registration queue, the parser-preload
 * bundles, `__DSH_BOOT__`, the theme bootstrap — in table order. The
 * boot-readiness deferred (`__DSH_BOOT_READY__`) is installed before the
 * first await and settles with the handshake, so a client entry evaluating
 * concurrently in the same document holds at its pre-boot await until every
 * row has taken effect, and surfaces a failed handshake instead of
 * proceeding on missing globals.
 * @param worker - The host worker.
 * @param options - Base-image and overlay location overrides.
 * @returns The connection; hand `loadBundle` to the shell entry's boot seam.
 */
export async function connectWorkerHost(worker: Worker, options?: WorkerHostConnectOptions): Promise<WorkerHostConnection> {
  const ready = bootReadyGate()
  // The handshake may fail before any entry awaits the promise; this no-op
  // subscription keeps that from surfacing as an unhandled rejection.
  void ready.promise.catch(() => {})
  try {
    const tunnel = new WorkerTunnel(worker)
    tunnel.init(
      new URL(options?.image ?? IMAGE_FILE_NAME, document.baseURI).href,
      (options?.overlays ?? []).map(overlay => new URL(overlay, document.baseURI).href),
    )
    const payload = await tunnel.bootPayload()
    ;(globalThis as ClientTransportGlobal).__DSH_TRANSPORT__ = {
      fetch: (input, init) => tunnel.fetch(input, init),
      openStream: (endpoint, payload, signal) => tunnel.open(endpoint, payload, signal),
      loadBundle: (url: string) => tunnel.loadBundle(url),
      // The host lives in a worker this page spawned: the page owns it, so
      // the privileged surface stays reachable off loopback authorities.
      ownsHost: true,
    }
    ;(globalThis as ClientFileUploadGlobal).__DSH_FILE_UPLOAD__ = {
      fetch: (input, init) => tunnel.fetch(input, init),
    }
    await applyIndexInjections(payload.injections, src => tunnel.loadBundle(src))
    ready.resolve()
    return { worker, tunnel, loadBundle: (url: string) => tunnel.loadBundle(url) }
  } catch (reason) {
    ready.reject(reason)
    throw reason
  }
}
