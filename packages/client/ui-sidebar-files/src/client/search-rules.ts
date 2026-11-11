/**
 * Search exclusion rules and the search preferences that carry them.
 *
 * A rule names files and directories the workspace search leaves out, by name
 * or by path. A path without `/` is a name and matches every file or directory
 * of that name at any depth; a path with `/` is relative to the workspace root
 * and matches that one file or directory. An excluded directory's contents are
 * left out with it. This module keeps the editable list, checks what the
 * reader types, and reads the list back from a stored value; the Host's
 * workspace search applies the rules.
 *
 * The list records no origin: a default path the reader removed and then
 * added again by hand counts as a default that is present.
 */

/** One exclusion rule as the settings list shows and stores it. */
export interface ExclusionRule {
  /** Normalized name or `/`-separated workspace-relative path of a file or directory. */
  readonly path: string
  /** Whether the search leaves this path out now. */
  readonly enabled: boolean
}

/** Why a typed rule path was refused; each reason has its own `settings.invalid.*` line. */
export type RuleInvalidReason = 'empty' | 'nul' | 'absolute' | 'parent' | 'glob'

/** A typed rule path after normalization, or why it was refused. */
export type RulePathResult =
  | { readonly kind: 'ok'; readonly path: string }
  | { readonly kind: 'invalid'; readonly reason: RuleInvalidReason }

/** The search panel's persisted choices. */
export interface WorkspaceSearchPreferences {
  /** Exclusion rules, newest first. */
  readonly rules: readonly ExclusionRule[]
  /** Whether results include hidden entries. */
  readonly showHidden: boolean
  /** Whether the search leaves out entries the workspace's `.gitignore` files ignore. */
  readonly respectGitignore: boolean
}

/**
 * Names excluded until the reader changes the list, in the order a restore
 * lists them: version-control, package-manager, and build output directories,
 * then the metadata files and directories macOS and Windows write into folders
 * and volumes.
 */
const DEFAULT_EXCLUDED_PATHS: readonly string[] = [
  '.git', '.hg', '.next', '.pnpm-store', '.svn', '.turbo', '.yarn', 'build', 'coverage', 'dist', 'node_modules',
  '.DS_Store', '.Spotlight-V100', '.Trashes', '.fseventsd', 'Thumbs.db', 'desktop.ini', '$RECYCLE.BIN', 'System Volume Information',
]

/** Characters that would make a literal path read as a pattern. */
const GLOB = /[*?[\]{}!]/

/**
 * Normalize a typed rule path: trim it, turn `\` into `/`, merge repeated
 * `/`, and drop leading `./`, trailing `/`, and whitespace exposed at either
 * edge. Internal whitespace stays unchanged.
 *
 * Refuses an empty path, one containing NUL, an absolute one (leading `/`, a
 * drive letter such as `C:`, or `~`, including prefixes exposed by dropping
 * leading `./` and whitespace), one with a `.` or `..` segment, and one
 * containing a glob character (`* ? [ ] { } !`). Other characters, such as
 * `$` and spaces, are kept literally.
 * @param input - the text the reader typed.
 * @returns the normalized path, unchanged by normalization again, or why it was refused.
 */
export function normalizeRulePath(input: string): RulePathResult {
  const slashed = input.trim().replace(/\\/g, '/')
  if (slashed === '') return { kind: 'invalid', reason: 'empty' }
  if (slashed.includes('\0')) return { kind: 'invalid', reason: 'nul' }
  const relative = slashed.replace(/\/{2,}/g, '/').replace(/^(?:\s|\.\/)+/, '')
  if (slashed.startsWith('/') || /^(?:\/|~|[A-Za-z]:)/.test(relative)) return { kind: 'invalid', reason: 'absolute' }
  // Anchor the suffix scan at the start so long internal whitespace is not scanned repeatedly.
  const path = relative.replace(/^(.*[^\s/])?[\s/]*$/s, '$1')
  if (GLOB.test(path)) return { kind: 'invalid', reason: 'glob' }
  if (path === '') return { kind: 'invalid', reason: 'empty' }
  if (path.split('/').some(segment => segment === '.' || segment === '..')) return { kind: 'invalid', reason: 'parent' }
  return { kind: 'ok', path }
}

/**
 * The default rule list, every rule enabled.
 * @returns a new list in default order.
 */
export function defaultRules(): ExclusionRule[] {
  return DEFAULT_EXCLUDED_PATHS.map(path => ({ path, enabled: true }))
}

/**
 * The preferences before the reader changes anything.
 * @returns the default rules, hidden entries not shown, and `.gitignore` respected.
 */
export function defaultSearchPreferences(): WorkspaceSearchPreferences {
  return { rules: defaultRules(), showHidden: false, respectGitignore: true }
}

/**
 * Add a typed rule at the top of the list, enabled.
 *
 * A rule whose normalized path is already listed, enabled or not, is enabled
 * and moved to the top instead of being listed twice. Paths compare exactly.
 * @param rules - the current list.
 * @param input - the text the reader typed.
 * @returns the new list, or why the text was refused.
 */
export function addRule(
  rules: readonly ExclusionRule[],
  input: string,
): { readonly kind: 'ok'; readonly rules: readonly ExclusionRule[] } | { readonly kind: 'invalid'; readonly reason: RuleInvalidReason } {
  const normalized = normalizeRulePath(input)
  if (normalized.kind === 'invalid') return normalized
  const { path } = normalized
  return { kind: 'ok', rules: [{ path, enabled: true }, ...rules.filter(rule => rule.path !== path)] }
}

/**
 * Remove one rule.
 * @param rules - the current list.
 * @param path - the rule's normalized path.
 * @returns the list without it; an unlisted path leaves the list as it was.
 */
export function removeRule(rules: readonly ExclusionRule[], path: string): readonly ExclusionRule[] {
  return rules.filter(rule => rule.path !== path)
}

/**
 * Enable or disable one rule in place.
 * @param rules - the current list.
 * @param path - the rule's normalized path.
 * @param enabled - whether the search leaves the path out.
 * @returns the list with that rule changed; an unlisted path leaves the list as it was.
 */
export function setRuleEnabled(rules: readonly ExclusionRule[], path: string, enabled: boolean): readonly ExclusionRule[] {
  return rules.map(rule => rule.path === path && rule.enabled !== enabled ? { path, enabled } : rule)
}

/**
 * The paths the search leaves out.
 * @param rules - the current list.
 * @returns the enabled rules' paths, in list order.
 */
export function enabledPaths(rules: readonly ExclusionRule[]): string[] {
  return rules.filter(rule => rule.enabled).map(rule => rule.path)
}

/**
 * Whether a rule list equals the default list: the same paths in the same
 * order, every rule enabled.
 * @param rules - the current list.
 * @returns `true` when nothing differs from {@link defaultRules}.
 */
export function isDefaultRules(rules: readonly ExclusionRule[]): boolean {
  return rules.length === DEFAULT_EXCLUDED_PATHS.length
    && rules.every((rule, index) => rule.path === DEFAULT_EXCLUDED_PATHS[index] && rule.enabled)
}

/**
 * Read preferences back from a value browser storage holds, which any earlier
 * build or the reader may have written, after its JSON text was parsed.
 *
 * Each field is read on its own: a missing or mistyped `rules` array,
 * `showHidden`, or `respectGitignore` takes the current default, so an entry
 * that stores only the fields the reader changed keeps the defaults of the
 * running build for the rest. A value that is not an object gives the
 * defaults. Inside a `rules` array, a rule that is not an object with a string
 * `path` and a boolean `enabled`, or whose path `normalizeRulePath` refuses,
 * is dropped; a rule whose normalized path repeats an earlier one is dropped
 * too. A stored empty list stays empty.
 * @param value - the parsed stored value.
 * @returns the preferences to use.
 */
export function readSearchPreferences(value: unknown): WorkspaceSearchPreferences {
  const defaults = defaultSearchPreferences()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return defaults
  const field = (name: string): unknown => Object.hasOwn(value, name) ? Object.getOwnPropertyDescriptor(value, name)?.value : undefined
  const rules = field('rules')
  const showHidden = field('showHidden')
  const respectGitignore = field('respectGitignore')
  return {
    rules: Array.isArray(rules) ? readRules(rules) : defaults.rules,
    showHidden: typeof showHidden === 'boolean' ? showHidden : defaults.showHidden,
    respectGitignore: typeof respectGitignore === 'boolean' ? respectGitignore : defaults.respectGitignore,
  }
}

/**
 * The well-formed rules of a stored list, normalized, in stored order.
 * @param rules - the stored list.
 * @returns the rules to use.
 */
function readRules(rules: readonly unknown[]): ExclusionRule[] {
  const parsed: ExclusionRule[] = []
  for (const rule of rules) {
    if (typeof rule !== 'object' || rule === null || !('path' in rule) || !('enabled' in rule)) continue
    const { path, enabled } = rule
    if (typeof path !== 'string' || typeof enabled !== 'boolean') continue
    const normalized = normalizeRulePath(path)
    if (normalized.kind === 'invalid' || parsed.some(kept => kept.path === normalized.path)) continue
    parsed.push({ path: normalized.path, enabled })
  }
  return parsed
}

/**
 * The fields of preferences that differ from the defaults, as browser storage
 * keeps them: a field equal to its default is left out, so a later build's
 * default reaches it.
 * @param preferences - the preferences to store.
 * @returns the differing fields, or `undefined` when nothing differs from {@link defaultSearchPreferences}.
 */
export function changedSearchPreferences(preferences: WorkspaceSearchPreferences): Partial<WorkspaceSearchPreferences> | undefined {
  const defaults = defaultSearchPreferences()
  const changed: { -readonly [K in keyof WorkspaceSearchPreferences]?: WorkspaceSearchPreferences[K] } = {}
  if (!isDefaultRules(preferences.rules)) changed.rules = preferences.rules.map(rule => ({ path: rule.path, enabled: rule.enabled }))
  if (preferences.showHidden !== defaults.showHidden) changed.showHidden = preferences.showHidden
  if (preferences.respectGitignore !== defaults.respectGitignore) changed.respectGitignore = preferences.respectGitignore
  return Object.keys(changed).length === 0 ? undefined : changed
}

/**
 * Whether the tree treats an entry as hidden: its name starts with `.`. The
 * Host's search judges names the same way, except on a Windows Host, where
 * ripgrep also treats an entry with the hidden file attribute as hidden. The
 * tree lists names one level at a time under the workspace root, so a name is
 * judged on its own.
 * @param entry - a listed entry.
 * @returns `true` for a hidden entry.
 */
export function isHiddenEntry(entry: { readonly name: string }): boolean {
  return entry.name.startsWith('.')
}
