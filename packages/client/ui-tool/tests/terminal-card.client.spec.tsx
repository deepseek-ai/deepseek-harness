// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDisclosure } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/use-disclosure.ts'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { StartedToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import {
  localizeTerminalCardModel, terminalCardModel, terminalFailed,
} from '../src/client/tool/models/terminal-card-model.ts'
import { GenericToolCard, type GenericToolCardProps } from '../src/client/tool/toolviews/GenericToolCard.tsx'
import { BashRow } from '../src/client/tool/toolviews/bash-sample.tsx'
import { en, zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'

type BashRowProps = Parameters<typeof BashRow>[0]

const t: GenericToolCardProps['t'] = makeTranslate(zh, commonZh)
const enT: GenericToolCardProps['t'] = makeTranslate(en, commonEn)

afterEach(cleanup)

/**
 * Match an output line with its interior whitespace intact: the column
 * alignment this card exists to preserve is exactly what the default
 * whitespace-collapsing matcher would hide.
 */
const RAW = { normalizer: (text: string) => text }

/** The rendered card's run-state dot state, so a render site cannot silently drop it. */
function runStateOf(container: HTMLElement): string | null {
  return container.querySelector('[data-terminal] [data-state]')?.getAttribute('data-state') ?? null
}

const SID = 's1' as SessionId

const ARGS = '{"command":"ls -la","description":"List files"}'

const shellArgs = (over: Record<string, unknown> = {}): string => JSON.stringify({
  command: 'ls -la', description: 'List files', ...over,
})

const running = (over?: Partial<StartedToolCall>): StartedToolCall => ({
  phase: 'start' as const, callId: 'c1', name: 'bash', argsRaw: ARGS,
  turn: 1, step: 1, time: 1_000, subCalls: [], ...over,
})

const settled = (over?: Partial<ToolResultNode>): ToolResultNode => ({
  kind: 'tool-result', seq: 10, time: 2_000, callId: 'c1',
  call: { name: 'bash', argsRaw: ARGS },
  callTime: 1_000,
  content: [{ type: 'text', text: 'a.ts  b.ts\nc.ts  d.ts\n' }], isError: false,
  subCalls: [], ...over,
})

describe('terminalCardModel', () => {
  it('derives a running standard-shell card from raw arguments', () => {
    expect(terminalCardModel(running({ argsRaw: shellArgs({ workdir: '/projects/app' }) }))).toEqual({
      copy: { kind: 'shell', command: 'ls -la', description: 'List files' },
      card: {
        cwd: '/projects/app', output: undefined,
        exitCode: undefined, signal: undefined, running: true,
      },
    })
  })

  it('derives a settled standard-shell card and removes its final exit marker', () => {
    expect(terminalCardModel(settled({
      call: { name: 'bash', argsRaw: shellArgs({ workdir: '/projects/app' }) },
      content: [{ type: 'text', text: 'boom\n[exit code: 2]' }],
    }))).toEqual({
      copy: { kind: 'shell', command: 'ls -la', description: 'List files' },
      card: {
        cwd: '/projects/app', output: 'boom',
        exitCode: 2, signal: undefined, running: false,
      },
    })
    expect(terminalCardModel(settled({
      content: [{ type: 'text', text: 'gone\n[killed by signal: SIGTERM]' }],
    }))?.card).toMatchObject({ output: 'gone', signal: 'SIGTERM' })
  })

  it('flags a failing exit as terminalFailed; clean exits and running cards are not', () => {
    // isError stays false on a failing command (the exit status is result
    // data), so this predicate is the row's only failure signal.
    expect(terminalFailed(terminalCardModel(settled({
      content: [{ type: 'text', text: 'boom\n[exit code: 2]' }],
    }))!)).toBe(true)
    expect(terminalFailed(terminalCardModel(settled({
      content: [{ type: 'text', text: 'gone\n[killed by signal: SIGTERM]' }],
    }))!)).toBe(true)
    expect(terminalFailed(terminalCardModel(settled())!)).toBe(false)
    expect(terminalFailed(terminalCardModel(running())!)).toBe(false)
  })

  it('keeps status text that has no terminal pill and requires a leading newline', () => {
    expect(terminalCardModel(settled({
      content: [{ type: 'text', text: 'timed out\n[timed out after 1000ms]\n[exit code: 2]' }],
    }))?.card).toMatchObject({ output: 'timed out\n[timed out after 1000ms]', exitCode: 2 })
    expect(terminalCardModel(settled({
      content: [{ type: 'text', text: '[exit code: 5]' }],
    }))?.card).toMatchObject({ output: '[exit code: 5]', exitCode: 0 })
  })

  it('resolves the raw workdir against the session workspace', () => {
    // Omitted workdir — the common bash call — IS the session workspace.
    expect(terminalCardModel(settled(), '/w/app')?.card.cwd).toBe('/w/app')
    // A relative workdir joins under it.
    expect(terminalCardModel(settled({
      call: { name: 'bash', argsRaw: shellArgs({ workdir: 'packages/ui' }) },
    }), '/w/app')?.card.cwd).toBe('/w/app/packages/ui')
    // An absolute one is used as-is.
    expect(terminalCardModel(settled({
      call: { name: 'bash', argsRaw: shellArgs({ workdir: '/srv/other' }) },
    }), '/w/app')?.card.cwd).toBe('/srv/other')
    // With no session cwd there is nothing to resolve against: a relative path
    // stays as authored and an omitted one stays absent (a bare `$` prompt).
    expect(terminalCardModel(settled({
      call: { name: 'bash', argsRaw: shellArgs({ workdir: 'packages/ui' }) },
    }))?.card.cwd).toBe('packages/ui')
    expect(terminalCardModel(settled())?.card.cwd).toBeUndefined()
    // The running arm resolves identically.
    expect(terminalCardModel(running(), '/w/app')?.card.cwd).toBe('/w/app')
  })

  it('normalizes a relative workdir so the label names the directory actually used', () => {
    // The bash executor resolves the workdir before running, so `..` against
    // /w/app runs in /w — the card must say `w`, not `..`.
    expect(terminalCardModel(settled({ call: { name: 'bash', argsRaw: shellArgs({ workdir: '..' }) } }), '/w/app')?.card.cwd).toBe('/w')
    expect(terminalCardModel(settled({ call: { name: 'bash', argsRaw: shellArgs({ workdir: '.' }) } }), '/w/app')?.card.cwd).toBe('/w/app')
    expect(terminalCardModel(settled({ call: { name: 'bash', argsRaw: shellArgs({ workdir: '../sibling' }) } }), '/w/app')?.card.cwd).toBe('/w/sibling')
    expect(terminalCardModel(settled({ call: { name: 'bash', argsRaw: shellArgs({ workdir: './nested/../other' }) } }), '/w/app')?.card.cwd).toBe('/w/app/other')
    // A `..` that would climb past the root is dropped, as a filesystem does.
    expect(terminalCardModel(settled({ call: { name: 'bash', argsRaw: shellArgs({ workdir: '../../..' }) } }), '/w')?.card.cwd).toBe('/')
    // An absolute path carrying segments normalizes too.
    expect(terminalCardModel(settled({ call: { name: 'bash', argsRaw: shellArgs({ workdir: '/srv/./app/../other' }) } }), '/w/app')?.card.cwd).toBe('/srv/other')
    // A Windows path keeps its separators.
    expect(terminalCardModel(settled({ call: { name: 'bash', argsRaw: shellArgs({ workdir: 'C:\\ws\\app\\..' }) } }), '/w')?.card.cwd).toBe('C:\\ws')
    // Without a session cwd a relative `..` has nothing to resolve against, so
    // it survives as authored rather than being silently dropped.
    expect(terminalCardModel(settled({ call: { name: 'bash', argsRaw: shellArgs({ workdir: '../elsewhere' }) } }))?.card.cwd).toBe('../elsewhere')
  })

  it('keeps a UNC server and share as an unpoppable root', () => {
    // Windows cannot climb above a share, so `..` from the share root stays put.
    expect(terminalCardModel(settled({ call: { name: 'bash', argsRaw: shellArgs({ workdir: '..' }) } }), '\\\\server\\share')?.card.cwd).toBe('\\\\server\\share')
    // Below the share it pops normally, keeping the UNC separators.
    expect(terminalCardModel(settled({ call: { name: 'bash', argsRaw: shellArgs({ workdir: '..' }) } }), '\\\\server\\share\\app')?.card.cwd).toBe('\\\\server\\share')
    // Several `..` cannot escape the root either.
    expect(terminalCardModel(settled({ call: { name: 'bash', argsRaw: shellArgs({ workdir: '../../..' }) } }), '\\\\server\\share\\app')?.card.cwd).toBe('\\\\server\\share')
  })

  it('supports terminal_send without giving background or failed sends a terminal card', () => {
    const argsRaw = JSON.stringify({ sessionId: 'pty-3', text: 'make' })
    const run = running({ name: 'terminal_send', argsRaw })
    expect(terminalCardModel(run, '/w/app')).toMatchObject({
      copy: { kind: 'terminal-send', text: 'make', sessionId: 'pty-3' },
      card: { cwd: '/w/app', running: true },
    })
    const done = settled({ call: { name: 'terminal_send', argsRaw }, content: [{ type: 'text', text: 'ok' }] })
    expect(localizeTerminalCardModel(terminalCardModel(done)!, enT)).toMatchObject({
      description: 'Terminal pty-3', card: { command: 'make', output: 'ok', running: false },
    })
    expect(terminalCardModel(settled({
      call: { name: 'terminal_send', argsRaw: JSON.stringify({ sessionId: 'pty-3', text: 'make', run_in_background: true }) },
    }))).toBeNull()
    expect(terminalCardModel(settled({ ...done, isError: true }))).toBeNull()
  })

  it('preserves persistent-shell running cards and settled generic output', () => {
    const persistent = JSON.stringify({ command: 'pwd' })
    expect(terminalCardModel(running({ argsRaw: persistent }))).toMatchObject({
      copy: { kind: 'shell', command: 'pwd', description: undefined }, card: { running: true },
    })
    expect(terminalCardModel(running({ name: 'pwsh', argsRaw: persistent }))).toMatchObject({
      copy: { kind: 'shell', command: 'pwd', description: undefined }, card: { running: true },
    })
    expect(terminalCardModel(settled({ call: { name: 'bash', argsRaw: persistent } }))).toBeNull()
    expect(terminalCardModel(settled({ call: { name: 'pwsh', argsRaw: persistent } }))).toBeNull()
  })

  it('derives the standard pwsh card from the same raw status markers', () => {
    expect(terminalCardModel(settled({
      call: { name: 'pwsh', argsRaw: ARGS },
      content: [{ type: 'text', text: 'failed\n[exit code: 3]' }],
    }))).toMatchObject({
      copy: { kind: 'shell', command: 'ls -la', description: 'List files' },
      card: { output: 'failed', exitCode: 3, running: false },
    })
  })

  it('keeps terminal_send copy semantic until the render locale is known', () => {
    const model = terminalCardModel(running({
      name: 'terminal_send',
      argsRaw: JSON.stringify({ sessionId: 'pty-3', text: '' }),
    }))!
    expect(model.copy).toEqual({ kind: 'terminal-send', text: '', sessionId: 'pty-3' })
    expect(localizeTerminalCardModel(model, t)).toMatchObject({
      description: '终端 pty-3', card: { command: '（发送输入）' },
    })
    expect(localizeTerminalCardModel(model, enT)).toMatchObject({
      description: 'Terminal pty-3', card: { command: '(send input)' },
    })
  })

  it('returns null without a paired call', () => {
    expect(terminalCardModel(settled({ call: null }))).toBeNull()
  })

  it('derives the same terminal card for root calls and PTC dispatch children', () => {
    expect(terminalCardModel(settled({ parentCallId: 'parent' }))).toEqual(terminalCardModel(settled()))
    expect(terminalCardModel(running({ parentCallId: 'parent' }))).toEqual(terminalCardModel(running()))
  })

  it.each(['bash', 'pwsh'])('keeps nested persistent %s running cards and settled generic results', (name) => {
    const argsRaw = JSON.stringify({ command: 'pwd' })
    expect(terminalCardModel(running({ name, argsRaw, parentCallId: 'parent' })))
      .toEqual(terminalCardModel(running({ name, argsRaw })))
    expect(terminalCardModel(settled({ call: { name, argsRaw }, parentCallId: 'parent' }))).toBeNull()
  })

  it.each(['bash', 'pwsh'])('does not infer %s exit status from a spilled preview', (name) => {
    const notice = '(Omitted 50000 bytes. Full formatted result stored at: /spill/output.txt. Read the file.)'
    for (const parentCallId of [undefined, 'parent']) {
      for (const preview of ['failed\n[exit code: 7]', 'killed\n[killed by signal: SIGTERM]', 'partial', '']) {
        expect(terminalCardModel(settled({
          ...parentCallId === undefined ? {} : { parentCallId },
          call: { name, argsRaw: ARGS },
          content: [{ type: 'text', text: preview === '' ? notice : `${preview}\n\n${notice}` }],
        }))).toBeNull()
      }
    }
    expect(terminalCardModel(settled({
      call: { name, argsRaw: ARGS },
      content: [{ type: 'text', text: `${notice}\nordinary output` }],
    }))).not.toBeNull()
  })

  it('returns null for background, errors, malformed args, unsupported tools, and non-text results', () => {
    expect(terminalCardModel(running({ argsRaw: shellArgs({ run_in_background: true }) }))).toBeNull()
    expect(terminalCardModel(settled({ isError: true }))).toBeNull()
    expect(terminalCardModel(running({ argsRaw: '{' }))).toBeNull()
    expect(terminalCardModel(running({ name: 'read' }))).toBeNull()
    expect(terminalCardModel(settled({ content: [] }))).toBeNull()
    expect(terminalCardModel(settled({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }))).toBeNull()
  })

  it.each([
    ['timeout type', { timeoutMs: '1000' }],
    ['timeout value', { timeoutMs: 0 }],
    ['workdir type', { workdir: 7 }],
    ['background type', { run_in_background: 'yes' }],
    ['permission type', { sandbox_permissions: 7, justification: 'Need access' }],
    ['permission value', { sandbox_permissions: 'read-only', justification: 'Need access' }],
    ['missing justification', { sandbox_permissions: 'workspace-write' }],
    ['orphan justification', { justification: 'Need access' }],
    ['blank justification', { sandbox_permissions: 'workspace-write', justification: ' ' }],
  ])('keeps malformed standard-shell optional fields generic: %s', (_label, fields) => {
    expect(terminalCardModel(running({ argsRaw: shellArgs(fields) }))).toBeNull()
  })

  it('accepts valid optional and unknown standard-shell fields on the open parameter root', () => {
    expect(terminalCardModel(running({ argsRaw: shellArgs({
      timeoutMs: 1_000,
      sandbox_permissions: 'workspace-write',
      justification: 'Write generated output',
      extension: { version: 1 },
    }) }))).not.toBeNull()
  })

  it('validates terminal_send optional fields while retaining open-root extensions', () => {
    const send = (over: Record<string, unknown>) => running({
      name: 'terminal_send',
      argsRaw: JSON.stringify({ sessionId: 'pty-1', text: 'make', ...over }),
    })
    expect(terminalCardModel(send({ submit: 'yes' }))).toBeNull()
    expect(terminalCardModel(send({ run_in_background: 'yes' }))).toBeNull()
    expect(terminalCardModel(send({ submit: false, run_in_background: false }))).not.toBeNull()
    expect(terminalCardModel(send({ extension: { version: 1 } }))).not.toBeNull()
  })

  it('keeps persistent shells with open-root extension fields on the running-card path', () => {
    const argsRaw = JSON.stringify({ command: 'pwd', extension: { version: 1 } })
    expect(terminalCardModel(running({ argsRaw }))).not.toBeNull()
    expect(terminalCardModel(running({ name: 'pwsh', argsRaw }))).not.toBeNull()
  })
})

describe('chat row terminal body', () => {
  const ownerProps = (block: StartedToolCall | ToolResultNode): GenericToolCardProps => ({
    loadImage: vi.fn(() => Promise.reject(new Error('not used'))),
    useDisclosure, callId: 'c1', toolName: 'bash', ...('kind' in block ? { phase: 'result' as const, block: block } : { phase: block.phase, block: block }), openFile: vi.fn(), t,
  })

  /** The whole summary row is the expand toggle (ToolRow's unified interaction). */
  const toggleRow = (view: { container: HTMLElement }) => {
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
  }

  it('the expanded body is the command output inside the row scroll container', () => {
    const view = render(<GenericToolCard {...ownerProps(settled())} />)
    // Collapsed: the one-line summary row only, no output.
    expect(view.getByText('List files')).toBeTruthy()
    expect(view.queryByText(/a\.ts/)).toBeNull()
    toggleRow(view)
    expect(view.getByText('a.ts  b.ts', RAW)).toBeTruthy()
    expect(view.getByText('ls -la')).toBeTruthy()
    // The args JSON body the generic path would have shown is gone.
    expect(view.queryByText(/"command"/)).toBeNull()
  })

  it('a long output renders in full — the scroll container replaces the middle collapse', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`)
    const view = render(<GenericToolCard {...ownerProps(settled({
      content: [{ type: 'text', text: `${lines.join('\n')}\n` }],
    }))} />)
    toggleRow(view)
    expect(view.getByText('line-5')).toBeTruthy()
    expect(view.getByText('line-19')).toBeTruthy()
    expect(view.queryByText(/其余/)).toBeNull()
  })

  it('renders a multi-line command as one prompt row per line', () => {
    const view = render(<GenericToolCard {...ownerProps(settled({
      call: { name: 'bash', argsRaw: shellArgs({ command: 'ls -la\necho done' }) },
    }))} />)
    toggleRow(view)
    const rows = view.container.querySelectorAll('[class^="_promptLine_"]')
    expect([...rows].map(row => row.textContent)).toEqual(['$ls -la', '$echo done'])
    // Still one dot for the call, on the first row.
    expect(view.container.querySelectorAll('[data-terminal] [data-state]')).toHaveLength(1)
  })

  it('the fallback row shows the call description', () => {
    const view = render(<GenericToolCard {...ownerProps(settled({
      call: { name: 'bash', argsRaw: shellArgs({ description: 'Terminal 3' }) },
    }))} />)
    expect(view.getByText('Terminal 3')).toBeTruthy()
    expect(view.queryByText('List files')).toBeNull()
  })

  it('keeps the call description visible once the terminal card is expanded', () => {
    const view = render(<GenericToolCard {...ownerProps(settled({
      call: { name: 'bash', argsRaw: shellArgs({ description: 'Terminal 3' }) },
    }))} />)
    expect(view.getByText('Terminal 3')).toBeTruthy()
    toggleRow(view)
    expect(view.container.querySelector('[data-terminal]')).not.toBeNull()
    expect(view.getByText('Terminal 3')).toBeTruthy()
  })

  it('a running terminal call expands to the prompt line with no output yet', () => {
    const view = render(<GenericToolCard {...ownerProps(running())} />)
    toggleRow(view)
    expect(view.getByText('ls -la')).toBeTruthy()
    expect(view.queryByText('复制')).toBeNull()
    // The card states its own run state: a running command reads as running
    // even though it has no output yet to distinguish it from an empty settle.
    expect(runStateOf(view.container)).toBe('ongoing')
  })

  it.each([
    { locale: 'zh', translate: t, description: '终端 pty-3', command: '（发送输入）' },
    { locale: 'en', translate: enT, description: 'Terminal pty-3', command: '(send input)' },
  ])('renders terminal_send copy through the $locale locale', ({ translate, description, command }) => {
    const block = running({
      name: 'terminal_send',
      argsRaw: JSON.stringify({ sessionId: 'pty-3', text: '' }),
    })
    const view = render(<GenericToolCard {...ownerProps(block)} toolName="terminal_send" t={translate} />)
    expect(view.getByText(description)).toBeTruthy()
    toggleRow(view)
    expect(view.getByText(command)).toBeTruthy()
  })

  it('a non-terminal call keeps the args-JSON text body', () => {
    const view = render(<GenericToolCard {...ownerProps(settled({
      call: { name: 'bash', argsRaw: shellArgs({ run_in_background: true }) },
    }))} />)
    toggleRow(view)
    expect(view.getByText(/"command"/)).toBeTruthy()
  })

  it('malformed empty args use the generic output body', () => {
    const view = render(<GenericToolCard {...ownerProps(settled({
      call: { name: 'bash', argsRaw: '' },
    }))} />)
    toggleRow(view)
    expect(view.container.querySelector('[class*="_ioText_"]')?.textContent).toBe('a.ts  b.ts\nc.ts  d.ts\n')
    expect(view.container.querySelector('[data-terminal]')).toBeNull()
  })

  it('a failing exit status surfaces as the collapsed row\'s error state', () => {
    const view = render(<GenericToolCard {...ownerProps(settled({
      content: [{ type: 'text', text: 'boom\n[exit code: 2]' }],
    }))} />)
    expect(view.container.querySelector('[data-state]')?.getAttribute('data-state')).toBe('error')
  })
})

describe('BashRow terminal card', () => {
  const list = () => createSnapshotStore<SessionListState>({
    ids: [SID],
    byId: { [SID]: { id: SID, displayTitle: 'r', running: false, retainedBy: {}, blank: false, updatedAt: 0 } },
    phase: 'ready',
    projectionsBySession: {},
  })

  const rowProps = (block: StartedToolCall | ToolResultNode): BashRowProps => ({
    useDisclosure, callId: 'c1', toolName: 'bash', ...('kind' in block ? { phase: 'result' as const, block: block } : { phase: block.phase, block: block }), openFile: vi.fn(),
    sessionId: SID, useSessions: bindSnapshotSelector(list()),
    t,
  } as BashRowProps)

  it('collapses to the summary row; the whole row toggles the command output', () => {
    const view = render(<BashRow {...rowProps(settled())} />)
    expect(view.getByText('List files')).toBeTruthy()
    expect(view.queryByText(/a\.ts/)).toBeNull()
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
    expect(view.getByText('a.ts  b.ts', RAW)).toBeTruthy()
    expect(view.getByText('复制')).toBeTruthy()
    // Collapse back in place: the summary row returns, the card unmounts.
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
    expect(view.queryByText(/a\.ts/)).toBeNull()
    expect(view.getByText('List files')).toBeTruthy()
  })

  // The row's running state and the card's run-state dot describe the same
  // command, so a running row whose card claimed 'done' would contradict itself.
  it('agrees with the summary row about the run state', () => {
    const runningView = render(<BashRow {...rowProps(running())} />)
    expect(runningView.container.querySelector('[data-variant="bash"]')?.getAttribute('data-state')).toBe('running')
    fireEvent.click(runningView.container.querySelector('[data-expandable]')!)
    expect(runStateOf(runningView.container)).toBe('ongoing')
    cleanup()
    const settledView = render(<BashRow {...rowProps(settled())} />)
    expect(settledView.container.querySelector('[data-variant="bash"]')?.getAttribute('data-state')).toBe('ok')
    fireEvent.click(settledView.container.querySelector('[data-expandable]')!)
    expect(runStateOf(settledView.container)).toBe('done')
  })

  it('a failing exit status surfaces as the collapsed row\'s error state', () => {
    const view = render(<BashRow {...rowProps(settled({
      content: [{ type: 'text', text: 'boom\n[exit code: 2]' }],
    }))} />)
    expect(view.container.querySelector('[data-variant="bash"]')?.getAttribute('data-state')).toBe('error')
    expect(view.container.querySelector('[class*="_errorSummary_"]')?.textContent).toBe('List files')
  })

  it('shows the call description as the terminal summary', () => {
    const view = render(<BashRow {...rowProps(settled({
      call: { name: 'bash', argsRaw: shellArgs({ description: 'Terminal 3' }) },
    }))} />)
    expect(view.getByText('Terminal 3')).toBeTruthy()
    expect(view.queryByText('List files')).toBeNull()
  })

  it('expands a settled persistent shell through the generic input/output card', () => {
    const view = render(<BashRow {...rowProps(settled({
      call: { name: 'bash', argsRaw: JSON.stringify({ command: 'ls -la' }) },
    }))} />)
    const row = view.container.querySelector('[data-sample="bash"]')!
    expect(view.getByText('ls -la')).toBeTruthy()
    expect(row.getAttribute('role')).toBe('button')
    expect(row.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(row)

    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText('输入')).toBeTruthy()
    expect(view.getByText('输出')).toBeTruthy()
    expect(view.getByText(/"command": "ls -la"/)).toBeTruthy()
    expect(view.container.querySelector('[class*="_ioText_"][data-error]')).toBeNull()
    expect(view.container.querySelectorAll('[class*="_ioText_"]')[1]?.textContent)
      .toBe('a.ts  b.ts\nc.ts  d.ts\n')
  })

  it('expands a spilled child result without a successful terminal indicator', () => {
    const output = 'failed\n[exit code: 7]\n\n(Omitted 50000 bytes. Full formatted result stored at: /spill/output.txt. Read the file.)'
    const view = render(<BashRow {...rowProps(settled({
      parentCallId: 'parent', content: [{ type: 'text', text: output }],
    }))} />)
    const row = view.container.querySelector('[data-sample="bash"]')!
    expect(row.getAttribute('role')).toBe('button')
    fireEvent.click(row)
    expect(view.container.querySelector('[data-terminal]')).toBeNull()
    expect(view.container.querySelectorAll('[class*="_ioText_"]')[1]?.textContent).toBe(output)
  })

  it('a non-terminal bash call (background start) renders the summary row alone', () => {
    const view = render(<BashRow {...rowProps(settled({
      call: { name: 'bash', argsRaw: shellArgs({ command: 'sleep 30', description: 'Wait', run_in_background: true }) },
      content: [{ type: 'text', text: 'started background job job-1' }],
    }))} />)
    expect(view.getByText('Wait')).toBeTruthy()
    expect(view.queryByText(/a\.ts/)).toBeNull()
    expect(view.container.querySelector('[data-sample="bash"]')?.getAttribute('role')).toBeNull()
  })

  it('expands a generic execution error to its original args and full output', () => {
    const view = render(<BashRow {...rowProps(settled({
      content: [{ type: 'text', text: 'Error: command aborted' }],
      isError: true,
    }))} />)
    const row = view.container.querySelector('[data-sample="bash"]')!
    expect(row.getAttribute('role')).toBe('button')
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByText(/"command": "ls -la"/)).toBeNull()

    fireEvent.click(row)

    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText('输入')).toBeTruthy()
    expect(view.getByText('输出')).toBeTruthy()
    expect(view.getByText(/"command": "ls -la"/)).toBeTruthy()
    expect(view.container.querySelector('[data-error]')?.textContent).toBe('Error: command aborted')
  })
})
