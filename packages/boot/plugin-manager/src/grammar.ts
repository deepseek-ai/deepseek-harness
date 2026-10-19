/**
 * Browser-safe `@[label](dsh-plugin:<package>)` mention grammar shared by the Host resolver and the Web client.
 *
 * @module @deepseek-ai/dsh-plugin-manager/grammar
 */

/** URI scheme reserved for plugin references. */
export const PLUGIN_REFERENCE_SCHEME = 'dsh-plugin:'

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const MENTION_SOURCE = String.raw`@\[((?:\\.|[^\\\]])*)\]\((dsh-plugin:[^\s)]+)\)`

/** One plugin package to mention; the label defaults to the package name. */
export interface PluginReferenceInput {
  readonly packageName: string
  readonly label?: string
}

/** One matched canonical mention with its UTF-16 source range. */
export interface PluginMentionMatch {
  readonly start: number
  readonly end: number
  readonly packageName: string
  readonly label: string
}

/** Text after canonical mentions were folded to `@label`, with the references in appearance order. */
export interface ParsedPluginMentions {
  readonly text: string
  readonly references: readonly { readonly packageName: string; readonly label: string }[]
}

/** Escape `\` and `]` in a mention label. */
function escapeLabel(label: string): string {
  return label.replace(/[\\\]]/gu, match => `\\${match}`)
}

/** Reverse {@link escapeLabel}. */
function unescapeLabel(label: string): string {
  return label.replace(/\\(.)/gu, '$1')
}

/**
 * Whether a string is a bare npm package name.
 * @param value - candidate package name.
 * @returns whether the value names one package without a subpath.
 */
export function isPluginPackageName(value: string): boolean {
  return PACKAGE_NAME.test(value)
}

/**
 * Render one canonical Markdown mention.
 * @param reference - package name and optional display label.
 * @returns the canonical mention.
 * @throws Error when the package name is not a bare npm package name.
 */
export function formatPluginMention(reference: PluginReferenceInput): string {
  if (!isPluginPackageName(reference.packageName)) {
    throw new Error(`invalid plugin package name ${JSON.stringify(reference.packageName)}`)
  }
  return `@[${escapeLabel(reference.label ?? reference.packageName)}](${PLUGIN_REFERENCE_SCHEME}${reference.packageName})`
}

/**
 * The bare package name owning a module specifier.
 * @param moduleName - configured plugin module specifier.
 * @returns the package name without a subpath.
 */
export function packageNameOfModule(moduleName: string): string {
  const scoped = moduleName.startsWith('@') ? moduleName.indexOf('/') : -1
  const slash = moduleName.indexOf('/', scoped + 1)
  return slash === -1 ? moduleName : moduleName.slice(0, slash)
}

/**
 * Find the nearest canonical mention at or after `from`; a mention whose URI does not name a bare package is ordinary text.
 * @param text - text that may contain mentions.
 * @param from - inclusive UTF-16 start offset.
 * @returns the matched mention and its range, or undefined when none follows.
 */
export function nextPluginMention(text: string, from = 0): PluginMentionMatch | undefined {
  const pattern = new RegExp(MENTION_SOURCE, 'gu')
  pattern.lastIndex = from
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const packageName = (match[2] as string).slice(PLUGIN_REFERENCE_SCHEME.length)
    if (!isPluginPackageName(packageName)) continue
    return { start: match.index, end: match.index + match[0].length, packageName, label: unescapeLabel(match[1] as string) }
  }
  return undefined
}

/**
 * The package named by a mention that occupies the whole string.
 * @param mention - one canonical mention.
 * @returns the package name, or undefined when the string is not exactly one mention.
 */
export function packageNameOfPluginMention(mention: string): string | undefined {
  const match = nextPluginMention(mention)
  return match !== undefined && match.start === 0 && match.end === mention.length ? match.packageName : undefined
}

/**
 * Fold canonical mentions into readable `@label` text and collect their references.
 * @param text - user text that may cite plugins.
 * @returns readable text and references in appearance order.
 */
export function parsePluginMentions(text: string): ParsedPluginMentions {
  const references: { packageName: string; label: string }[] = []
  let rendered = ''
  let cursor = 0
  for (let match = nextPluginMention(text); match !== undefined; match = nextPluginMention(text, cursor)) {
    rendered += `${text.slice(cursor, match.start)}@${match.label}`
    cursor = match.end
    references.push({ packageName: match.packageName, label: match.label })
  }
  return { text: rendered + text.slice(cursor), references }
}
