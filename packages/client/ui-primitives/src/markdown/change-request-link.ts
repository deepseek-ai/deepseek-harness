/**
 * Change request references for links whose text is their own URL. Like the
 * site marks in {@link ../SiteGlyph.tsx}, the hosts are a fixed table:
 * github.com pull requests and gitlab.com merge requests, on their overview
 * page only, so a link to files, a commit, a comment, or any other host keeps
 * its URL as written.
 */

/** How a change request link reads as a reference: its repository path and its number with the host's prefix. */
export interface ChangeRequestReference {
  /** Repository path, such as `octo/demo` or `group/sub/project`. */
  readonly repository: string
  /** Number with the host's prefix, such as `#7` for a pull request or `!3` for a merge request. */
  readonly number: string
}

/** A repository path segment as the hosts spell it; anything else, such as an encoded character, keeps the URL. */
const SEGMENT = '[A-Za-z0-9_.-]+'

/** Overview page path of a change request on each host, capturing the repository path and the number. */
const OVERVIEW_PATHS: Readonly<Record<string, { readonly path: RegExp; readonly prefix: string }>> = {
  'github.com': { path: new RegExp(`^/(${SEGMENT}/${SEGMENT})/pull/([1-9][0-9]*)/?$`, 'u'), prefix: '#' },
  'gitlab.com': { path: new RegExp(`^/((?:${SEGMENT}/)+${SEGMENT})/-/merge_requests/([1-9][0-9]*)/?$`, 'u'), prefix: '!' },
}

/**
 * Read a link as a change request reference.
 * @param href - The sanitized link destination.
 * @param text - Plain text of the link as written.
 * @returns The reference when the text spells the destination itself and the destination is the overview page of a
 * github.com pull request or a gitlab.com merge request without a port, credentials, query, or fragment; otherwise
 * undefined.
 */
export function changeRequestReference(href: string, text: string): ChangeRequestReference | undefined {
  if (text.trim().replace(/\/$/u, '') !== href.replace(/\/$/u, '')) return undefined
  let url: URL
  try {
    url = new URL(href)
  } catch {
    // Not an absolute URL, so it names no host.
    return undefined
  }
  const overview = OVERVIEW_PATHS[url.hostname]
  const web = url.protocol === 'https:' || url.protocol === 'http:'
  if (overview === undefined || !web || url.port !== '' || url.username !== '' || url.password !== '' || url.search !== ''
    || url.hash !== '') return undefined
  const match = overview.path.exec(url.pathname)
  if (match === null) return undefined
  const [, repository = '', number = ''] = match
  return { repository, number: `${overview.prefix}${number}` }
}
