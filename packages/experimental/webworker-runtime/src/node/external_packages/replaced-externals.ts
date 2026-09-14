/**
 * Exact package or subpath specifiers served from the worker bundle. Kept
 * import-free for the runtime builtin table and the VFS image collector.
 * Whole-package entries are omitted from the image; subpath entries leave
 * their parent package available to other consumers.
 */

/** Package or subpath specifiers served from the worker bundle instead of the VFS. */
export const REPLACED_EXTERNAL_PACKAGES: readonly string[] = [
  '@earendil-works/pi-ai',
  '@vscode/ripgrep',
  '@deepseek-ai/node-addon-system/flock',
  'koffi',
  'node-pty',
  'sharp',
  'ws',
]
