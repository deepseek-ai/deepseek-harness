/**
 * Virtual root of the worker host's in-memory filesystem. Kept
 * in one module so the process shim, the path/os shims, and the VFS image
 * collector cannot drift apart.
 */

/** Virtual filesystem root; `process.cwd()` and every absolute path start here. */
export const DSH_ROOT = '/dsh'

/** `$DSH_HOME`: durable-state directory inside the image. */
export const DSH_HOME = `${DSH_ROOT}/home`

/** Flat, symlink-free package tree resolved by the worker module loader. */
export const DSH_NODE_MODULES = `${DSH_ROOT}/node_modules`

/** Directory holding the composed cordis.yml. */
export const DSH_CONFIG = `${DSH_ROOT}/config`

/** Default (empty) workspace directory. */
export const DSH_WORKSPACE = `${DSH_ROOT}/workspace`

/** Temporary directory reported by `os.tmpdir()`. */
export const DSH_TMP = `${DSH_ROOT}/tmp`
