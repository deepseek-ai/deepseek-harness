/**
 * The `dsh-resource://file/…` address grammar: how a file is named across the
 * Sidebar and the resource model, built and parsed without touching a
 * filesystem.
 * @module
 */

/**
 * A file resource address, in one of two scopes.
 *
 * Every resource address is `dsh-resource://<type>/…`, the URI host naming the
 * resource protocol; for `file` the path opens with the scope:
 *
 * - `dsh-resource://file/session/<sessionId>/<path>` names a file by its path,
 *   relative to that Session's workspace root or absolute; the
 *   Host resolves it against the root it holds for the Session.
 * - `dsh-resource://file/absolute/<path>` names a file by its absolute path with
 *   the leading `/` dropped (`dsh-resource://file/absolute/home/ys/notes.txt`;
 *   Windows `dsh-resource://file/absolute/C:/x/y.txt`; a UNC path keeps an empty
 *   first segment, `dsh-resource://file/absolute//server/share/x.txt`). It carries
 *   no Session.
 *
 * Every id and path segment is component-encoded, so a name carrying `#`, `?`,
 * or a space survives the round trip; `:` stays literal so a drive letter reads
 * as written.
 */
export type FileAddress =
  | {
    readonly scope: 'session'
    /** The Session whose Host workspace resolves the path. */
    readonly sessionId: string
    /** Absolute or workspace-relative `/`-separated path; empty for the workspace root itself. */
    readonly path: string
  }
  | {
    readonly scope: 'absolute'
    /** Absolute `/`-separated path: `/a/b` on POSIX, `C:/a/b` for a Windows drive, `//server/share/a` for a UNC path. */
    readonly path: string
  }

/** The scheme and type every file address opens with. */
const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'

/** Component-encode one id or path segment, keeping `:` literal for drive letters. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

/** Encode a `/`-separated path segment by segment. */
function encodePath(path: string): string {
  return path.split('/').map(encodeSegment).join('/')
}

/** Whether a decoded first path segment is a Windows drive (`C:`). */
function isDriveSegment(segment: string | undefined): boolean {
  return segment !== undefined && /^[A-Za-z]:$/.test(segment)
}

/**
 * Build the address of a file read through one Session.
 * @param sessionId - the Session whose Host workspace resolves the path.
 * @param path - absolute or workspace-relative path; backslashes are normalized to `/`, and leading `./` prefixes are dropped.
 * @returns the `dsh-resource://file/session/<sessionId>/<path>` address.
 */
export function sessionFileAddress(sessionId: string, path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(normalized)}`
}

/**
 * Build the address of a file by its absolute path.
 * @param path - absolute path; backslashes are normalized to `/` and the leading `/` is dropped,
 *   except that a UNC path (`\\server\share`) keeps one empty first segment.
 * @returns the `dsh-resource://file/absolute/<path>` address.
 */
export function absoluteFileAddress(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const unc = normalized.startsWith('//')
  const absolute = normalized.replace(/^\/+/, '')
  return `${FILE_ADDRESS_PREFIX}absolute/${unc ? '/' : ''}${encodePath(absolute)}`
}

/**
 * Read a file address back into its parts without resolving `.` or `..`.
 * Query and fragment suffixes are ignored; encoded path segments are decoded.
 * @param address - a candidate address.
 * @returns the parts, or `undefined` when the string is not a `dsh-resource://file/` URI in a known scope with a path, or a segment is not validly encoded.
 */
export function parseFileAddress(address: string): FileAddress | undefined {
  try {
    if (!address.startsWith(FILE_ADDRESS_PREFIX)) return undefined
    const end = address.search(/[?#]/)
    const [scope, ...rest] = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end).split('/')
    if (scope === 'session') {
      const [id, ...segments] = rest
      if (id === undefined || id === '' || segments.length === 0) return undefined
      return { scope, sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join('/') }
    }
    if (scope === 'absolute') {
      // An empty first segment with more behind it is a UNC path's `//`; alone it is no path.
      const unc = rest[0] === '' && rest.length > 1
      const segments = (unc ? rest.slice(1) : rest).map(decodeURIComponent)
      if (segments.length === 0 || segments[0] === '') return undefined
      if (unc) return { scope, path: `//${segments.join('/')}` }
      return { scope, path: isDriveSegment(segments[0]) ? segments.join('/') : `/${segments.join('/')}` }
    }
    return undefined
  } catch {
    // `decodeURIComponent` throws URIError on a malformed escape.
    return undefined
  }
}
