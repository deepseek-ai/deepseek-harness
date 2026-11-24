/** The pinned upstream files of an entry skill, its registration, and the handle its plugin waits for them through. */

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

/** One plugin's packaged entry skill and the upstream files it indexes. */
export interface UpstreamSkillsRegistration {
  /** The skill provider's name, also the directory under `$DSH_HOME/cache` that receives the download. */
  readonly name: string
  /** Absolute path of the packaged entry `SKILL.md`, whose frontmatter gives the skill's name and description. */
  readonly entry: string
  /** The pinned upstream files. */
  readonly set: UpstreamSkillSet
  /** The plugin's configured directory holding the kept files at their repository paths; when set, nothing is downloaded. */
  readonly skillsDir?: string | undefined
}

/** The upstream files of one registered entry skill, which the provider lists only while they are in `directory`. */
export interface UpstreamSkillsHandle {
  /** The directory the entry skill resolves relative paths against: `skillsDir`, or the published cache directory. */
  readonly directory: string
  /**
   * Tell whether the upstream files are in place.
   * @returns whether `directory` exists.
   */
  installed(): boolean
  /**
   * Wait until the upstream files are in place: return at once when they are, otherwise wait for the running download,
   * or start one when none runs. Aborting `signal` stops that download, also for every other caller that waits for it.
   * @param signal - stops the download and the wait.
   * @returns once `directory` exists.
   * @throws the reason of `signal` after it aborts; the withdrawal reason after the registration is withdrawn; when the
   *   configured `skillsDir` is no longer a directory, without a download; otherwise what failed the download, which
   *   is also logged as a warning.
   */
  install(signal: AbortSignal): Promise<void>
  /** Withdraw the registration before the plugin unloads: abort a running download and remove the entry skill. */
  dispose(): void
}
