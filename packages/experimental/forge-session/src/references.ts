/** Literal simple commands of a shell command line, with shell quoting and command separators preserved. */

import parse from 'shell-quote/parse.js'

/** One simple command of a command line: variable assignments, an executable, and its words. */
export interface SimpleCommand {
  /** Variable assignments before the executable as written, such as `GH_HOST=ghe.example`. */
  readonly assignments: readonly string[]
  /** Executable word. */
  readonly executable: string
  /** Words after the executable, with shell quoting removed. */
  readonly words: readonly string[]
  /**
   * Whether the command is the first of a command line that runs nothing else but an output filter (`head`, `tail`,
   * `cat`), so a lookup in the same shell sees the environment the command saw.
   */
  readonly standalone: boolean
}

const SEPARATORS = new Set(['&&', '||', ';', '|', '|&', '&'])
const FILTERS = new Set(['head', 'tail', 'cat'])

/**
 * Split a command line into its literal simple commands. Shell expansion, multiline scripts, substitutions, unbalanced
 * quotes, and operators other than separators and `2>&1` are excluded: a line with an expansion or substitution yields
 * no command, and a simple command with another operator is left out.
 * @param command - logged shell command text.
 * @param named - executables worth splitting for; a line that names none yields no command without tokenizing.
 * @returns the simple commands in command order; no process or environment is read.
 */
export function simpleCommands(command: string, named: RegExp): SimpleCommand[] {
  if (!named.test(command)) return []
  if (/[\r\n`]|\$\(/.test(command) || !/^(?:[^'"\\]|\\.|'(?:[^']*)'|"(?:[^"\\]|\\.)*")*$/.test(command)) return []
  let tokens: parse.ParseEntry[]
  try {
    tokens = parse(command, () => { throw new Error('dynamic shell word') })
  } catch (error) {
    void error // An unresolved or malformed shell word names no executable.
    return []
  }
  const compound = tokens.some((token, index) => {
    const next = tokens[index + 1]
    return typeof token !== 'string' && 'op' in token
      && (['&&', '||', ';', '&'].includes(token.op)
        || (['|', '|&'].includes(token.op) && (typeof next !== 'string' || !FILTERS.has(next))))
  })
  const commands: SimpleCommand[] = []
  let words: string[] = []
  let first = true
  let unsupported = false
  const flush = () => {
    const simple = unsupported ? undefined : simpleOf(words, first && !compound)
    if (simple !== undefined) commands.push(simple)
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
  return commands
}

/** Read the assignments, executable, and words of one simple command, after an optional `env`. */
function simpleOf(words: readonly string[], standalone: boolean): SimpleCommand | undefined {
  let executable = words[0] === 'env' ? 1 : 0
  const assignments: string[] = []
  for (const word of words.slice(executable)) {
    if (!/^[A-Za-z_][A-Za-z\d_]*=/.test(word)) break
    assignments.push(word)
    executable++
  }
  const name = words[executable]
  return name === undefined ? undefined : { assignments, executable: name, words: words.slice(executable + 1), standalone }
}
