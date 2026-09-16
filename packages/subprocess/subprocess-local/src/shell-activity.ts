/** Private shell lifecycle files; ordinary output never authorizes terminal reclamation. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { SubprocessTerminalActivity, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

/** Opt-in startup integration and revision tracking for one ordinary interactive shell. */
export class ShellActivity {
  private revision = 0
  private observed = ''
  private invalidated: string | undefined
  private state: SubprocessTerminalActivity['state'] = 'unknown'

  /**
   * @param directory - private startup and status file directory.
   * @param argv - shell launch preserving supported user startup files.
   * @param env - environment with any temporary startup redirect.
   */
  constructor(private readonly directory: string, readonly argv: readonly string[], readonly env: Record<string, string>) {}

  /** Invalidate prompt evidence before delivering input or a foreground signal. */
  invalidate(): void {
    this.invalidated = this.read()
    this.revision++
    this.state = 'unknown'
  }

  /**
   * Read the latest top-level shell transition, fenced against input since that transition.
   * @param pid - original shell process id.
   * @returns lifecycle evidence; process ownership must be checked separately.
   */
  inspect(pid: number): SubprocessTerminalActivity {
    const record = this.read()
    if (record !== this.observed) { this.observed = record; this.revision++ }
    const match = /^(\d+):(\d+):(idle|busy)\n?$/u.exec(record)
    this.state = record === this.invalidated || match?.[1] !== String(pid) ? 'unknown'
      : match[3] as 'idle' | 'busy'
    return { state: this.state, revision: this.revision }
  }

  /** Remove private startup and status files after process quiescence. */
  dispose(): void { rmSync(this.directory, { recursive: true, force: true }) }

  private read(): string {
    try { return readFileSync(join(this.directory, 'state'), 'utf8') }
    catch (_unavailableShellObservation) { return '' }
  }
}

/**
 * Prepare optional Bash or Zsh integration for a plain, non-login interactive launch.
 * @param spec - terminal request; custom arguments and wrapped executables remain unmodified.
 * @param env - scrubbed target environment.
 * @param platform - execution platform.
 * @returns private integration, or undefined for unsupported launches.
 */
export function prepareShellActivity(
  spec: SubprocessTerminalSpawnSpec, env: Record<string, string>, platform: NodeJS.Platform,
): ShellActivity | undefined {
  if (spec.shellActivity !== true || platform === 'win32' || spec.argv.length !== 2 || spec.argv[1] !== '-i') return undefined
  const shell = basename(spec.argv[0] as string)
  if (shell !== 'bash' && shell !== 'zsh') return undefined
  const directory = mkdtempSync(join(tmpdir(), 'dsh-shell-'))
  const state = quote(join(directory, 'state'))
  const guards = quote(join(directory, 'guards'))
  try {
    if (shell === 'bash') {
      const rc = join(directory, 'bashrc')
      writeFileSync(rc, [
        '[[ ! -r ~/.bashrc ]] || builtin source ~/.bashrc',
        'if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )) && [[ ! $(declare -p PROMPT_COMMAND PS0 2>/dev/null) =~ declare\\ -[^[:space:]]*r ]]; then',
        '  __dsh_shell_pid=$BASHPID; __dsh_shell_sequence=0',
        '  __dsh_shell_idle() {',
        '    local result=$?',
        '    if [[ $BASHPID == "$__dsh_shell_pid" ]]; then',
        '      (( ++__dsh_shell_sequence ))',
        '      local activity=idle',
        `      builtin trap -p >| ${guards}`,
        `      [[ ! -s ${guards} ]] || activity=unknown`,
        `      builtin printf '%s:%s:%s\\n' "$BASHPID" "$__dsh_shell_sequence" "$activity" >| ${state}`,
        '    fi',
        '    return "$result"',
        '  }',
        '  if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == "declare -a "* ]]; then',
        '    PROMPT_COMMAND+=(__dsh_shell_idle)',
        '  else',
        '    PROMPT_COMMAND="${PROMPT_COMMAND}"$\'\\n\'"__dsh_shell_idle"',
        '  fi',
        `  PS0+=${quote(`$(builtin printf '%s:%s:busy' "$__dsh_shell_pid" "$__dsh_shell_sequence" >| ${state})`)}`,
        'fi',
        '',
      ].join('\n'), { mode: 0o600, flag: 'wx' })
      return new ShellActivity(directory, [spec.argv[0] as string, '--rcfile', rc, '-i'], env)
    }
    writeFileSync(join(directory, '.zshenv'), [
      env.ZDOTDIR === undefined ? 'unset ZDOTDIR' : `ZDOTDIR=${quote(env.ZDOTDIR)}`,
      '[[ ! -r ${ZDOTDIR:-$HOME}/.zshenv ]] || builtin source "${ZDOTDIR:-$HOME}/.zshenv"',
      'typeset -g __dsh_shell_pid=$$ __dsh_shell_sequence=0',
      '__dsh_shell_activity() {',
      '  (( ZSH_SUBSHELL == 0 && $$ == __dsh_shell_pid )) || return',
      '  (( ++__dsh_shell_sequence ))',
      `  builtin printf '%s:%s:%s\\n' "$$" "$__dsh_shell_sequence" "$1" >| ${state}`,
      '  return 0',
      '}',
      '__dsh_shell_idle() {',
      `  { builtin trap; zle -F; } >| ${guards}`,
      '  if [[ $CONTEXT != start || -n $BUFFER ]]; then __dsh_shell_activity busy',
      `  elif [[ -s ${guards}` + ' || -n ${(k)functions[(I)TRAP*]} ]]; then __dsh_shell_activity unknown',
      '  else __dsh_shell_activity idle; fi',
      '}',
      '__dsh_shell_busy() { __dsh_shell_activity busy }',
      '__dsh_shell_init() {',
      '  autoload -Uz add-zle-hook-widget add-zsh-hook',
      '  add-zle-hook-widget line-init __dsh_shell_idle',
      '  add-zle-hook-widget line-finish __dsh_shell_busy',
      '  add-zsh-hook preexec __dsh_shell_busy',
      '  precmd_functions=(${precmd_functions:#__dsh_shell_init})',
      '}',
      'typeset -ga precmd_functions',
      'precmd_functions+=(__dsh_shell_init)',
      '',
    ].join('\n'), { mode: 0o600, flag: 'wx' })
    return new ShellActivity(directory, spec.argv, { ...env, ZDOTDIR: directory })
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}
