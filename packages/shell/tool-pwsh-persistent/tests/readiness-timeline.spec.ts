import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessOutcome, SubprocessTerminalForeground, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import type { TerminalSendOperation, TerminalSendResult } from '@deepseek-ai/dsh-terminal'
import { CONTROLLED_PROMPT, TerminalSanitizer } from '@deepseek-ai/dsh-terminal-bash/src/sanitize.ts'
import { ReadinessTimeline, TIMELINE_HEADER, replayPromptEvidence } from './readiness-timeline.ts'

const MARKER = '\x1b]133;D;0\x07'

afterEach(() => {
  vi.restoreAllMocks()
})

interface FakeTerminalState {
  foreground: SubprocessTerminalForeground | undefined
  inspectError: Error | undefined
}

function fakeTerminal(pid: number): { handle: SubprocessTerminalHandle; state: FakeTerminalState; writes: string[] } {
  const state: FakeTerminalState = { foreground: { processGroupId: pid, inputWaiting: false }, inspectError: undefined }
  const writes: string[] = []
  const handle: SubprocessTerminalHandle = {
    pid,
    output: new Readable({ read() {} }),
    done: new Promise<SubprocessOutcome>(() => {}),
    async write(data: string) { writes.push(data) },
    async resize() {},
    async inspectForeground() {
      if (state.inspectError !== undefined) throw state.inspectError
      return state.foreground
    },
    async inspectActivity() { return { state: 'unknown' as const, revision: 0 } },
    async signalForeground() { return pid },
    async terminate() {},
  }
  return { handle, state, writes }
}

function fakeSend(): { operation: TerminalSendOperation; settle: (waitReason: TerminalSendResult['waitReason']) => void; reject: () => void } {
  const resolvers = Promise.withResolvers<TerminalSendResult>()
  const operation: TerminalSendOperation = {
    done: resolvers.promise,
    cancel: () => false,
    readOutput: () => ({ delta: '', truncated: false }),
  }
  return {
    operation,
    settle: (waitReason) => { resolvers.resolve({ viewport: '', waitReason, sessionStatus: { kind: 'running' }, truncated: false }) },
    reject: () => { resolvers.reject(new Error('inspection failed')) },
  }
}

// Let the operation's `done` continuation record the window's end before the next step.
const settled = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('replayPromptEvidence', () => {
  it('mirrors the session rule: exact tail, invalidated tail, pending prefix, absent marker', () => {
    expect(replayPromptEvidence([{ prompt: true, promptTail: '' }, { prompt: false, promptTail: CONTROLLED_PROMPT }]))
      .toEqual({ promptSeen: true, promptTail: CONTROLLED_PROMPT, promptTextSeen: true })
    expect(replayPromptEvidence([{ prompt: true, promptTail: '' }, { prompt: false, promptTail: `${CONTROLLED_PROMPT}Write-Output` }]))
      .toEqual({ promptSeen: true, promptTail: `${CONTROLLED_PROMPT}\0`, promptTextSeen: false })
    expect(replayPromptEvidence([{ prompt: true, promptTail: '' }, { prompt: false, promptTail: 'dsh' }]))
      .toEqual({ promptSeen: true, promptTail: 'dsh', promptTextSeen: false })
    expect(replayPromptEvidence([{ prompt: false, promptTail: undefined }, { prompt: false, promptTail: 'dsh> ' }]))
      .toEqual({ promptSeen: false, promptTail: '', promptTextSeen: false })
    // A later marker restarts the tail, as the session's onData does.
    expect(replayPromptEvidence([
      { prompt: true, promptTail: 'stale text' },
      { prompt: true, promptTail: '' },
      { prompt: false, promptTail: CONTROLLED_PROMPT },
    ])).toEqual({ promptSeen: true, promptTail: CONTROLLED_PROMPT, promptTextSeen: true })
  })
})

describe('ReadinessTimeline', () => {
  it('keeps sends that hand over within one millisecond apart and replays from the input write only', async () => {
    const timeline = new ReadinessTimeline(() => 'host: fake')
    timeline.observeSanitizer()
    const terminal = fakeTerminal(4242)
    timeline.observeTerminal(terminal.handle)
    const sanitizer = new TerminalSanitizer(1024)

    // Send A: input write, a cursor-position query answered by the emulator (a reply write that
    // must not reset the evidence), then the marker and tail, then the settling poll.
    timeline.label('a')
    const a = fakeSend()
    timeline.track(a.operation, { text: 'echo a', submit: true })
    await terminal.handle.write('echo a\r')
    sanitizer.push('a-output\r\n\x1b[6n')
    await terminal.handle.write('\x1b[1;1R')
    sanitizer.push(MARKER)
    sanitizer.push(CONTROLLED_PROMPT)
    await terminal.handle.inspectForeground()
    a.settle('stdin_read')
    await settled()

    // Send B starts in the same millisecond as A's settle and never sees a marker.
    timeline.label('b')
    const b = fakeSend()
    timeline.track(b.operation, { text: 'echo b', submit: true })
    await terminal.handle.write('echo b\r')
    sanitizer.push('b-output\r\n')
    terminal.state.inspectError = new Error('snapshot unreadable')
    await expect(terminal.handle.inspectForeground()).rejects.toThrow('snapshot unreadable')
    b.reject()
    await settled()

    const text = timeline.format()
    expect(text.startsWith(`${TIMELINE_HEADER}\nhost: fake\n`)).toBe(true)
    const [, windowA = '', windowB = ''] = text.split(/^(?=#\d )/m)
    expect(windowA).toMatch(/^#1 a \(from \+\d+ ms\) → stdin_read after \d+ ms\n/)
    expect(windowA).toContain('write s0 7 units (input)')
    expect(windowA).toContain('write s0 6 units (reply)')
    expect(windowA).toContain('replayed evidence at settle: promptSeen=true promptTail="dsh> " promptTextSeen=true')
    expect(windowA).not.toContain('b-output')
    expect(windowB).toMatch(/^#2 b \(from \+\d+ ms\) → rejected after \d+ ms\n/)
    expect(windowB).toContain('polls 1')
    expect(windowB).toContain('threw snapshot unreadable')
    expect(windowB).toContain('replayed evidence at settle: promptSeen=false promptTail="" promptTextSeen=false')
    expect(windowB).not.toContain('a-output')
  })

  it('shows every marker-bearing chunk, bounds the rest, and escapes control bytes', () => {
    const timeline = new ReadinessTimeline()
    timeline.observeSanitizer()
    const sanitizer = new TerminalSanitizer(1024)
    for (let line = 1; line <= 30; line += 1) sanitizer.push(`${line}\r\n`)
    sanitizer.push(`\x1b[H\x1b[K${MARKER}`)
    sanitizer.push(CONTROLLED_PROMPT)
    const text = timeline.format()
    expect(text).toContain('chunks 32 (1 with a prompt marker)')
    expect(text).toContain('… 24 chunks elided …')
    expect(text).toContain('marker=YES tail="" "\\e[H\\e[K\\e]133;D;0\\x07"')
    expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f]/)
  })
})
