/** Pure terminal-card derivation from raw Tool call and result fields. @module */
import type { TerminalBlockLabels, TerminalBlockProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import { hasSpillNotice } from '@deepseek-ai/dsh-spill-policy/notice'
import type { ToolCallBlock } from './tool-call-model.ts'
import { parsedToolCall, singleResultText, validEscalationFields } from './raw-tool-call.ts'

/**
 * Build the TerminalBlock display copy from the conversation locale seat —
 * the one place the primitive's label surface pairs with this package's
 * dictionary, shared by every terminal render site (chat row, bash row,
 * details panel).
 * @param t - the render site's conversation locale seat.
 * @returns the full label set for {@link TerminalBlockProps}'s `labels`.
 */
export function terminalBlockLabels(t: TranslateNS<'conversation'>): TerminalBlockLabels {
  return {
    signal: signal => t('terminal.signal', { signal }),
    exitCode: code => t('terminal.exitCode', { code }),
    running: t('terminal.running'),
    failed: t('terminal.failed'),
    done: t('terminal.done'),
    copy: t('copy'),
    copied: t('copied'),
    noOutput: t('terminal.noOutput'),
    collapseAria: t('terminal.collapseAria'),
    collapse: t('collapse'),
    expandAria: hidden => t('terminal.expandAria', { n: hidden }),
    expand: hidden => t('terminal.expandRest', { n: hidden }),
  }
}

/**
 * The {@link TerminalBlock} props this derivation owns. Picked off the
 * primitive's props so the two stay in step; `maxLines`/`className` belong to
 * each render site.
 */
export interface TerminalCardModel {
  /**
   * The locale-neutral props {@link TerminalBlock} draws. The render site adds
   * `command` after resolving {@link copy} through its locale seat.
   */
  card: Pick<TerminalBlockProps, 'cwd' | 'output' | 'exitCode' | 'signal' | 'running'>
  /**
   * Verbatim Tool data or semantic `terminal_send` data. Product copy stays
   * unresolved until a render site supplies its locale seat.
   */
  copy:
    | { readonly kind: 'shell'; readonly command: string; readonly description: string | undefined }
    | { readonly kind: 'terminal-send'; readonly text: string; readonly sessionId: string }
}

interface LocalizedTerminalCardModel {
  readonly card: Pick<TerminalBlockProps, 'command' | 'cwd' | 'output' | 'exitCode' | 'signal' | 'running'>
  readonly description: string | undefined
}

/**
 * Resolve locale-owned `terminal_send` copy while preserving Tool-authored
 * shell commands and descriptions verbatim.
 * @param model - locale-neutral terminal card data.
 * @param t - the render site's conversation locale seat.
 * @returns terminal props and description ready for rendering.
 */
export function localizeTerminalCardModel(
  model: TerminalCardModel,
  t: TranslateNS<'conversation'>,
): LocalizedTerminalCardModel {
  if (model.copy.kind === 'shell') {
    return {
      card: { command: model.copy.command, ...model.card },
      description: model.copy.description,
    }
  }
  return {
    card: {
      command: model.copy.text === '' ? t('terminal.sendInput') : model.copy.text,
      ...model.card,
    },
    description: t('terminal.session', { sessionId: model.copy.sessionId }),
  }
}

/**
 * True when a settled terminal card reports a failing exit — a non-zero code
 * or a terminating signal. The bash tool settles a failing command as a
 * completed call (`isError` stays false: the exit status is result data), so
 * this is the collapsed row's only failure signal; without it the red exit
 * pill would be visible only after expanding the card.
 * @param model - a derived terminal card.
 * @returns whether the card's exit status is a failure.
 */
export function terminalFailed(model: TerminalCardModel): boolean {
  const { exitCode, signal, running } = model.card
  return running !== true && ((exitCode !== undefined && exitCode !== 0) || signal !== undefined)
}

/**
 * Resolve a shell call's workdir for display: an absolute path is used as-is,
 * a relative one joins under the session workspace, and an omitted one is the
 * session workspace. Without a session cwd, a relative path stays as authored
 * and an omitted one stays absent.
 * @param workdir - the raw call's workdir, if any.
 * @param sessionCwd - the session workspace root, if the caller knows it.
 * @returns the working directory for the prompt label, or undefined.
 */
function resolveTerminalCwd(workdir: string | undefined, sessionCwd: string | undefined): string | undefined {
  if (workdir === undefined || workdir === '') return sessionCwd
  if (sessionCwd === undefined || sessionCwd === '') return normalizeSegments(workdir)
  return normalizeSegments(resolveWorkspacePath(sessionCwd, workdir))
}

/**
 * Collapse `.` and `..` segments so the prompt label names the directory the
 * command actually ran in. The bash executor resolves the workdir before
 * running, so a joined `/w/app/..` must display as `w`, not as `..`. Separators
 * are preserved as authored (a Windows path keeps its backslashes) because this
 * value is only ever displayed; a `..` that would climb past the root is
 * dropped, which is what a filesystem does with it. A UNC path's `server` and
 * `share` are part of its root, not poppable segments: Windows cannot climb
 * above a share, so `\\\\server\\share` with a `..` stays there.
 * @param path - a joined or absolute path, possibly carrying `.`/`..` segments.
 * @returns the same path with those segments resolved.
 */
function normalizeSegments(path: string): string {
  if (!/(?:^|[/\\])\.\.?(?:[/\\]|$)/.test(path)) return path
  // A UNC path is `\\\\server\\share\\...`: the server and share form the root,
  // so they are split off here and neither is a segment `..` may pop. Its
  // separator is fixed to a backslash, since a joined relative part may have
  // introduced a forward slash that UNC syntax does not use.
  const unc = /^[/\\]{2}([^/\\]+)[/\\]+([^/\\]+)/.exec(path)
  if (unc !== null) {
    // Both groups are mandatory in the pattern, so destructuring types them as
    // strings without an assertion.
    const [matched, server, share] = unc
    const root = `\\\\${String(server)}\\${String(share)}`
    // Rooted: what follows the share hangs off it, so a `..` at the top is
    // dropped rather than kept — Windows cannot climb above a share.
    const rest = collapse(path.slice(matched.length), true)
    return rest === '' ? root : `${root}\\${rest}`
  }
  const backslashed = path.includes('\\') && !path.includes('/')
  const separator = backslashed ? '\\' : '/'
  const rooted = /^[/\\]/.test(path)
  const drive = /^[A-Za-z]:/.exec(path)?.[0] ?? ''
  const body = collapse(path.slice(drive.length), rooted || drive !== '', separator)
  const leading = rooted ? separator : ''
  return drive === '' ? `${leading}${body}` : `${drive}${rooted ? leading : separator}${body}`
}

/**
 * Collapse the `.`/`..` segments of a path body against a known root state.
 * @param body - the path after any drive letter or UNC root.
 * @param rooted - the body hangs off a root, so a `..` at its top is dropped
 *   the way a filesystem drops one; without a root the `..` is kept, since it
 *   stays meaningful against a cwd this function cannot see.
 * @param separator - separator to rejoin with (default `/`).
 * @returns the collapsed body, without leading or trailing separators.
 */
function collapse(body: string, rooted: boolean, separator = '/'): string {
  const kept: string[] = []
  for (const segment of body.split(/[/\\]/)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (kept.length > 0 && kept[kept.length - 1] !== '..') kept.pop()
      else if (!rooted) kept.push(segment)
      continue
    }
    kept.push(segment)
  }
  return kept.join(separator)
}

interface ShellCall {
  kind: 'shell'
  command: string
  description: string | undefined
  workdir: string | undefined
  persistent: boolean
  background: boolean
}

function shellCall(name: string, args: Record<string, unknown>): ShellCall | null {
  if (name !== 'bash' && name !== 'pwsh') return null
  const { command, description, timeoutMs, workdir, run_in_background: background } = args
  if (typeof command !== 'string' || command.trim() === '') return null
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) return null
  if (workdir !== undefined && typeof workdir !== 'string') return null
  if (background !== undefined && typeof background !== 'boolean') return null
  if (!validEscalationFields(args)) return null
  if (description === undefined) {
    // Standard dsh-tool-bash and dsh-tool-pwsh schemas require `description`;
    // persistent shell providers omit it. Their parameter roots stay open, so
    // unrelated fields do not change their running-card behavior.
    return { kind: 'shell', command, description: undefined, workdir: undefined, persistent: true, background: false }
  }
  if (typeof description !== 'string' || description.trim() === '') return null
  return {
    kind: 'shell',
    command,
    description,
    workdir,
    persistent: false,
    background: background === true,
  }
}

/**
 * Identify a settled root call from the persistent Bash or PowerShell tool.
 * Its result stays on the generic input/output path because the persistent
 * shell can report resets and partial output without one process exit status.
 * @param block - running or settled Tool block.
 * @returns whether the block is a settled persistent-shell call.
 */
export function isSettledPersistentShellCall(block: ToolCallBlock): boolean {
  if (!('kind' in block) || block.parentCallId !== undefined) return false
  const parsed = parsedToolCall(block)
  if (parsed === null) return false
  return shellCall(parsed.name, parsed.args)?.persistent === true
}

/**
 * Identify a settled foreground shell preview whose spill footer can hide the exit marker.
 * @param block - running or settled Tool block.
 * @returns whether the shell output must remain generic without an inferred exit status.
 */
export function isSpilledShellCall(block: ToolCallBlock): boolean {
  if (!('kind' in block)) return false
  const parsed = parsedToolCall(block)
  if (parsed === null) return false
  const call = shellCall(parsed.name, parsed.args)
  if (call === null || call.background) return false
  const output = singleResultText(block)
  return output !== undefined && hasSpillNotice(output)
}

interface TerminalSendCall {
  kind: 'terminal-send'
  text: string
  sessionId: string
  background: boolean
}

function terminalSendCall(name: string, args: Record<string, unknown>): TerminalSendCall | null {
  if (name !== 'terminal_send') return null
  const { sessionId, text, submit, run_in_background: background } = args
  if (typeof sessionId !== 'string' || sessionId === '' || typeof text !== 'string') return null
  if (submit !== undefined && typeof submit !== 'boolean') return null
  if (background !== undefined && typeof background !== 'boolean') return null
  return {
    kind: 'terminal-send',
    text,
    sessionId,
    background: background === true,
  }
}

/**
 * Parse the marker literals owned by `@deepseek-ai/dsh-shell/render` without
 * importing that Host-only package into the Client dependency graph.
 * @param text - rendered shell result text.
 * @returns output with a trailing exit-code or signal marker extracted.
 */
function parseExitStatus(text: string): { output: string; exitCode?: number; signal?: string } {
  const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text)
  if (signal?.[1] !== undefined) return { output: text.slice(0, signal.index), signal: signal[1] }
  const exit = /\n\[exit code: (\d+)\]$/.exec(text)
  if (exit?.[1] !== undefined) return { output: text.slice(0, exit.index), exitCode: Number(exit[1]) }
  return { output: text, exitCode: 0 }
}

/**
 * Derive terminal props for supported shell and terminal-send calls, including
 * nested Code Dispatch calls. Standard shell results parse their final status
 * marker; persistent shell results, spill previews, background calls, errors,
 * and malformed input use the generic path. {@link isSettledPersistentShellCall} lets that generic
 * persistent result remain expandable without inventing one process status.
 * @param block - running or settled Tool block.
 * @param sessionCwd - session workspace root used to resolve workdir.
 * @returns locale-neutral terminal-card data, or null for the generic path.
 */
export function terminalCardModel(
  block: ToolCallBlock,
  sessionCwd?: string,
): TerminalCardModel | null {
  const parsed = parsedToolCall(block)
  if (parsed === null) return null
  const call = shellCall(parsed.name, parsed.args) ?? terminalSendCall(parsed.name, parsed.args)
  if (call === null || call.background) return null

  const copy: TerminalCardModel['copy'] = call.kind === 'shell'
    ? { kind: 'shell', command: call.command, description: call.description }
    : { kind: 'terminal-send', text: call.text, sessionId: call.sessionId }
  const cwd = resolveTerminalCwd(call.kind === 'shell' ? call.workdir : undefined, sessionCwd)
  if (!('kind' in block)) {
    return {
      copy,
      card: {
        cwd,
        output: undefined,
        exitCode: undefined,
        signal: undefined,
        running: true,
      },
    }
  }
  if (block.isError || (call.kind === 'shell' && call.persistent) || isSpilledShellCall(block)) return null
  const output = singleResultText(block)
  if (output === undefined) return null
  const status = call.kind === 'terminal-send' ? { output } : parseExitStatus(output)
  return {
    copy,
    card: {
      cwd,
      output: status.output,
      exitCode: status.exitCode,
      signal: status.signal,
      running: false,
    },
  }
}
