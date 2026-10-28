/** The pinned upstream files of an entry skill and the handle its plugin observes. */

/** Which files of a GitHub repository an upstream skill set keeps. */
export interface UpstreamSkillSelection {
  /** `<owner>/<repository>` on GitHub. */
  readonly repository: string
  /** The full commit id whose archive holds the files. */
  readonly commit: string
  /** The kept directory relative to the repository root, without a trailing slash; every regular file under it is kept. */
  readonly directory: string
  /** Files under `directory` that are not kept, relative to the repository root. */
  readonly exclude: readonly string[]
  /** The license file kept beside the directory, relative to the repository root. */
  readonly license: string
}

/** A selection pinned by the total size and the digest of its kept files; `scripts/upstream-skills-digest.ts` prints both. */
export interface UpstreamSkillSet extends UpstreamSkillSelection {
  /** Total bytes of the kept files; reading an archive stops once its kept files exceed it. */
  readonly bytes: number
  /** Lowercase hexadecimal SHA-256 digest of the kept files' sorted paths and contents. */
  readonly sha256: string
}

/** Where an entry skill's upstream files stand: in place, being downloaded, or neither. */
export type UpstreamSkillsState = 'installed' | 'downloading' | 'failed'

/** The upstream files of one registered entry skill, which the provider lists only while they are in `directory`. */
export interface UpstreamSkills {
  /** The directory the entry skill resolves relative paths against: `skillsDir`, or the published cache directory. */
  readonly directory: string
  /** `downloading` while a download runs, otherwise `installed` when `directory` exists and `failed` when it does not. */
  readonly state: UpstreamSkillsState
  /**
   * Call a listener each time a download starts and each time it settles.
   * @param listener - receives the state after the change.
   * @returns the disposer that removes the listener.
   */
  watch(listener: (state: UpstreamSkillsState) => void): () => void
  /** Start a download when the state is `failed`, unless `skillsDir` is configured or the plugin is disposed; return at once. */
  retry(): void
}
