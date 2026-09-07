import { useCallback, useMemo, useState } from 'react'
import clsx from 'clsx'
import { parseAnsiLines, type AnsiLine } from './ansi.ts'
import { headTailCap } from './head-tail-cap.ts'
import { useCopyFeedback } from './use-copy-feedback.ts'
import { Pill } from './Pill.tsx'
import { StateDot, type StateDotState } from './StateDot.tsx'
import css from './TerminalBlock.module.css'

/** Output lines shown before the height cap collapses the middle. */
export const DEFAULT_TERMINAL_MAX_LINES = 16

/**
 * Display copy for the terminal surface; the owner passes localized labels
 * (this package is cordis-free, so copy arrives via props).
 */
export interface TerminalBlockLabels {
  /** Status pill text for a signal-terminated command. */
  signal: (signal: string) => string
  /** Status pill text for a non-zero exit code. */
  exitCode: (exitCode: number) => string
  /** Run-state text while the command is still running. */
  running: string
  /** Run-state text for a signal or non-zero-exit settle. */
  failed: string
  /** Run-state text for a clean settle. */
  done: string
  /** Copy-button idle label. */
  copy: string
  /** Copy-button label during the post-copy confirmation window. */
  copied: string
  /** Placeholder when a settled command produced no visible output. */
  noOutput: string
  /** Collapse-toggle aria label while expanded. */
  collapseAria: string
  /** Collapse-toggle text while expanded. */
  collapse: string
  /** Expand-toggle aria label while capped, given the hidden line count. */
  expandAria: (hidden: number) => string
  /** Expand-toggle text while capped, given the hidden line count. */
  expand: (hidden: number) => string
}

export interface TerminalBlockProps {
  /** The command line, rendered verbatim after the prompt label. */
  command: string
  /** Working directory for the prompt label; absent renders a plain `$`. */
  cwd?: string | undefined
  /** Absolute home directory, so a cwd equal to it collapses to `~`; absent disables that collapse. */
  home?: string | undefined
  /** The command's output text; may contain ANSI escape sequences. */
  output?: string | undefined
  /** Settled exit code; a non-zero value renders the status pill. */
  exitCode?: number | undefined
  /** Settled terminating signal name; any value renders the status pill, taking precedence over the exit code. */
  signal?: string | undefined
  /** The command is still running: the block shows the prompt line alone. */
  running?: boolean | undefined
  /** Height cap in output lines before the middle collapses (default {@link DEFAULT_TERMINAL_MAX_LINES}); Infinity disables the cap. */
  maxLines?: number | undefined
  /** Extra class merged onto the wrapper (callers position; this component draws). */
  className?: string | undefined
  /** Localized display copy supplied by the owning render site. */
  labels: TerminalBlockLabels
}

/**
 * Prompt label for a working directory: `~` for the home directory itself,
 * otherwise the path's last segment (both separators accepted, trailing
 * separators ignored), falling back to the path itself when it has no
 * segment.
 * @param cwd - the working directory path.
 * @param home - absolute home directory, when the caller knows it.
 * @returns the prompt label.
 */
function promptLabel(cwd: string, home: string | undefined): string {
  const trimmed = cwd.replace(/[/\\]+$/, '')
  if (home !== undefined && trimmed === home.replace(/[/\\]+$/, '')) return '~'
  const segment = trimmed.split(/[/\\]/).pop()
  return segment === undefined || segment === '' ? cwd : segment
}

/**
 * Status pill text for a settled command, or undefined when the command
 * settled cleanly (exit 0, no signal) and needs no pill — the same
 * distinction the bash tool's own exit-status markers draw.
 * @param exitCode - settled exit code, when known.
 * @param signal - settled terminating signal name, when known.
 * @param labels - display copy for the pill text.
 * @returns the pill text, or undefined for a clean exit.
 */
function statusText(
  exitCode: number | undefined,
  signal: string | undefined,
  labels: TerminalBlockLabels,
): string | undefined {
  if (signal !== undefined) return labels.signal(signal)
  if (exitCode !== undefined && exitCode !== 0) return labels.exitCode(exitCode)
  return undefined
}

/**
 * Run-state indicator for the command, shown at the head of the prompt line so
 * the card states whether the command is still running without the reader
 * having to infer it from the presence of output. Three of {@link StateDotState}'s
 * five states are reachable: the running chase (the same
 * indicator a running tool row's leading icon uses, so the row and its card
 * never disagree), green for a clean settle, red for a signal or a non-zero
 * exit — the same status distinction {@link statusText} draws for the pill. A
 * settled command whose exit status never reached the view counts as a clean
 * settle: the view says it finished and says nothing went wrong.
 * @param running - the command has not settled.
 * @param exitCode - settled exit code, when known.
 * @param signal - settled terminating signal name, when known.
 * @param labels - display copy for the text label.
 * @returns the dot's state and its text label, since the dot is aria-hidden.
 */
function runState(
  running: boolean,
  exitCode: number | undefined,
  signal: string | undefined,
  labels: TerminalBlockLabels,
): { state: StateDotState; label: string } {
  if (running) return { state: 'ongoing', label: labels.running }
  if (statusText(exitCode, signal, labels) !== undefined) return { state: 'error', label: labels.failed }
  return { state: 'done', label: labels.done }
}

/**
 * Render one parsed output line. Runs without SGR state render as bare text,
 * so uncolored output carries no span wrappers.
 * @param line - the line's styled runs.
 * @returns the line's children.
 */
function renderLine(line: AnsiLine) {
  return line.map((span, index) => span.style === undefined
    ? span.text
    : <span key={index} style={span.style}>{span.text}</span>)
}

/**
 * Render a shell command as a terminal surface.
 * @param props - see {@link TerminalBlockProps}.
 * @returns the terminal block element.
 */
export function TerminalBlock({
  command,
  cwd,
  home,
  output,
  exitCode,
  signal,
  running = false,
  maxLines = DEFAULT_TERMINAL_MAX_LINES,
  className,
  labels,
}: TerminalBlockProps) {
  const copy = labels
  const text = output ?? ''
  // A command's output ends with a newline; that terminator is not an extra
  // blank line to draw or to count against the height cap. The check runs on the
  // PARSED lines rather than on the raw text, because a reset after the final
  // newline (`line\n\x1b[0m`) leaves the string not ending in one while still
  // producing a last line with nothing visible in it. A genuinely blank final
  // line — the double newline — survives, since it has a real empty line before
  // the terminator. The copy control still copies `text` untouched.
  const lines = useMemo(() => {
    const parsed = parseAnsiLines(text)
    const last = parsed[parsed.length - 1]
    const terminated = parsed.length > 1 && last !== undefined
      && last.every(span => span.text === '')
    return terminated ? parsed.slice(0, -1) : parsed
  }, [text])
  const [expanded, setExpanded] = useState(false)
  // The raw output, never the rendered tree: the prompt line and the status pill
  // are chrome the user did not run.
  const { copied, onCopy } = useCopyFeedback(text)

  const onToggle = useCallback(() => { setExpanded(value => !value) }, [])

  const status = statusText(exitCode, signal, copy)
  const state = runState(running, exitCode, signal, copy)
  // A multi-line command gets one prompt row per line, so a two-command shell
  // snippet reads as the two commands it is instead of collapsing into one
  // ellipsized row. A trailing newline is a terminator, not an empty command.
  const commandLines = useMemo(() => {
    const body = command.endsWith('\n') ? command.slice(0, -1) : command
    return body.split('\n')
  }, [command])
  // Read from the parsed lines the card actually renders, not from the raw text:
  // output that is only escapes or control bytes (a lone reset, an OSC title, an
  // erase) survives `text.trim()` yet parses to nothing visible. Judging it on
  // the raw text would draw an output box of blank rows plus a copy control
  // for invisible bytes, and hide the placeholder that belongs there.
  const empty = lines.every(line => line.every(span => span.text.trim() === ''))
  const { hidden, capped, headLines, tailLines } = headTailCap(lines.length, maxLines, expanded)

  return (
    <div className={clsx(css.block, className)} data-terminal="" data-running={running ? '' : undefined}>
      <div className={css.header}>
        <div className={css.prompt}>
          <span className={css.runStateLabel}>{state.label}</span>
          {commandLines.map((line, index) => (
            <div key={index} className={css.promptLine}>
              {/* One dot for the card, on the first row: the exit status the
                  view carries is the whole call's, and bash reports no
                  per-command status, so a dot per row would assert a
                  per-line outcome nothing here knows. */}
              {index === 0 && <StateDot state={state.state} className={css.runState} />}
              {/* The cwd labels the CALL, so only its first row carries it. The
                  view knows one working directory — where the call started —
                  and a later line may well run somewhere else (a `cd` in the
                  command is enough), so repeating the label down the rows would
                  assert a directory per line that nothing here knows. Later
                  rows keep a bare `$` to stay aligned as prompts. */}
              <span className={css.cwd}>
                {index > 0 || cwd === undefined ? '$' : promptLabel(cwd, home)}
              </span>
              <span className={css.command}>{line}</span>
            </div>
          ))}
        </div>
        {status !== undefined && <Pill className={css.status}>{status}</Pill>}
        {!running && !empty && (
          <button type="button" className={css.copyButton} onClick={onCopy}>
            {copied ? copy.copied : copy.copy}
          </button>
        )}
      </div>
      {!running && (empty
        ? <div className={css.empty}>{copy.noOutput}</div>
        : (
          <div className={css.output}>
            {(capped ? lines.slice(0, headLines) : lines).map((line, index) => (
              <div key={index} className={css.line}>{renderLine(line)}</div>
            ))}
            {hidden > 0 && (
              <button
                type="button"
                className={css.expand}
                aria-expanded={expanded}
                aria-label={expanded ? copy.collapseAria : copy.expandAria(hidden)}
                onClick={onToggle}
              >
                {expanded ? copy.collapse : copy.expand(hidden)}
              </button>
            )}
            {capped && lines.slice(lines.length - tailLines).map((line, index) => (
              <div key={index} className={css.line}>{renderLine(line)}</div>
            ))}
          </div>
        ))}
    </div>
  )
}
