/**
 * Browser-only host runtime: the harness Cordis tree inside a dedicated Web Worker.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime
 */
export {
  createAlsRuntime,
  type AlsCausality, type AlsRuntime, type AlsSnapshot, type AlsToken,
} from './polyfill/async-context/als-runtime.ts'
export {
  parseInboundFrame,
  type TunnelAbortFrame, type TunnelInboundFrame, type TunnelOutboundFrame, type TunnelRequestFrame,
  type TunnelRequestId, type TunnelResponseChunkFrame, type TunnelResponseEndFrame,
  type TunnelResponseErrorFrame, type TunnelResponseFrame, type TunnelResponseHeadFrame,
  type TunnelStreamEndFrame, type TunnelStreamErrorFrame, type TunnelStreamUplinkEndFrame,
  type TunnelStreamUplinkItemFrame, type TunnelStreamItemFrame, type TunnelStreamOpenFrame,
} from './transport/frames.ts'
export {
  DEFAULT_CONDITIONS, requireActiveModuleLoader, setActiveModuleLoader, WorkerModuleLoader,
  type Resolution, type StaticModuleFactory, type WorkerModuleLoaderOptions, type WorkerRequire,
} from './module-system/module-loader.ts'
export * as posixPath from './module-system/posix-path.ts'
export { MODULE_PROXIES, MODULE_PROXY_PREFIXES } from './module-proxies.ts'
export { REPLACED_EXTERNAL_PACKAGES } from './node/external_packages/replaced-externals.ts'
export {
  createSyntheticExchange,
  type RequestListener, type ResponseSink, type SyntheticExchange,
} from './transport/synthetic-http.ts'
export { lowerModuleSource, type LoweredModule } from './compile/transform.ts'
export {
  API_PREFIX, SYNTHETIC_HOST, TunnelServer,
  type TunnelPort, type TunnelSeams, type TunnelServerOptions,
} from './transport/tunnel.ts'
export { installProcessGlobal, type ProcessShim, type ProcessShimOptions } from './node/globals/process.ts'
export {
  createWorkerHost, type WorkerHost, type WorkerHostOptions,
} from './worker-host.ts'
export {
  DEFAULT_ROOT, IMAGE_CONFIG_PATH, IMAGE_EMPTY_DIRECTORIES, IMAGE_FILE_NAME, IMAGE_HOME_DIRECTORY,
  IMAGE_MANIFEST_PATH, IMAGE_OVERLAY_DIRECTORIES, LOWERING_VERSION, WRAPPER_PARAMS,
} from './image-layout.ts'
export {
  parsePreviewFixtureManifest, PREVIEW_FIXTURE_MANIFEST_FILE, PREVIEW_FIXTURE_MANIFEST_VERSION,
  type PreviewFixtureManifest, type PreviewFixtureManifestEntry,
} from './fixture-manifest.ts'
export { loadVfsImage, loadVfsOverlay, MemoryVfs } from './storage/memory.ts'
export { inflateImage, inflateImageStream } from './storage/image-gzip.ts'
export { packTar, parseTar, type TarEntry } from './storage/tar.ts'
export { requireActiveVfs, setActiveVfs } from './storage/active.ts'
export {
  type VfsDir, type VfsDirent, type VfsEncoding, type VfsError, type VfsFileHandle,
  type VfsReadOptions, type VfsStats, type VfsWriteOptions,
} from './storage/types.ts'
