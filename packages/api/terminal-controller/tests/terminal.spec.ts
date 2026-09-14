/** Terminal screen continuity and process ownership under real output scheduling. */
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessOutcome, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { BrowserTerminal } from '../src/terminal.ts'
import { TerminalFollower } from '../src/stream.ts'
import type { TerminalAttachmentId, TerminalFrame, WebTerminalId, WebTerminalInfo } from '../src/types.ts'

const info: WebTerminalInfo = { id: 'terminal-test' as WebTerminalId, title: 'bash', shell: { path: '/bin/bash', name: 'bash', args: ['-i'] }, cwd: '/workspace', cols: 80, rows: 24, state: 'running', exitCode: null }
const attachment = (id: string): TerminalAttachmentId => id as TerminalAttachmentId
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(close => close())) })

function fixture() {
  const output = new PassThrough()
  const outcome = Promise.withResolvers<SubprocessOutcome>()
  const handle = {
    pid: 123, output, done: outcome.promise, write: vi.fn(async () => {}), resize: vi.fn(async () => {}),
    inspectForeground: async () => undefined, signalForeground: async () => 123,
    terminate: vi.fn(async () => { output.end(); outcome.resolve({ exitCode: 0, signal: null }) }),
  }
  const checked: SubprocessTerminalHandle = handle
  const terminal = new BrowserTerminal(checked, info, 100, 100_000)
  cleanups.push(() => terminal.close())
  return { terminal, output, outcome, handle }
}

async function attach(terminal: BrowserTerminal, id = 'first') {
  const controller = new AbortController()
  const iterator = terminal.follow(attachment(id), controller.signal)[Symbol.asyncIterator]()
  const baseline = await readFrame(iterator)
  cleanups.push(async () => { controller.abort(); await iterator.return?.() })
  return { controller, iterator, baseline }
}

describe('BrowserTerminal', () => {
  it('restores the screen after detach without re-executing the shell or replaying duplicate output', async () => {
    const { terminal, output, handle } = fixture()
    const first = await attach(terminal)
    expect(first.baseline).toMatchObject({ type: 'snapshot', sequence: 0 })
    output.write(Buffer.from('hello\r\n'))
    expect(await readFrame(first.iterator)).toMatchObject({ type: 'output', sequence: 1, data: 'hello\r\n' })
    first.controller.abort()
    await first.iterator.return?.()
    expect(handle.terminate).not.toHaveBeenCalled()
    output.write(Buffer.from('world'))
    await expect.poll(() => terminal.info.state).toBe('running')
    const second = await attach(terminal, 'second')
    // The baseline and its output queue share the same ordered screen write queue.
    const frames = [second.baseline]
    if (second.baseline.type === 'snapshot' && !second.baseline.screen.includes('world')) frames.push(await readFrame(second.iterator))
    expect(JSON.stringify(frames)).toContain('world')
    expect(JSON.stringify(frames)).toContain('hello')
    expect(handle.terminate).not.toHaveBeenCalled()
  })

  it('preserves split UTF-8, gives the newest attachment input, and resizes both PTY and recovery screen', async () => {
    const { terminal, output, handle } = fixture()
    const first = await attach(terminal)
    const encoded = Buffer.from('终端')
    output.write(encoded.subarray(0, 2))
    await expect.poll(() => output.readableLength).toBe(0)
    output.write(encoded.subarray(2))
    expect(await readFrame(first.iterator)).toMatchObject({ type: 'output', data: '终端' })
    const second = await attach(terminal, 'second')
    await expect(terminal.write(attachment('first'), 'ignored')).rejects.toMatchObject({ code: 'terminal/control-unavailable', details: { reason: 'read-only' } })
    await terminal.write(attachment('second'), '\t')
    expect(handle.write).toHaveBeenCalledWith('\t')
    await terminal.resize(attachment('second'), 100, 30)
    expect(handle.resize).toHaveBeenCalledWith(100, 30)
    expect(terminal.info).toMatchObject({ cols: 100, rows: 30 })
    second.controller.abort()
    await second.iterator.return?.()
    expect(terminal.info.controllerId).toBeUndefined()
  })

  it('keeps exit facts and screen until explicit cleanup and never starts a replacement process', async () => {
    const { terminal, output, outcome, handle } = fixture()
    const first = await attach(terminal)
    output.end('done')
    outcome.resolve({ exitCode: 7, signal: null })
    expect(await readFrame(first.iterator)).toMatchObject({ type: 'output', data: 'done' })
    expect(await readFrame(first.iterator)).toMatchObject({ type: 'state', info: { state: 'exited', exitCode: 7 } })
    expect(handle.terminate).not.toHaveBeenCalled()
    const second = await attach(terminal, 'second')
    expect(second.baseline).toMatchObject({ type: 'snapshot', info: { state: 'exited', exitCode: 7 } })
    await terminal.close()
    expect(handle.terminate).toHaveBeenCalledOnce()
  })

  it('drains final output and exit state before closing followers', async () => {
    const { terminal, handle, output, outcome } = fixture()
    const first = await attach(terminal)
    vi.mocked(handle.terminate).mockImplementationOnce(async () => {
      output.end('FINAL OUTPUT\r\n')
      outcome.resolve({ exitCode: 0, signal: null })
    })
    await terminal.close()
    expect(await readFrame(first.iterator)).toMatchObject({ type: 'output', data: 'FINAL OUTPUT\r\n' })
    expect(await readFrame(first.iterator)).toMatchObject({ type: 'state', info: { state: 'exited' } })
    expect((await first.iterator.next()).done).toBe(true)
  })

  it('rejects input before attachment, during close and after process exit', async () => {
    const { terminal, handle, output, outcome } = fixture()
    await expect(terminal.write(attachment('first'), 'ignored')).rejects.toMatchObject({ code: 'terminal/control-unavailable', details: { reason: 'read-only' } })
    const first = await attach(terminal)
    output.end()
    outcome.resolve({ exitCode: 0, signal: null })
    expect(await readFrame(first.iterator)).toMatchObject({ type: 'state', info: { state: 'exited' } })
    await expect(terminal.write(attachment('first'), 'ignored')).rejects.toMatchObject({ code: 'terminal/control-unavailable', details: { reason: 'not-running' } })
    await expect(terminal.resize(attachment('first'), 100, 30)).rejects.toMatchObject({ code: 'terminal/control-unavailable', details: { reason: 'not-running' } })
    const closing = terminal.close()
    await expect(terminal.write(attachment('first'), 'ignored')).rejects.toMatchObject({ code: 'terminal/control-unavailable', details: { reason: 'not-running' } })
    await closing
    expect(handle.write).not.toHaveBeenCalled()
    expect(handle.resize).not.toHaveBeenCalled()
  })

  it('preserves the input controller when an older follower detaches', async () => {
    const { terminal, handle } = fixture()
    const first = await attach(terminal)
    const second = await attach(terminal, 'second')
    first.controller.abort()
    await first.iterator.return?.()
    expect(terminal.info.controllerId).toBe(attachment('second'))
    terminal.rename('build output')
    expect(await readFrame(second.iterator)).toMatchObject({ type: 'state', info: { title: 'build output', controllerId: 'second' } })
    await terminal.write(attachment('second'), 'pwd\r')
    expect(handle.write).toHaveBeenCalledWith('pwd\r')
  })

  it('does not grant input to attachments cancelled before their snapshot is ready', async () => {
    const { terminal, handle } = fixture()
    const aborted = new AbortController()
    aborted.abort(new Error('already detached'))
    await expect(terminal.follow(attachment('cancelled'), aborted.signal)[Symbol.asyncIterator]().next()).rejects.toThrow('already detached')
    await attach(terminal)
    const writing = Promise.withResolvers<undefined>()
    const written = Promise.withResolvers<undefined>()
    handle.write.mockImplementationOnce(async () => { writing.resolve(undefined); await written.promise })
    const pendingWrite = terminal.write(attachment('first'), 'pwd\r')
    try {
      await writing.promise
      const abort = new AbortController()
      const pendingAttachment = terminal.follow(attachment('late'), abort.signal)[Symbol.asyncIterator]().next()
      const rejected = expect(pendingAttachment).rejects.toThrow('detached while waiting')
      abort.abort(new Error('detached while waiting'))
      written.resolve(undefined)
      await pendingWrite
      await rejected
      expect(terminal.info.controllerId).toBe(attachment('first'))
    } finally { written.resolve(undefined) }
  })

  it('continues accepting operations after a provider write or resize fails', async () => {
    const { terminal, handle } = fixture()
    await attach(terminal)
    handle.write.mockRejectedValueOnce(new Error('input transport failed'))
    handle.resize.mockRejectedValueOnce(new Error('resize transport failed'))
    await expect(terminal.write(attachment('first'), 'failed')).rejects.toThrow('input transport failed')
    await expect(terminal.resize(attachment('first'), 100, 30)).rejects.toThrow('resize transport failed')
    expect(terminal.info).toMatchObject({ cols: 80, rows: 24 })
    await terminal.write(attachment('first'), 'accepted')
    await terminal.resize(attachment('first'), 90, 25)
    expect(handle.write).toHaveBeenLastCalledWith('accepted')
    expect(terminal.info).toMatchObject({ cols: 90, rows: 25 })
  })

  it.each([new Error('process wait failed'), 'remote process wait failed'])('publishes a failed process outcome and retains its recovery screen: %s', async (failure) => {
    const { terminal, output, outcome } = fixture()
    const first = await attach(terminal)
    output.end('last output')
    outcome.reject(failure)
    expect(await readFrame(first.iterator)).toMatchObject({ type: 'output', data: 'last output' })
    expect(await readFrame(first.iterator)).toMatchObject({ type: 'state', info: { state: 'failed', error: failure instanceof Error ? failure.message : failure } })
    const second = await attach(terminal, 'second')
    expect(second.baseline).toMatchObject({ type: 'snapshot', screen: 'last output', info: { state: 'failed' } })
  })

  it('publishes output-stream failure even when the process wait succeeds', async () => {
    const { terminal, output, outcome } = fixture()
    const first = await attach(terminal)
    output.destroy(new Error('output transport failed'))
    outcome.resolve({ exitCode: 0, signal: null })
    expect(await readFrame(first.iterator)).toMatchObject({ type: 'state', info: { state: 'failed', error: 'output transport failed' } })
  })

  it('flushes incomplete UTF-8 at EOF before publishing the process exit', async () => {
    const { terminal, output, outcome } = fixture()
    const first = await attach(terminal)
    output.end(Buffer.from([0xe7, 0xbb]))
    outcome.resolve({ exitCode: 0, signal: null })
    expect(await readFrame(first.iterator)).toMatchObject({ type: 'output', data: '�' })
    expect(await readFrame(first.iterator)).toMatchObject({ type: 'state', info: { state: 'exited' } })
  })

  it('preserves a leading UTF-8 BOM in the terminal output stream', async () => {
    const { terminal, output } = fixture()
    const first = await attach(terminal)
    output.write(Buffer.from('\uFEFF终端'))
    expect(await readFrame(first.iterator)).toMatchObject({ type: 'output', data: '\uFEFF终端' })
  })

  it('shares concurrent close attempts and permits retry after termination fails', async () => {
    const { terminal, handle } = fixture()
    await attach(terminal)
    handle.terminate.mockRejectedValueOnce(new Error('process range remains alive'))
    const first = terminal.close()
    expect(terminal.close()).toBe(first)
    await expect(first).rejects.toThrow('remains alive')
    await terminal.write(attachment('first'), 'retry cleanup next')
    await terminal.close()
    expect(handle.terminate).toHaveBeenCalledTimes(2)
  })

  it('reports overflow rather than silently discarding output', async () => {
    const follower = new TerminalFollower(64)
    follower.push({ type: 'output', sequence: 1, data: 'x'.repeat(128) })
    await expect(follower.read(new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toThrow('buffer')
  })
})

async function readFrame(iterator: AsyncIterator<TerminalFrame>): Promise<TerminalFrame> {
  const result = await iterator.next()
  if (result.done === true) throw new Error('Terminal stream ended before its expected frame')
  return result.value
}
