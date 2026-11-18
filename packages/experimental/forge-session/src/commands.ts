/** Recognition of shell commands and output that bind change requests to a Session, by the registered command rules. */

import quote from 'shell-quote/quote.js'
import type { CommandEvidence, ForgeCommandArguments, ForgeCommandGroup, ForgeCommandRule } from './types.ts'
import { simpleCommands } from './references.ts'

/** One branch a `git push` output reported as updated. */
export interface PushedRef {
  /** Remote as `git push` printed it after `To`. */
  readonly remote: string
  /** Branch name on the remote. */
  readonly branch: string
}

/** One change request a command names: its URL, or the command line of its lookup. */
export interface NamedChangeRequest {
  /** Change request URL when the command names its host, otherwise null. */
  readonly url: string | null
  /**
   * Command line of the rule's lookup, with the command's own variable assignments, for a standalone command that names
   * the change request without its host; otherwise null.
   */
  readonly lookup: string | null
  /** Id of the rule that selected the change request. */
  readonly rule: string
  /** Whether the command is a reference command, whose output names its change request too, or an API request. */
  readonly kind: ForgeCommandArguments['kind']
}

/** The registered command rules, compiled once per rule set and shared by the projection and the lookups. */
export interface CommandRules {
  /**
   * The `forgeChangeRequests` projection's state version for this rule set: {@link FORGE_CHANGE_REQUESTS_VERSION}
   * times 2^32 plus a 32-bit hash of the sorted `id@version` pairs, so every rule set folds and checkpoints apart.
   */
  readonly version: number
  /** Matches the raw arguments of a shell call that may name a rule's executable or `git push`. */
  readonly hint: RegExp
  /**
   * Classify the binding evidence a command and its output can carry. A rule's create subcommands print the change
   * request URL; its reference subcommands act on one change request, which their words or output can name; its API
   * requests bind only the change request their words name, since their output can list others. `git push`,
   * with or without leading `-C`, `-c`, and long options, prints the updated refs. When a command does both, the URLs a
   * result prints bind as created. The subcommand match is textual, so quoted mentions also classify; the output
   * readers then find no evidence.
   */
  evidence(command: string): CommandEvidence | undefined
  /** The change requests the literal simple commands of `command` name through a rule's `select`. */
  named(command: string): NamedChangeRequest[]
  /**
   * Find the change request URLs a result prints for its evidence: every page URL of a matched rule after a creation,
   * else the URLs a reference command prints for its own change request.
   */
  printed(text: string, evidence: CommandEvidence): string[]
  /** Whether `text`, a lookup's whole output, is one change request URL of rule `rule`. */
  lookupUrl(text: string, rule: string): string | undefined
}

/** Base of the `forgeChangeRequests` state version; raise it when forge-session's own folding changes. */
export const FORGE_CHANGE_REQUESTS_VERSION = 5

const PUSH_COMMAND = /\bgit(?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?))*\s+push\b/
const PUSH_TARGET_LINE = /^To (\S+)$/
const PUSH_REF_LINE = /^ [ +*=] (\[[^\]]+\]|\S+) +\S+ -> (\S+)(?: \(.*\))?$/
const EXECUTABLE = /^[A-Za-z\d][\w.-]*$/
const SUBCOMMAND = /^[a-z][a-z\d-]*$/
const MEMBER = /^[A-Za-z_][\w-]*$/
const OPTION = /^(?:-[A-Za-z\d]|--[A-Za-z\d][\w-]*)$/

/** One rule with the patterns compiled from its declaration. */
interface CompiledRule {
  readonly rule: ForgeCommandRule
  readonly create: RegExp
  readonly reference: RegExp
  /** A page URL anywhere in text. */
  readonly page: RegExp
  /** A page URL alone on a line, optionally after a `url:` label. */
  readonly line: RegExp
  /** A JSON member holding a page URL. */
  readonly member: RegExp | null
  /** The reference and API request groups with their options, in the order a command is parsed against them. */
  readonly groups: readonly CompiledGroup[]
}

/** One subcommand group with its options as sets. */
interface CompiledGroup {
  readonly kind: ForgeCommandArguments['kind']
  readonly subcommands: readonly (readonly string[])[]
  readonly values: ReadonlySet<string>
  readonly flags: ReadonlySet<string>
}

/**
 * Check one rule's declaration before it joins a rule set.
 * @param rule - the rule a provider registers.
 * @throws when a member is empty or malformed, an option is in both lists of a group, or its page path is not a regular expression.
 */
export function validateRule(rule: ForgeCommandRule): void {
  const name = JSON.stringify(rule.id)
  if (rule.id.trim() === '') throw new Error('forge-session: a command rule needs an id')
  if (!Number.isSafeInteger(rule.version) || rule.version <= 0) throw new Error(`forge-session: command rule ${name} needs a positive integer version`)
  if (!EXECUTABLE.test(rule.executable)) throw new Error(`forge-session: command rule ${name} names an invalid executable ${JSON.stringify(rule.executable)}`)
  const groups = [rule.references, rule.apiRequests]
  for (const sequence of [rule.creates, ...groups.map(group => group.subcommands)].flat()) {
    if (sequence.length === 0 || !sequence.every(word => SUBCOMMAND.test(word))) {
      throw new Error(`forge-session: command rule ${name} names an invalid subcommand ${JSON.stringify(sequence)}`)
    }
  }
  if (rule.creates.length + groups.reduce((total, group) => total + group.subcommands.length, 0) === 0) {
    throw new Error(`forge-session: command rule ${name} names no subcommand`)
  }
  for (const member of rule.urlMembers) {
    if (!MEMBER.test(member)) throw new Error(`forge-session: command rule ${name} names an invalid JSON member ${JSON.stringify(member)}`)
  }
  for (const group of groups) {
    for (const option of [...group.valueOptions, ...group.flagOptions]) {
      if (!OPTION.test(option)) throw new Error(`forge-session: command rule ${name} names an invalid option ${JSON.stringify(option)}`)
      if (group.valueOptions.includes(option) && group.flagOptions.includes(option)) {
        throw new Error(`forge-session: command rule ${name} lists option ${option} as both a value option and a flag`)
      }
    }
  }
  try {
    void new RegExp(rule.changeRequestPath)
  } catch (error) {
    throw new Error(`forge-session: command rule ${name} has an invalid changeRequestPath`, { cause: error })
  }
}

/**
 * Compile a rule set, which callers have validated with {@link validateRule}.
 * @param rules - the registered rules, ids and executables distinct.
 * @returns the compiled rules.
 */
export function compileRules(rules: readonly ForgeCommandRule[]): CommandRules {
  const compiled = rules.map(compileRule)
  const byExecutable = new Map(compiled.map(entry => [entry.rule.executable, entry]))
  const executables = compiled.map(entry => escape(entry.rule.executable))
  const named = new RegExp(executables.length === 0 ? '(?!)' : String.raw`(?:^|[^\w.-])(?:${executables.join('|')})(?![\w.-])`)
  const matching = (command: string, pattern: (entry: CompiledRule) => RegExp): string[] =>
    compiled.filter(entry => pattern(entry).test(command)).map(entry => entry.rule.id)
  const selections = (command: string): NamedChangeRequest[] => simpleCommands(command, named).flatMap((simple): NamedChangeRequest[] => {
    const entry = byExecutable.get(simple.executable)
    if (entry === undefined) return []
    const environment: Record<string, string> = {}
    for (const assignment of simple.assignments) {
      const split = assignment.indexOf('=')
      environment[assignment.slice(0, split)] = assignment.slice(split + 1)
    }
    const args = argumentsOf(simple.words, entry)
    const selected = args === undefined ? undefined : entry.rule.select(args, environment)
    if (args === undefined || selected === undefined) return []
    const named = { rule: entry.rule.id, kind: args.kind }
    if ('url' in selected) return [{ ...named, url: selected.url, lookup: null }]
    const lookup = simple.standalone ? quote(['env', ...simple.assignments, ...selected.lookup]) : null
    return [{ ...named, url: null, lookup }]
  })
  return {
    version: FORGE_CHANGE_REQUESTS_VERSION * 2 ** 32 + hash(rules.map(rule => `${rule.id}@${rule.version}`).sort().join(',')),
    hint: new RegExp([...executables, 'push'].join('|')),
    evidence(command) {
      const creates = matching(command, entry => entry.create)
      const selected = selections(command)
      // An API request binds the change request its words name; its output, which can list many, is not read.
      const references = [...matching(command, entry => entry.reference), ...selected.flatMap(entry => entry.kind === 'reference' ? [entry.rule] : [])]
      const pushes = PUSH_COMMAND.test(command)
      if (creates.length === 0 && references.length === 0 && selected.length === 0 && !pushes) return undefined
      return {
        urls: creates.length > 0 ? 'created' : references.length > 0 || selected.length > 0 ? 'referenced' : null,
        pushes,
        named: [...new Set(selected.flatMap(entry => entry.url === null ? [] : [entry.url]))],
        rules: [...new Set([...creates, ...references])],
      }
    },
    named: selections,
    printed(text, evidence) {
      const entries = compiled.filter(entry => evidence.rules.includes(entry.rule.id))
      return evidence.urls === 'created' ? pageUrls(text, entries) : ownUrls(text, entries)
    },
    lookupUrl(text, rule) {
      return compiled.filter(entry => entry.rule.id === rule).map(entry => entry.line.exec(text.trim())?.[1]).find(url => url !== undefined)
    },
  }
}

function compileRule(rule: ForgeCommandRule): CompiledRule {
  const subcommands = (sequences: readonly (readonly string[])[]): RegExp => new RegExp(sequences.length === 0 ? '(?!)'
    : String.raw`(?:^|[^\w.-])${escape(rule.executable)}\s+(?:${sequences.map(words => words.join(String.raw`\s+`)).join('|')})\b`)
  const page = String.raw`https?:\/\/[^\s"'<>]+?(?:${rule.changeRequestPath})`
  return {
    rule,
    create: subcommands(rule.creates),
    reference: subcommands(rule.references.subcommands),
    page: new RegExp(String.raw`\b${page}(?![\w-])`, 'g'),
    line: new RegExp(String.raw`^(?:url:\s+)?(${page})\/?$`),
    member: rule.urlMembers.length === 0 ? null
      : new RegExp(String.raw`"(?:${rule.urlMembers.map(escape).join('|')})"\s*:\s*"(${page})\/?"`, 'g'),
    groups: [groupOf('reference', rule.references), groupOf('api-request', rule.apiRequests)],
  }
}

function groupOf(kind: ForgeCommandArguments['kind'], group: ForgeCommandGroup): CompiledGroup {
  return { kind, subcommands: group.subcommands, values: new Set(group.valueOptions), flags: new Set(group.flagOptions) }
}

/**
 * Parse the words after a rule's executable against each of its groups in turn, and return the first parse that runs one
 * of the group's subcommands with only the group's options.
 */
function argumentsOf(words: readonly string[], entry: CompiledRule): ForgeCommandArguments | undefined {
  for (const group of entry.groups) {
    const parsed = parsedIn(words, group)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

function parsedIn(words: readonly string[], group: CompiledGroup): ForgeCommandArguments | undefined {
  const positional: string[] = []
  const values: [string, string][] = []
  let pending: string | undefined
  for (const word of words) {
    if (pending !== undefined) {
      values.push([pending, word])
      pending = undefined
    } else if (!word.startsWith('-') || word === '-') {
      positional.push(word)
    } else {
      const split = word.indexOf('=')
      const option = split === -1 ? word : word.slice(0, split)
      if (group.values.has(option)) {
        if (split === -1) pending = option
        else values.push([option, word.slice(split + 1)])
      } else if (!word.startsWith('--') && group.values.has(word.slice(0, 2))) {
        values.push([word.slice(0, 2), word.slice(2)])
      } else if (!group.flags.has(option)) {
        return undefined
      }
    }
  }
  if (pending !== undefined) return undefined
  const subcommand = group.subcommands.find(sequence => sequence.every((word, index) => positional[index] === word))
  return subcommand === undefined ? undefined : { kind: group.kind, subcommand, operands: positional.slice(subcommand.length), values }
}

/** Distinct page URLs of the rules anywhere in text, in order of first appearance. */
function pageUrls(text: string, entries: readonly CompiledRule[]): string[] {
  return [...new Set(entries.flatMap(entry => [...text.matchAll(entry.page)].map(match => match[0])))]
}

/**
 * The URLs a reference command prints for the change request it acts on: a `url:` field or a URL alone on a line
 * before the `--` line that starts a description, and the rules' JSON URL members. Links in a description or in other
 * fields name other pages.
 */
function ownUrls(text: string, entries: readonly CompiledRule[]): string[] {
  const urls: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line === '--') break
    for (const entry of entries) {
      const [, own] = entry.line.exec(line.trim()) ?? []
      if (own !== undefined) urls.push(own)
    }
  }
  for (const entry of entries) {
    if (entry.member !== null) for (const [, member = ''] of text.matchAll(entry.member)) urls.push(member)
  }
  return [...new Set(urls)]
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

/** FNV-1a hash of a string's UTF-16 code units, as an unsigned 32-bit integer. */
function hash(text: string): number {
  let value = 0x811c9dc5
  for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 0x01000193)
  return value >>> 0
}

/**
 * Read the command string of a `bash` or `pwsh` tool call.
 * @param argumentsJson - raw tool-call arguments as the model produced them.
 * @returns the command, or undefined when the arguments are not JSON or carry no string `command`.
 */
export function commandOf(argumentsJson: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch (error) {
    void error // Malformed arguments never ran a command.
    return undefined
  }
  return commandIn(parsed)
}

/**
 * Read the command string of parsed `bash` or `pwsh` arguments, such as the
 * arguments a program dispatch logs.
 * @param args - parsed tool arguments.
 * @returns the command, or undefined when the arguments carry no string `command`.
 */
export function commandIn(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || !('command' in args)) return undefined
  return typeof args.command === 'string' ? args.command : undefined
}

/**
 * Find branches that `git push` output reports as created, updated, forced,
 * or already up to date. Each ref line belongs to the nearest preceding
 * `To <remote>` line. Rejected and deleted refs, new tags, and explicit refs
 * outside `refs/heads/` are excluded. Unqualified tag updates cannot be
 * distinguished from branch updates and are included.
 * @param text - rendered shell result, stdout and stderr.
 * @returns distinct pushed branches in order of first appearance.
 */
export function pushedBranches(text: string): PushedRef[] {
  const pushed: PushedRef[] = []
  let remote: string | undefined
  for (const line of text.split(/\r?\n/)) {
    const target = PUSH_TARGET_LINE.exec(line)
    if (target !== null) {
      [, remote = ''] = target
      continue
    }
    const ref = PUSH_REF_LINE.exec(line)
    if (remote === undefined || ref === null) continue
    const [, summary = '', destination = ''] = ref
    if (summary === '[new tag]') continue
    const branch = destination.startsWith('refs/heads/') ? destination.slice('refs/heads/'.length) : destination
    if (branch.startsWith('refs/')) continue
    if (!pushed.some(entry => entry.remote === remote && entry.branch === branch)) pushed.push({ remote, branch })
  }
  return pushed
}

/**
 * Compare two change request URLs ignoring scheme, letter case, query,
 * fragment, and trailing slashes.
 * @param left - one URL.
 * @param right - the other URL.
 * @returns whether both name the same web page.
 */
export function sameChangeRequestUrl(left: string, right: string): boolean {
  return urlIdentity(left) === urlIdentity(right)
}

function urlIdentity(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/[?#].*$/s, '').replace(/\/+$/, '').toLowerCase()
}
