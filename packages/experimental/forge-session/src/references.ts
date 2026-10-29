/** Literal GitHub CLI references, with shell quoting and command separators preserved. */

import parse from 'shell-quote/parse.js'
import quote from 'shell-quote/quote.js'

/** One PR explicitly selected by a supported GitHub CLI invocation. */
export interface GhReference {
  /** Canonical URL when the command supplies its host, otherwise null. */
  readonly url: string | null
  /** Read-only command for an unqualified repository in the first simple command, otherwise null. */
  readonly lookup: string | null
}

const VALUE_OPTIONS = new Set([
  '--json', '--jq', '-q', '--template', '-t', '--title', '--body', '-b', '--body-file', '-F', '--base', '-B',
  '--add-assignee', '--add-label', '--add-project', '--add-reviewer', '--milestone', '-m', '--remove-assignee',
  '--remove-label', '--remove-project', '--remove-reviewer', '--branch',
])
const BOOLEAN_OPTIONS = new Set(['--comments', '-c', '--web', '-w', '--detach', '-d', '--force', '-f', '--recurse-submodules', '--remove-milestone'])
const SEPARATORS = new Set(['&&', '||', ';', '|', '|&', '&'])
const REPOSITORY = /^(?:([a-z\d.-]+(?::\d+)?)\/)?([a-z\d_-]+)\/([a-z\d_.-]+)$/i

/**
 * Read explicit URL selectors or numeric selectors with `--repo`/`-R`.
 * Shell expansion, multiline scripts, substitutions, and unsupported options
 * are excluded. Unqualified repositories can be resolved only for a single
 * simple command, optionally piped to an output filter; compound commands
 * may change the CLI environment. PowerShell callers may use only `url`.
 * @param command - logged shell command text.
 * @returns references in command order; no process or environment is read.
 */
export function ghReferences(command: string): GhReference[] {
  if (/[\r\n`]|\$\(/.test(command) || !/^(?:[^'"\\]|\\.|'(?:[^']*)'|"(?:[^"\\]|\\.)*")*$/.test(command)) return []
  let tokens: parse.ParseEntry[]
  try {
    tokens = parse(command, () => { throw new Error('dynamic shell word') })
  } catch (error) {
    void error // An unresolved or malformed shell word cannot identify a repository.
    return []
  }
  const references: GhReference[] = []
  const compound = tokens.some((token, index) => {
    const next = tokens[index + 1]
    return typeof token !== 'string' && 'op' in token
      && (['&&', '||', ';', '&'].includes(token.op)
        || (['|', '|&'].includes(token.op) && (typeof next !== 'string' || !['head', 'tail', 'cat'].includes(next))))
  })
  let words: string[] = []
  let first = true
  let unsupported = false
  const flush = () => {
    const reference = unsupported ? undefined : referenceOf(words, first && !compound)
    if (reference !== undefined) references.push(reference)
    words = []
    first = false
    unsupported = false
  }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (typeof token === 'string') {
      words.push(token)
    } else if (token !== undefined && 'op' in token && SEPARATORS.has(token.op)) {
      flush()
    } else if (token !== undefined && 'op' in token && token.op === '>&' && words.at(-1) === '2' && tokens[index + 1] === '1') {
      words.pop()
      index++
    } else {
      unsupported = true
    }
  }
  flush()
  return references
}

function referenceOf(words: readonly string[], allowLookup: boolean): GhReference | undefined {
  const environment: string[] = []
  let executable = words[0] === 'env' ? 1 : 0
  for (const word of words.slice(executable)) {
    if (!/^[A-Za-z_][A-Za-z\d_]*=/.test(word)) break
    environment.push(word)
    executable++
  }
  if (words[executable] !== 'gh') return undefined
  let repository: string | undefined
  let take: 'repo' | 'value' | null = null
  const positional: string[] = []
  for (const arg of words.slice(executable + 1)) {
    if (take !== null) {
      if (take === 'repo') repository = arg
      take = null
      continue
    }
    if (arg === '--repo' || arg === '-R') {
      take = 'repo'
    } else if (arg.startsWith('--repo=')) {
      repository = arg.slice('--repo='.length)
    } else if (arg.startsWith('-R') && arg.length > 2) {
      repository = arg.slice(2)
    } else {
      const option = arg.replace(/=.*/, '')
      if (VALUE_OPTIONS.has(option)) {
        if (!arg.includes('=')) take = 'value'
      } else if (!BOOLEAN_OPTIONS.has(option)) {
        if (arg.startsWith('-')) return undefined
        positional.push(arg)
      }
    }
  }
  if (take !== null) return undefined
  const [resource, operation, selector] = positional
  if (resource !== 'pr' || !['view', 'edit', 'checkout'].includes(operation ?? '') || selector === undefined || positional.length !== 3) return undefined
  const url = /^(https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/[1-9]\d*)(?:[/?#].*)?$/.exec(selector)?.[1]
  if (url !== undefined) return { url, lookup: null }
  if (!/^[1-9]\d*$/.test(selector) || !Number.isSafeInteger(Number(selector)) || repository === undefined) return undefined
  const match = REPOSITORY.exec(repository.replace(/^https?:\/\//, '').replace(/\.git$/, ''))
  if (match === null || match[3] === '.' || match[3] === '..') return undefined
  const [, repoHost, owner, name] = match
  const host = repoHost ?? environment.findLast(entry => entry.startsWith('GH_HOST='))?.slice('GH_HOST='.length)
  if (host !== undefined && /^[a-z\d.-]+(?::\d+)?$/i.test(host)) return { url: `https://${host}/${owner}/${name}/pull/${selector}`, lookup: null }
  return {
    url: null,
    lookup: allowLookup ? quote(['env', ...environment, 'gh', 'pr', 'view', selector, '--repo', repository, '--json', 'url']) : null,
  }
}
