/** Plugin detail records that Remote methods and their clients share. */

/**
 * Why a detail document or one of its images cannot be read: `too-large` beyond a size limit, `network` when a source
 * cannot be reached, `denied` when Git refuses the repository with the user's credentials, `git-unavailable` when a
 * repository must be cloned and Git cannot run, and `invalid` for a malformed locale file or `meta.detail`, or a named
 * file that does not exist.
 */
export type DetailFailureReason = 'too-large' | 'network' | 'denied' | 'git-unavailable' | 'invalid'

/** A public CDN that serves single files of published npm package versions. */
export type NpmFileSource = 'jsdelivr' | 'unpkg' | 'npmmirror'
