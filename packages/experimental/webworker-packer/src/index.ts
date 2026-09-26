/**
 * Build-time packer for the browser runtime's VFS image.
 * @module @deepseek-ai/dsh-experimental-webworker-packer
 */
export {
  WRAPPER_CONTRACT,
  type ImageFiles, type TransformOutcome,
} from './transform-image.ts'
export {
  CONFIG_PATH, DEFAULT_ROOT, MANIFEST_PATH, packVfsImage, packVfsOverlay,
  type ConfigTree, type ImageTree, type PackOptions, type PackOverlayResult, type PackResult,
} from './pack.ts'
export {
  composeProfile, configTrees, describePack, indexWorkspacePackages, packPreviewFixture, previewFixtures,
  type PreviewFixture,
} from './repository.ts'
