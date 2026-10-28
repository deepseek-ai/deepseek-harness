/**
 * Build-time packer for the browser runtime's VFS image.
 * @module @deepseek-ai/dsh-experimental-webworker-packer
 */
export {
  WRAPPER_CONTRACT,
  type ImageFiles, type TransformOutcome,
} from './transform-image.ts'
export {
  collectModuleNames, DEFAULT_ROOT, MANIFEST_PATH, packVfsImage, packVfsOverlay,
  type ConfigTree, type ImageInstallation, type ImageTree, type PackedLazyArchive, type PackOptions,
  type PackOverlayResult, type PackResult,
} from './pack.ts'
export {
  configTrees, describePack, indexWorkspacePackages, installationManifest, packPreviewFixture, packRepositoryImage,
  previewFixtures, profileRoster, type PreviewFixture, type ProfileRoster,
} from './repository.ts'
