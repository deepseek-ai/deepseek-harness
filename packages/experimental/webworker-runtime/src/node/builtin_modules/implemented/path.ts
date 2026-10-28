/**
 * `node:path` for the worker: the POSIX algorithm, transliterated from Node's
 * implementation. It is NOT a face over the worker host's `posixPath`: that helper
 * normalizes before splitting, so `dirname('/a/b/..')` answers `/` where Node
 * answers `/a/b` (measured: 45 cases diverge between the normalizing helper and
 * Node). `../../../../tests/node/path-diff.spec.ts` pins the port below to
 * Node's answers.
 * A `node:` proxy has to answer what Node answers, since VFS paths were built with
 * Node semantics. `win32` members throw, except `isAbsolute`, which
 * cross-platform callers use to reject Windows absolute paths on any platform:
 * the worker host reports `process.platform === 'linux'`, so any other Windows
 * branch means a bug.
 */
import { DSH_ROOT } from '../../../storage/paths.ts'

const CHAR_DOT = 46
const CHAR_FORWARD_SLASH = 47

/** Parsed path object returned by {@link parse}. */
export interface ParsedPath {
  root: string
  dir: string
  base: string
  ext: string
  name: string
}

const cwd = (): string => {
  const scope = globalThis as { process?: { cwd?: () => string } }
  return scope.process?.cwd?.() ?? DSH_ROOT
}

function assertPath(path: unknown): asserts path is string {
  if (typeof path !== 'string') {
    throw new TypeError(`Path must be a string. Received ${JSON.stringify(path)}`)
  }
}

/** Resolve `.` and `..` segments; `allowAboveRoot` keeps leading `..` for relative inputs. */
function normalizeString(path: string, allowAboveRoot: boolean): string {
  let res = ''
  let lastSegmentLength = 0
  let lastSlash = -1
  let dots = 0
  let code = 0
  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length) code = path.charCodeAt(i)
    else if (code === CHAR_FORWARD_SLASH) break
    else code = CHAR_FORWARD_SLASH
    if (code === CHAR_FORWARD_SLASH) {
      if (lastSlash === i - 1 || dots === 1) {
        // empty segment or `.`
      } else if (dots === 2) {
        if (res.length < 2 || lastSegmentLength !== 2
          || res.charCodeAt(res.length - 1) !== CHAR_DOT
          || res.charCodeAt(res.length - 2) !== CHAR_DOT) {
          if (res.length > 2) {
            const lastSlashIndex = res.lastIndexOf('/')
            if (lastSlashIndex === -1) {
              res = ''
              lastSegmentLength = 0
            } else {
              res = res.slice(0, lastSlashIndex)
              lastSegmentLength = res.length - 1 - res.lastIndexOf('/')
            }
            lastSlash = i
            dots = 0
            continue
          } else if (res.length !== 0) {
            res = ''
            lastSegmentLength = 0
            lastSlash = i
            dots = 0
            continue
          }
        }
        if (allowAboveRoot) {
          res += res.length > 0 ? '/..' : '..'
          lastSegmentLength = 2
        }
      } else {
        if (res.length > 0) res += `/${path.slice(lastSlash + 1, i)}`
        else res = path.slice(lastSlash + 1, i)
        lastSegmentLength = i - lastSlash - 1
      }
      lastSlash = i
      dots = 0
    } else if (code === CHAR_DOT && dots !== -1) {
      ++dots
    } else {
      dots = -1
    }
  }
  return res
}

/**
 * Resolve a sequence of paths into an absolute path.
 * @param paths - path segments, right to left until an absolute one is found.
 * @returns the absolute, normalized path.
 */
export function resolve(...paths: string[]): string {
  let resolved = ''
  let absolute = false
  for (let i = paths.length - 1; i >= 0 && !absolute; i--) {
    const path = paths[i]
    assertPath(path)
    if (path.length === 0) continue
    resolved = resolved.length === 0 ? path : `${path}/${resolved}`
    absolute = path.charCodeAt(0) === CHAR_FORWARD_SLASH
  }
  if (!absolute) {
    const base = cwd()
    resolved = resolved.length === 0 ? base : `${base}/${resolved}`
    absolute = base.charCodeAt(0) === CHAR_FORWARD_SLASH
  }
  const normalized = normalizeString(resolved, !absolute)
  if (absolute) return `/${normalized}`
  return normalized.length > 0 ? normalized : '.'
}

/**
 * Normalize a path, resolving `.`, `..`, and duplicate separators.
 * @param path - the path.
 * @returns the normalized path.
 */
export function normalize(path: string): string {
  assertPath(path)
  if (path.length === 0) return '.'
  const isAbsolutePath = path.charCodeAt(0) === CHAR_FORWARD_SLASH
  const trailingSeparator = path.charCodeAt(path.length - 1) === CHAR_FORWARD_SLASH
  let normalized = normalizeString(path, !isAbsolutePath)
  if (normalized.length === 0) {
    if (isAbsolutePath) return '/'
    return trailingSeparator ? './' : '.'
  }
  if (trailingSeparator) normalized += '/'
  return isAbsolutePath ? `/${normalized}` : normalized
}

/**
 * Whether the path is absolute.
 * @param path - the path.
 * @returns true when it starts at the root.
 */
export function isAbsolute(path: string): boolean {
  assertPath(path)
  return path.length > 0 && path.charCodeAt(0) === CHAR_FORWARD_SLASH
}

/**
 * Join path segments with the separator, then normalize.
 * @param paths - the segments.
 * @returns the joined path.
 */
export function join(...paths: string[]): string {
  if (paths.length === 0) return '.'
  let joined: string | undefined
  for (const path of paths) {
    assertPath(path)
    if (path.length === 0) continue
    joined = joined === undefined ? path : `${joined}/${path}`
  }
  return joined === undefined ? '.' : normalize(joined)
}

/**
 * Relative path from one location to another.
 * @param from - source path.
 * @param to - target path.
 * @returns the relative path, or '' when both resolve identically.
 */
export function relative(from: string, to: string): string {
  assertPath(from)
  assertPath(to)
  if (from === to) return ''
  const fromResolved = resolve(from)
  const toResolved = resolve(to)
  if (fromResolved === toResolved) return ''
  const fromParts = fromResolved.split('/').filter(part => part.length > 0)
  const toParts = toResolved.split('/').filter(part => part.length > 0)
  let shared = 0
  while (shared < fromParts.length && shared < toParts.length && fromParts[shared] === toParts[shared]) shared++
  const up = Array.from({ length: fromParts.length - shared }, () => '..')
  return [...up, ...toParts.slice(shared)].join('/')
}

/**
 * Directory portion of a path (lexical, as Node defines it: no normalization).
 * @param path - the path.
 * @returns the parent directory.
 */
export function dirname(path: string): string {
  assertPath(path)
  if (path.length === 0) return '.'
  const hasRoot = path.charCodeAt(0) === CHAR_FORWARD_SLASH
  let end = -1
  let matchedSlash = true
  for (let i = path.length - 1; i >= 1; --i) {
    if (path.charCodeAt(i) === CHAR_FORWARD_SLASH) {
      if (!matchedSlash) {
        end = i
        break
      }
    } else {
      matchedSlash = false
    }
  }
  if (end === -1) return hasRoot ? '/' : '.'
  if (hasRoot && end === 1) return '//'
  return path.slice(0, end)
}

/**
 * Last portion of a path, optionally without a suffix (lexical, as in Node).
 * @param path - the path.
 * @param suffix - extension to strip when the base ends with it.
 * @returns the base name.
 */
export function basename(path: string, suffix?: string): string {
  assertPath(path)
  let start = 0
  let end = -1
  let matchedSlash = true
  if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
    if (suffix === path) return ''
    let extIdx = suffix.length - 1
    let firstNonSlashEnd = -1
    for (let i = path.length - 1; i >= 0; --i) {
      const code = path.charCodeAt(i)
      if (code === CHAR_FORWARD_SLASH) {
        if (!matchedSlash) {
          start = i + 1
          break
        }
        continue
      }
      if (firstNonSlashEnd === -1) {
        matchedSlash = false
        firstNonSlashEnd = i + 1
      }
      if (extIdx >= 0) {
        if (code === suffix.charCodeAt(extIdx)) {
          if (--extIdx === -1) end = i
        } else {
          extIdx = -1
          end = firstNonSlashEnd
        }
      }
    }
    if (start === end) end = firstNonSlashEnd
    else if (end === -1) end = path.length
    return path.slice(start, end)
  }
  for (let i = path.length - 1; i >= 0; --i) {
    if (path.charCodeAt(i) === CHAR_FORWARD_SLASH) {
      if (!matchedSlash) {
        start = i + 1
        break
      }
    } else if (end === -1) {
      matchedSlash = false
      end = i + 1
    }
  }
  return end === -1 ? '' : path.slice(start, end)
}

/**
 * Extension of the last path segment, including the leading dot.
 * @param path - the path.
 * @returns the extension, or '' when there is none.
 */
export function extname(path: string): string {
  assertPath(path)
  let startDot = -1
  let startPart = 0
  let end = -1
  let matchedSlash = true
  let preDotState = 0
  for (let i = path.length - 1; i >= 0; --i) {
    const code = path.charCodeAt(i)
    if (code === CHAR_FORWARD_SLASH) {
      if (!matchedSlash) {
        startPart = i + 1
        break
      }
      continue
    }
    if (end === -1) {
      matchedSlash = false
      end = i + 1
    }
    if (code === CHAR_DOT) {
      if (startDot === -1) startDot = i
      else if (preDotState !== 1) preDotState = 1
    } else if (startDot !== -1) {
      preDotState = -1
    }
  }
  if (startDot === -1 || end === -1 || preDotState === 0
    || (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
    return ''
  }
  return path.slice(startDot, end)
}

/**
 * Build a path from its parsed parts.
 * @param pathObject - dir/root/base/name/ext parts.
 * @returns the assembled path.
 */
export function format(pathObject: Partial<ParsedPath>): string {
  const dir = pathObject.dir ?? pathObject.root ?? ''
  const base = pathObject.base ?? `${pathObject.name ?? ''}${pathObject.ext ?? ''}`
  if (dir === '') return base
  return dir === pathObject.root ? `${dir}${base}` : `${dir}/${base}`
}

/**
 * Split a path into root/dir/base/ext/name (lexical, as in Node).
 * @param path - the path.
 * @returns the parsed parts.
 */
export function parse(path: string): ParsedPath {
  assertPath(path)
  const base = basename(path)
  const ext = extname(path)
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path
  const lastSlash = trimmed.lastIndexOf('/')
  const root = isAbsolute(path) ? '/' : ''
  return {
    root,
    dir: trimmed === '' ? root : lastSlash === -1 ? '' : lastSlash === 0 ? '/' : trimmed.slice(0, lastSlash),
    base,
    ext,
    name: ext.length > 0 ? base.slice(0, base.length - ext.length) : base,
  }
}

/** POSIX path separator. */
export const sep = '/' as const

/** POSIX path-list delimiter. */
export const delimiter = ':' as const

/**
 * Windows namespace prefixes do not exist here.
 * @param path - the path.
 * @returns the path unchanged.
 */
export function toNamespacedPath(path: string): string {
  return path
}

const posixFace = {
  resolve, normalize, isAbsolute, join, relative, dirname, basename, extname, format, parse,
  sep, delimiter, toNamespacedPath,
}

/** POSIX member set: the module face, plus Node's self-referential namespaces. */
export const posix: typeof posixFace & { readonly posix: unknown; readonly win32: unknown } = {
  ...posixFace,
  get posix(): unknown { return posix },
  get win32(): unknown { return win32 },
}

const win32Member = (name: string) => (): never => {
  throw new Error(`web-preview: node:path.win32.${name} is unreachable — the worker host reports platform "linux"`)
}

const CHAR_BACKWARD_SLASH = 92
const CHAR_COLON = 58

/** Node's win32 separator test: `/` or `\`. */
function isWin32Separator(code: number): boolean {
  return code === CHAR_FORWARD_SLASH || code === CHAR_BACKWARD_SLASH
}

/** Node's drive-letter test: `A`–`Z` or `a`–`z`. */
function isWindowsDeviceRoot(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

/**
 * Node's `path.win32.isAbsolute`, a string check cross-platform callers make on every platform.
 * @param path - Path to classify.
 * @returns Whether a Windows host would treat the path as absolute.
 */
function win32IsAbsolute(path: string): boolean {
  if (path.length === 0) return false
  const code = path.charCodeAt(0)
  return isWin32Separator(code)
    || (path.length > 2 && isWindowsDeviceRoot(code) && path.charCodeAt(1) === CHAR_COLON && isWin32Separator(path.charCodeAt(2)))
}

/** Windows member set: reaching a member other than `isAbsolute` means a platform branch went the wrong way. */
export const win32 = {
  resolve: win32Member('resolve'),
  normalize: win32Member('normalize'),
  isAbsolute: win32IsAbsolute,
  join: win32Member('join'),
  relative: win32Member('relative'),
  dirname: win32Member('dirname'),
  basename: win32Member('basename'),
  extname: win32Member('extname'),
  format: win32Member('format'),
  parse: win32Member('parse'),
  toNamespacedPath: win32Member('toNamespacedPath'),
  sep: '\\',
  delimiter: ';',
}

/** CommonJS interop marker: the worker loader hands `default` to default imports (see ./builtins.ts). */
export const __esModule = true

/**
 * The `node:path` declarations this module stands in for. The two platform
 * namespaces stay unknown-typed: `posix` is this module reached through itself,
 * and `win32` holds throwing members rather than Node's `PlatformPath`, because
 * the worker host reports `linux` and a Windows branch is a bug.
 */
type NodeFace = Partial<Omit<typeof import('node:path'), 'posix' | 'win32'>> & Record<'posix' | 'win32', unknown>

export default posix satisfies NodeFace
