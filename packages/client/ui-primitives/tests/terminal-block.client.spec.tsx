// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { DEFAULT_TERMINAL_MAX_LINES, TerminalBlock as LocalizedTerminalBlock } from '../src/index.ts'
import { writeClipboard } from '../src/clipboard.ts'
import { terminalBlockLabels } from './labels.client.ts'

function TerminalBlock(props: Omit<ComponentProps<typeof LocalizedTerminalBlock>, 'labels'>) {
  return <LocalizedTerminalBlock {...props} labels={terminalBlockLabels} />
}

const ESC = '\u001b'

afterEach(cleanup)

beforeEach(() => {
  vi.useRealTimers()
})

function outputLines(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[class^="_line_"]')].map(row => row.textContent ?? '')
}

function runStateOf(container: HTMLElement): { state: string | null; label: string | undefined } {
  const dot = container.querySelector('[class*="_runState_"][data-state]')
  return {
    state: dot?.getAttribute('data-state') ?? null,
    label: container.querySelector('[class^="_runStateLabel_"]')?.textContent ?? undefined,
  }
}

function promptRows(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[class^="_promptLine_"]')].map(row => (row.textContent ?? '').trim())
}

function body(count: number): string {
  return Array.from({ length: count }, (_value, index) => `line ${index + 1}`).join('\n')
}

describe('TerminalBlock prompt label', () => {
  it('collapses the home directory itself to ~', () => {
    render(<TerminalBlock command="ls" cwd="/Users/me" home="/Users/me" />)
    expect(screen.getByText('~')).toBeTruthy()
  })

  it('shows only the last segment below home', () => {
    render(<TerminalBlock command="ls" cwd="/Users/me/Documents" home="/Users/me" />)
    expect(screen.getByText('Documents')).toBeTruthy()
  })

  it('ignores trailing separators on both the cwd and home', () => {
    const view = render(<TerminalBlock command="ls" cwd="/Users/me/" home="/Users/me" />)
    expect(view.getByText('~')).toBeTruthy()
    view.rerender(<TerminalBlock command="ls" cwd="/Users/me" home="/Users/me/" />)
    expect(view.getByText('~')).toBeTruthy()
  })

  it('drops trailing separators before taking the last segment', () => {
    render(<TerminalBlock command="ls" cwd="/Users/me/Documents///" home="/Users/me" />)
    expect(screen.getByText('Documents')).toBeTruthy()
  })

  it('takes the last segment when no home is known', () => {
    render(<TerminalBlock command="ls" cwd="C:\\Users\\me\\Projects" />)
    expect(screen.getByText('Projects')).toBeTruthy()
  })

  it('collapses a backslash home path to ~', () => {
    render(<TerminalBlock command="ls" cwd="C:\\Users\\me" home="C:\\Users\\me" />)
    expect(screen.getByText('~')).toBeTruthy()
  })

  it('falls back to the raw path when it has no segment', () => {
    render(<TerminalBlock command="ls" cwd="/" home="/Users/me" />)
    expect(screen.getByText('/')).toBeTruthy()
  })

  it('renders a plain $ with no cwd', () => {
    render(<TerminalBlock command="ls" />)
    expect(screen.getByText('$')).toBeTruthy()
  })

  it('renders the command verbatim after the label', () => {
    render(<TerminalBlock command="git log --oneline | head -3" cwd="/Users/me/app" />)
    expect(screen.getByText('git log --oneline | head -3')).toBeTruthy()
  })
})

describe('TerminalBlock states', () => {
  it('running with no output shows the command line only: no output box, no placeholder, no copy', () => {
    const view = render(<TerminalBlock command="sleep 5" running />)
    expect(view.getByText('sleep 5')).toBeTruthy()
    expect(outputLines(view.container)).toEqual([])
    expect(view.queryByText('无输出')).toBeNull()
    expect(view.queryByRole('button')).toBeNull()
    expect(view.container.firstElementChild?.getAttribute('data-running')).toBe('')
    // Banner-only: no body, so no banner divider either.
    expect(view.container.firstElementChild?.getAttribute('data-body')).toBeNull()
  })

  it('copyText overrides the copy payload and keeps the control before any output', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const view = render(<TerminalBlock command="npm run build --verbose" running copyText="npm run build --verbose" />)
    // No output yet, but the command is already copyable.
    const button = view.getByRole('button', { name: '复制' })
    await act(async () => { fireEvent.click(button) })
    expect(writeText).toHaveBeenCalledWith('npm run build --verbose')
  })

  it('omits the run-state dot and its assistive label when the host carries the state', () => {
    const view = render(<TerminalBlock command="sleep 5" running output="partial" runStateDot={false} />)
    expect(view.container.querySelector('[class*="runState"]')).toBeNull()
    expect(view.queryByText('运行中')).toBeNull()
  })

  it('running with supplied output streams the live text without a default copy control', () => {
    const view = render(<TerminalBlock command="sleep 5" running output="partial" />)
    expect(view.getByText('partial')).toBeTruthy()
    expect(view.queryByText('无输出')).toBeNull()
    expect(view.queryByRole('button', { name: '复制' })).toBeNull()
    expect(view.container.firstElementChild?.getAttribute('data-running')).toBe('')
    // Live output renders a body, so the banner divider returns.
    expect(view.container.firstElementChild?.getAttribute('data-body')).toBe('')
  })

  it('running with an empty live stream draws neither output nor placeholder', () => {
    const view = render(<TerminalBlock command="tail -f log" running output="" />)
    expect(outputLines(view.container)).toEqual([])
    expect(view.queryByText('无输出')).toBeNull()
    expect(view.queryByRole('button')).toBeNull()
  })

  it('running still shows a settled-looking status pill when one is supplied', () => {
    render(<TerminalBlock command="sleep 5" running signal="SIGINT" />)
    expect(screen.getByText('信号 SIGINT')).toBeTruthy()
  })

  it('settled with whitespace-only output shows the dimmed placeholder', () => {
    const view = render(<TerminalBlock command="true" output={'  \n '} exitCode={0} />)
    expect(view.getByText('无输出')).toBeTruthy()
    expect(view.queryByRole('button', { name: '复制' })).toBeNull()
  })

  it('settled with absent output shows the placeholder', () => {
    render(<TerminalBlock command="true" exitCode={0} />)
    expect(screen.getByText('无输出')).toBeTruthy()
  })

  it('settled with an empty string shows the placeholder', () => {
    render(<TerminalBlock command="true" output="" exitCode={0} />)
    expect(screen.getByText('无输出')).toBeTruthy()
  })

  it('treats output that renders nothing visible as empty', () => {
    // A lone reset, an OSC title, an erase: all survive `text.trim()` yet parse
    // to nothing. Judging emptiness on the raw text drew a box of blank rows
    // plus a copy control for invisible bytes, and hid the placeholder.
    const view = render(<TerminalBlock command="true" output={`${ESC}[0m`} exitCode={0} />)
    expect(view.getByText('无输出')).toBeTruthy()
    expect(view.queryByText('复制')).toBeNull()
    view.rerender(<TerminalBlock command="true" output={`${ESC}]0;title${ESC}\\`} exitCode={0} />)
    expect(view.getByText('无输出')).toBeTruthy()
  })

  it('merges className onto the wrapper', () => {
    const view = render(<TerminalBlock command="ls" className="x" output="a" />)
    expect(view.container.firstElementChild?.classList.contains('x')).toBe(true)
    expect(view.container.firstElementChild?.hasAttribute('data-running')).toBe(false)
  })

  it('drops the output text terminator instead of drawing a blank line', () => {
    const view = render(<TerminalBlock command="ls" output={'a\nb\n'} />)
    expect(outputLines(view.container)).toEqual(['a', 'b'])
  })

  it('drops the output terminator even when a reset follows the final newline', () => {
    // `line\n\x1b[0m` does not end in a newline as a string, yet its last parsed
    // line holds nothing visible — a common shape, since tools close their color
    // after the last line. Judging the terminator on the raw text added a blank
    // row and inflated both the card height and the collapse count.
    const view = render(<TerminalBlock command="ls" output={`a\nb\n${ESC}[0m`} />)
    expect(outputLines(view.container)).toEqual(['a', 'b'])
  })

  it('keeps a genuinely blank final line when the output ends with two newlines', () => {
    const view = render(<TerminalBlock command="ls" output={'a\nb\n\n'} />)
    expect(outputLines(view.container)).toEqual(['a', 'b', ''])
  })

  it('renders ANSI runs as styled spans and plain text bare', () => {
    const view = render(<TerminalBlock command="ls" output={`${ESC}[31mbad${ESC}[39m ok`} />)
    // Scoped to a line: the prompt line's run-state dot is a styled span too.
    const span = view.container.querySelector('[class^="_line_"] span[style]')
    expect(span?.textContent).toBe('bad')
    expect(span?.getAttribute('style')).toContain('--dsw-alias-state-error-primary')
    expect(outputLines(view.container)).toEqual(['bad ok'])
  })

  it('renders uncolored output with no span wrappers at all', () => {
    const view = render(<TerminalBlock command="ls" output={'plain one\nplain two\n'} />)
    expect(view.container.querySelectorAll('[class^="_line_"] span')).toHaveLength(0)
  })
})

describe('TerminalBlock status pill', () => {
  it('renders no pill for a clean exit', () => {
    const view = render(<TerminalBlock command="true" output="a" exitCode={0} />)
    expect(view.queryByText(/退出码|信号/u)).toBeNull()
  })

  it('renders no pill while the exit status is unknown', () => {
    const view = render(<TerminalBlock command="ls" output="a" />)
    expect(view.queryByText(/退出码|信号/u)).toBeNull()
  })

  it('renders the exit-code pill for a non-zero exit', () => {
    render(<TerminalBlock command="false" output="a" exitCode={1} />)
    expect(screen.getByText('退出码 1')).toBeTruthy()
  })

  it('renders the no-exit-code pill and the error dot for a command that settled without one', () => {
    const view = render(<TerminalBlock command="pnpm add x" output="spawn pnpm ENOENT" exitCode={null} />)
    expect(view.getByText('未正常退出')).toBeTruthy()
    expect(runStateOf(view.container)).toEqual({ state: 'error', label: '失败' })
  })

  it('renders the signal pill, which outranks the exit code', () => {
    render(<TerminalBlock command="sleep 9" output="a" exitCode={0} signal="SIGKILL" />)
    expect(screen.getByText('信号 SIGKILL')).toBeTruthy()
    expect(screen.queryByText(/退出码/u)).toBeNull()
  })
})

describe('TerminalBlock run-state dot', () => {
  it('shows the running chase and its running label while the command runs', () => {
    const view = render(<TerminalBlock command="sleep 5" running />)
    expect(runStateOf(view.container)).toEqual({ state: 'ongoing', label: '运行中' })
  })

  it('shows the done dot for a clean settled exit', () => {
    const view = render(<TerminalBlock command="true" output="a" exitCode={0} />)
    expect(runStateOf(view.container)).toEqual({ state: 'done', label: '已完成' })
  })

  it('counts a settled command with no exit status as a clean settle', () => {
    const view = render(<TerminalBlock command="ls" output="a" />)
    expect(runStateOf(view.container)).toEqual({ state: 'done', label: '已完成' })
  })

  it('shows the error dot for a non-zero exit', () => {
    const view = render(<TerminalBlock command="false" output="a" exitCode={1} />)
    expect(runStateOf(view.container)).toEqual({ state: 'error', label: '失败' })
  })

  it('shows the error dot for a signal, whatever the exit code says', () => {
    const view = render(<TerminalBlock command="sleep 9" output="a" exitCode={0} signal="SIGKILL" />)
    expect(runStateOf(view.container)).toEqual({ state: 'error', label: '失败' })
  })

  // The dot precedes the prompt label, which is what makes it read as the
  // state OF this command rather than of the card's chrome.
  it('places the dot ahead of the prompt label and the command', () => {
    const view = render(<TerminalBlock command="ls" cwd="/srv/app" output="a" />)
    const row = view.container.querySelector('[class^="_promptLine_"]')
    expect([...row!.children].map(node => node.textContent)).toEqual(['', 'app', 'ls'])
  })

  // The cwd labels the call, not each line: a `cd` in the command moves later
  // lines elsewhere, so repeating the label would state a directory per line
  // that the view does not know.
  it('labels only the first row with the cwd, leaving later rows a bare $', () => {
    const view = render(<TerminalBlock command={'cd ~\nls'} cwd="/srv/app" output="a" exitCode={0} />)
    expect(promptRows(view.container)).toEqual(['appcd ~', '$ls'])
  })

  it('gives a multi-line command one row per line', () => {
    const view = render(<TerminalBlock command={'echo one\necho two'} output="a" exitCode={0} />)
    expect(promptRows(view.container)).toEqual(['$echo one', '$echo two'])
  })

  // A heredoc or an editor-authored command commonly ends in a newline; that
  // terminator is not a further, empty command to draw a row for.
  it('drops a trailing newline instead of drawing an empty final row', () => {
    const view = render(<TerminalBlock command={'echo one\necho two\n'} output="a" exitCode={0} />)
    expect(promptRows(view.container)).toEqual(['$echo one', '$echo two'])
  })

  it('keeps a genuinely blank command line when the command ends with two newlines', () => {
    const view = render(<TerminalBlock command={'echo one\n\n'} output="a" exitCode={0} />)
    expect(promptRows(view.container)).toEqual(['$echo one', '$'])
  })

  // The exit status the view carries is the whole call's — bash reports no
  // per-command status — so exactly one dot and one label are correct however
  // many lines the command spans. A dot per row would assert, of a line that
  // succeeded inside a failing call, that the line itself failed.
  it('marks the call once, on the first row, never per line', () => {
    const view = render(<TerminalBlock command={'true\nfalse\ntrue'} output="x" exitCode={1} />)
    expect(view.container.querySelectorAll('[class*="_runState_"][data-state]')).toHaveLength(1)
    expect(view.container.querySelectorAll('[class^="_runStateLabel_"]')).toHaveLength(1)
    expect(runStateOf(view.container)).toEqual({ state: 'error', label: '失败' })
    const rows = view.container.querySelectorAll('[class^="_promptLine_"]')
    expect(rows[0]!.querySelector('[data-state]')).not.toBeNull()
    expect(rows[1]!.querySelector('[data-state]')).toBeNull()
    expect(rows[2]!.querySelector('[data-state]')).toBeNull()
  })

  it('keeps the running dot even while a settled-looking status pill is supplied', () => {
    const view = render(<TerminalBlock command="sleep 5" running signal="SIGINT" />)
    expect(runStateOf(view.container)).toEqual({ state: 'ongoing', label: '运行中' })
  })
})

describe('TerminalBlock height cap', () => {
  it('renders every line and no expand control under the cap', () => {
    const view = render(<TerminalBlock command="ls" output={body(4)} maxLines={4} />)
    expect(outputLines(view.container)).toHaveLength(4)
    expect(view.container.querySelector('[aria-expanded]')).toBeNull()
  })

  it('does not count the output terminator against the cap', () => {
    const view = render(<TerminalBlock command="ls" output={`${body(4)}\n`} maxLines={4} />)
    expect(outputLines(view.container)).toHaveLength(4)
    expect(view.container.querySelector('[aria-expanded]')).toBeNull()
  })

  it('slices head and tail over the cap and expands on click', () => {
    const view = render(<TerminalBlock command="ls" output={body(10)} maxLines={4} />)
    // maxLines 4: head = ceil(4/2) = 2, tail = 4 - 2 = 2, 6 hidden.
    expect(outputLines(view.container)).toEqual(['line 1', 'line 2', 'line 9', 'line 10'])
    const toggle = view.getByRole('button', { name: '展开其余 6 行输出' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toBe('… 其余 6 行')

    fireEvent.click(toggle)
    expect(outputLines(view.container)).toHaveLength(10)
    const collapse = view.getByRole('button', { name: '收起输出' })
    expect(collapse.getAttribute('aria-expanded')).toBe('true')
    expect(collapse.textContent).toBe('收起')

    fireEvent.click(collapse)
    expect(outputLines(view.container)).toEqual(['line 1', 'line 2', 'line 9', 'line 10'])
  })

  it('renders the head slice alone when the cap leaves no tail', () => {
    const view = render(<TerminalBlock command="ls" output={body(5)} maxLines={1} />)
    expect(outputLines(view.container)).toEqual(['line 1'])
    expect(view.getByRole('button', { name: '展开其余 4 行输出' })).toBeTruthy()
  })

  it('caps at the documented default when maxLines is absent', () => {
    const view = render(<TerminalBlock command="ls" output={body(DEFAULT_TERMINAL_MAX_LINES + 1)} />)
    expect(outputLines(view.container)).toHaveLength(DEFAULT_TERMINAL_MAX_LINES)
    expect(view.getByRole('button', { name: '展开其余 1 行输出' })).toBeTruthy()
  })
})

describe('TerminalBlock copy', () => {
  it('copies the raw output, never the prompt line or the pill', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const output = `${ESC}[31mbad${ESC}[39m\n`
    render(<TerminalBlock command="make" cwd="/Users/me/app" output={output} exitCode={2} />)
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    // Escape codes, the newline terminator, and nothing of the chrome around them.
    expect(writeText).toHaveBeenCalledWith(output)
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: '复制成功' })).toBeTruthy()
    // While the ok label is showing, further clicks are no-ops.
    fireEvent.click(screen.getByRole('button', { name: '复制成功' }))
    expect(writeText).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
  })

  it('copies the whole output while the height cap hides its middle', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const output = `${body(10)}\n`
    render(<TerminalBlock command="ls" output={output} maxLines={4} exitCode={0} />)
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(writeText).toHaveBeenCalledWith(output)
    expect(await screen.findByRole('button', { name: '复制成功' })).toBeTruthy()
  })

  it('does not claim success when the host refuses the write', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    render(<TerminalBlock command="ls" output="a" />)
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '复制成功' })).toBeNull()
  })
})

describe('writeClipboard', () => {
  it('reports true after the async Clipboard API accepts the exact text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await expect(writeClipboard('payload')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('payload')
  })

  it('reports false when the Clipboard API rejects', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    await expect(writeClipboard('payload')).resolves.toBe(false)
  })

  it('selects a detached textarea for the execCommand fallback and removes it after', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    let selected: string | undefined
    const exec = vi.fn(() => {
      selected = document.querySelector<HTMLTextAreaElement>('textarea[readonly]')?.value
      return true
    })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec })
    await expect(writeClipboard('payload')).resolves.toBe(true)
    expect(exec).toHaveBeenCalledWith('copy')
    expect(selected).toBe('payload')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('reports execCommand\'s own refusal verbatim', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) })
    await expect(writeClipboard('payload')).resolves.toBe(false)
  })

  it('reports false and still removes the textarea when execCommand throws', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: () => {
        throw new Error('denied')
      },
    })
    await expect(writeClipboard('payload')).resolves.toBe(false)
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('reports false on a host with neither clipboard path', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: undefined })
    await expect(writeClipboard('payload')).resolves.toBe(false)
  })

  it('reports false when navigator.clipboard exists without writeText', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {} })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: undefined })
    await expect(writeClipboard('payload')).resolves.toBe(false)
  })
})
