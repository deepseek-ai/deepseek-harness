/** Recognition of shell commands and output that bind change requests to a Session. */

import type { CommandEvidence } from './types.ts'
import { ghReferences } from './references.ts'

/** One branch a `git push` output reported as updated. */
export interface PushedRef {
  /** Remote as `git push` printed it after `To`. */
  readonly remote: string
  /** Branch name on the remote. */
  readonly branch: string
}

const CREATE_COMMAND = /\bgh\s+pr\s+(?:create|new)\b/
const REFERENCE_COMMAND = /\bgh\s+pr\s+(?:view|edit|checkout)\b/
const OWN_URL_LINE = /^(?:url:\s+)?(https?:\/\/[^\s"'<>]+?\/pull\/\d+)\/?$/
const OWN_URL_MEMBER = /"url"\s*:\s*"(https?:\/\/[^\s"'<>]+?\/pull\/\d+)\/?"/g
const PUSH_COMMAND = /\bgit(?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?))*\s+push\b/
const CHANGE_REQUEST_URL = /\bhttps?:\/\/[^\s"'<>]+?\/pull\/\d+(?![\w-])/g
const PUSH_TARGET_LINE = /^To (\S+)$/
const PUSH_REF_LINE = /^ [ +*=] (\[[^\]]+\]|\S+) +\S+ -> (\S+)(?: \(.*\))?$/

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
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const command: unknown = (parsed as { command?: unknown }).command
  return typeof command === 'string' ? command : undefined
}

/**
 * Classify the binding evidence a command and its output can carry.
 * `gh pr create` (or its alias `gh pr new`) prints the change request URL;
 * `gh pr view`, `gh pr edit`, and `gh pr checkout` act on one change request,
 * which a URL or a number with an explicit repository and host can name;
 * their output can also print its URL. `git push`,
 * with or without leading `-C`, `-c`, and long options, prints the updated
 * refs. When a command does both, the URLs a result prints bind as created.
 * The match is textual, so quoted mentions also classify; the result parsers
 * then find no evidence in their output.
 * @param command - shell command text.
 * @returns the evidence, or undefined when the command has none of these forms.
 */
export function commandEvidence(command: string): CommandEvidence | undefined {
  const create = CREATE_COMMAND.test(command)
  const references = ghReferences(command)
  const reference = REFERENCE_COMMAND.test(command) || references.length > 0
  const pushes = PUSH_COMMAND.test(command)
  if (!create && !reference && !pushes) return undefined
  const named = [...new Set(references.flatMap(reference => reference.url === null ? [] : [reference.url]))]
  return { urls: create ? 'created' : reference ? 'referenced' : null, pushes, named }
}

/**
 * Find GitHub pull request URLs in command output.
 * @param text - rendered shell result.
 * @returns distinct URLs in order of first appearance.
 */
export function changeRequestUrls(text: string): string[] {
  return [...new Set(text.match(CHANGE_REQUEST_URL))]
}

/**
 * Find the URLs that `gh pr view`, `gh pr edit`, or `gh pr checkout` output
 * prints for the change request it acts on: gh's `url:` field or a URL alone
 * on a line before the `--` line that starts a description, and JSON `url`
 * members. Links in a description or in other fields name other pages.
 * @param text - rendered shell result.
 * @returns distinct URLs in order of first appearance.
 */
export function ownChangeRequestUrls(text: string): string[] {
  const urls: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line === '--') break
    const [, own] = OWN_URL_LINE.exec(line.trim()) ?? []
    if (own !== undefined) urls.push(own)
  }
  for (const [, member = ''] of text.matchAll(OWN_URL_MEMBER)) urls.push(member)
  return [...new Set(urls)]
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
