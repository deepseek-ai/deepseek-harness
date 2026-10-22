/** A scripted Node child whose control traffic tests read and forge without starting a process. */
import { Duplex, PassThrough } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { PtcRunRequest } from '@deepseek-ai/dsh-ptc-runtime'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { onTestFinished, vi } from 'vitest'
import type NodeRuntime from '../src/index.ts'
import { rawPeer } from './raw-peer.ts'

/** Pass as `first` to start a run without sending readiness. */
export const NO_INITIAL_FRAME = Symbol('no initial frame')

/**
 * Replace process launch with an in-memory child whose control pipe the test drives.
 * @param ctx - Context whose subprocess service is stubbed.
 * @param runtime - Provider under test.
 * @param request - Default request for `start`.
 * @returns Process handles, recorded messages, and helpers that forge child traffic.
 */
export function fakeChild(ctx: Context, runtime: NodeRuntime, request: PtcRunRequest) {
  const control = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      if (childControl.destroyed) { callback(new Error('peer closed')); return }
      childControl.push(chunk)
      callback()
    },
  })
  const childControl = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      if (control.destroyed) { callback(new Error('peer closed')); return }
      control.push(chunk)
      callback()
    },
  })
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const direct = Promise.withResolvers<SubprocessOutcome>()
  const messages: unknown[] = []
  const terminate = vi.fn(() => {
    stdout.end()
    stderr.end()
    direct.resolve({ exitCode: 0, signal: null })
  })
  const waitForExit = vi.fn(async () => true)
  const handle: SubprocessHandle = {
    stdin: undefined,
    stdout,
    stderr,
    control,
    collected: {},
    done: direct.promise,
    terminate,
    waitForExit,
  }
  const writes = new Set<Promise<void>>()
  let runId = ''
  let receive: (message: unknown) => void = () => {}
  const peer = rawPeer(childControl, (message) => {
    if (typeof message === 'object' && message !== null && 't' in message && message.t === 'q'
      && 'm' in message && message.m === 'run' && 'i' in message && typeof message.i === 'string') runId = message.i
    messages.push(message)
    receive(message)
  })
  const emit = (message: unknown): void => {
    const write = peer.send(message).catch(() => {}).finally(() => { writes.delete(write) })
    writes.add(write)
  }
  const resolveExecutable = vi.spyOn(ctx.subprocess, 'resolveExecutable').mockResolvedValue(process.execPath)
  const spawn = vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue(handle)
  onTestFinished(async () => {
    peer.close()
    control.destroy()
    stdout.destroy()
    stderr.destroy()
    direct.resolve({ exitCode: 0, signal: null })
    await Promise.all(writes)
  })
  const start = (input: PtcRunRequest = request, first: unknown = { t: 'q', m: 'ready', a: [] }) => {
    const result = runtime.run(runtime.resolve(input))
    if (first !== NO_INITIAL_FRAME) queueMicrotask(() => { emit(first) })
    return result
  }
  const onBoot = (callback: () => void): void => {
    receive = (message) => {
      if (typeof message === 'object' && message !== null && 'm' in message && message.m === 'run') callback()
    }
  }
  return {
    handle, terminate, waitForExit, direct, stdout, stderr, control, peer, messages,
    spawn, resolveExecutable, emit, start, onBoot,
    complete: (result: unknown) => { emit({ t: 's', i: runId, r: result }) },
    receive: (callback: typeof receive) => { receive = callback },
  }
}
