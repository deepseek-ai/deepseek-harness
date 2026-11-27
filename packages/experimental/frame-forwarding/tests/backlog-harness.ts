/**
 * Shared setup of the pending-event e2e suites: builds `fixtures/backlog-producer.cc` and the fake Desktop sink with the
 * host toolchain, records receiver events and producer output, and blocks the JavaScript thread so the receiver's
 * native threads queue events behind it. A blocked thread cannot read child output, so producers also report each
 * observation as a signal file that a blocked wait can test synchronously.
 */
import { receiverAddon } from './desktop-receiver.ts'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { loadFrameForwardingBindings } from '../src/host/native.ts'
import type { FrameForwardingAdapterId, FrameForwardingBindings, FrameForwardingBudget, FrameForwardingReceiver, FrameForwardingReceiverEvent } from '../src/host/native.ts'
import { buildFakeSink, buildFixtureProducer, type FakeSinkAddon } from './fake-sink.ts'

export type Event = FrameForwardingReceiverEvent

/** The `disconnected` text of a connection the receiver ended for exceeding its pending-event quota. */
export const pendingLimitText = 'Frame-forwarding producer exceeded the pending event limit (256)'
/** Producer events (messages, presentation errors and frames for JavaScript) one connection may have pending. */
export const pendingLimit = 256

const addonPath = receiverAddon

/** Whether this host can build the fixtures and load the receiver: Windows or macOS with the addon built. */
export const nativeSupported = (process.platform === 'win32' || process.platform === 'darwin') && existsSync(addonPath)

export interface Harness {
  scratch: string
  producer: string
  fakes: FakeSinkAddon
  bindings: FrameForwardingBindings
  displayAdapter: FrameForwardingAdapterId | null
  children: ChildProcess[]
  signals: number
}

/** Build the producer and fake sink into a scratch directory and load the receiver addon. */
export async function setupHarness(): Promise<Harness> {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-frame-forwarding-backlog-'))
  const built = buildFakeSink(scratch)
  const producer = buildFixtureProducer(scratch, 'backlog-producer', built.run)
  let displayAdapter: FrameForwardingAdapterId | null = null
  if (process.platform === 'win32') {
    displayAdapter = built.fakes.defaultAdapter() as FrameForwardingAdapterId | null
    expect(displayAdapter, 'a Windows receiver needs a hardware D3D11 adapter').not.toBeNull()
  }
  const bindings = loadFrameForwardingBindings(addonPath)
  return { scratch, producer, fakes: built.fakes, bindings, displayAdapter, children: [], signals: 0 }
}

/** Stop every producer still running. */
export async function killProducers(harness: Harness): Promise<void> {
  await Promise.all(harness.children.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
  }))
}

/** Stop every producer still running and remove the scratch directory. */
export async function teardownHarness(harness: Harness | undefined): Promise<void> {
  if (!harness) return
  await killProducers(harness)
  try {
    await rm(harness.scratch, { recursive: true, force: true })
  } catch (error) {
    // Windows keeps the loaded fake sink open until the worker exits; the other build outputs are gone.
    if (process.platform !== 'win32' || !(error instanceof Error) || !('code' in error) || error.code !== 'EPERM') throw error
  }
}

/** A fresh signal-file prefix for one producer. */
export function signalPrefix(harness: Harness): string {
  return join(harness.scratch, `signal-${String(++harness.signals)}`)
}

/** Whether the producer started with `signal=<prefix>` has reported `word`. */
export function signalled(prefix: string, word: string): boolean {
  return existsSync(`${prefix}.${word}`)
}

/**
 * Block the JavaScript thread, so no receiver event is dispatched, until `condition` holds or `ms` elapses.
 * @returns Whether the condition held; the caller asserts it after the receiver callback that blocked has returned.
 */
export function blockUntil(condition: () => boolean, ms: number): boolean {
  const cell = new Int32Array(new SharedArrayBuffer(4))
  const deadline = performance.now() + ms
  while (!condition()) {
    if (performance.now() >= deadline) return false
    Atomics.wait(cell, 0, 0, 5)
  }
  return true
}

/** Block the JavaScript thread for `ms`; the stress suite varies stalls without a condition. */
export function blockFor(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Await a promise with a deadline; resolves to 'timeout' when it expires. */
export async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<'timeout'>((resolve) => { timer = setTimeout(() => { resolve('timeout') }, ms) })])
  } finally {
    clearTimeout(timer)
  }
}

/** A credential naming the same endpoint with a wrong secret. */
export function corruptTx(tx: string): string {
  const parts = tx.split('|')
  parts[2] = parts[2]!.replace(/[0-9a-f]/gu, char => (char === '0' ? '1' : '0'))
  return parts.join('|')
}

/** Events of one connection, in arrival order. */
export function ofConnection(events: readonly Event[], connectionId: number): Event[] {
  return events.filter(event => 'connectionId' in event && event.connectionId === connectionId)
}

/** The `seq` of each flooded message, or -1 for another message. */
export function sequence(events: readonly Event[]): number[] {
  return events.flatMap(event => event.type === 'message' ? [Number(/^\{"seq":(\d+),/u.exec(event.text)?.[1] ?? -1)] : [])
}

export interface Channel {
  receiver: FrameForwardingReceiver
  events: Event[]
  /**
   * Resolve once `condition` holds over the recorded events, checked after each event.
   * @throws When `ms` elapses first, naming `label` and the recorded event types.
   */
  waitFor(label: string, condition: (events: readonly Event[]) => boolean, ms: number): Promise<void>
  count(type: Event['type']): number
}

export interface ChannelOptions {
  maxFrames?: number
  maxBytes?: number
  budget?: FrameForwardingBudget
  /** Release each delivered frame before `hook` runs; defaults to true. */
  releaseFrames?: boolean
}

/**
 * One native receiver without a Desktop sink, so frames reach JavaScript, whose events are recorded. `hook` runs
 * inside the receiver callback, after recording, so a stall there holds back every later event.
 */
export function createChannel(harness: Harness, hook?: (event: Event, receiver: FrameForwardingReceiver) => void,
  options: ChannelOptions = {}): Channel {
  const { maxFrames = 2, maxBytes = 1 << 20, releaseFrames = true } = options
  const events: Event[] = []
  const waiters = new Set<() => void>()
  const receiver: FrameForwardingReceiver = harness.bindings.createReceiver({
    maxFrames, maxBytes, budget: options.budget ?? harness.bindings.createBudget(maxBytes),
    displayAdapter: harness.displayAdapter, readbackTimeoutMs: 10_000,
  }, (event) => {
    events.push(event)
    if (event.type === 'frame' && releaseFrames) receiver.release(event.deliveryId)
    hook?.(event, receiver)
    for (const waiter of [...waiters]) waiter()
  })
  return {
    receiver, events,
    count: type => events.filter(event => event.type === type).length,
    waitFor: async (label, condition, ms) => {
      if (condition(events)) return
      let check = () => {}
      const met = new Promise<void>((resolve) => {
        check = () => { if (condition(events)) resolve() }
        waiters.add(check)
      })
      try {
        if (await within(met, ms) === 'timeout')
          throw new Error(`Timed out after ${String(ms)} ms waiting for ${label}; events: ${summarize(events)}`)
      } finally {
        waiters.delete(check)
      }
    },
  }
}

/** Event types with consecutive repeats folded, such as `connected message×256 disconnected drained`. */
export function summarize(events: readonly Event[]): string {
  const runs: { type: string; count: number }[] = []
  for (const event of events) {
    const type = 'connectionId' in event ? `${event.type}#${String(event.connectionId)}` : event.type
    const last = runs.at(-1)
    if (last?.type === type) last.count++; else runs.push({ type, count: 1 })
  }
  return runs.map(({ type, count }) => (count > 1 ? `${type}×${String(count)}` : type)).join(' ')
}

export interface Producer {
  child: ChildProcess
  /** Stdout lines without their timestamps, as `<word> <details>`. */
  lines: string[]
  /** Settles once the process exited and its output was read. */
  exited: Promise<unknown>
  /** The first line whose word is `word`. */
  line(word: string): string | undefined
  /** Resolve with the first line whose word is one of `words`; undefined when `ms` elapses first. */
  waitLine(words: string[], ms: number): Promise<string | undefined>
  stderr(): string
  kill(): Promise<void>
}

/** Start the backlog producer with `<tx> <mode> key=value...`. */
export function startProducer(harness: Harness, tx: string, mode: 'produce' | 'refuse', options: Record<string, string | number> = {}): Producer {
  const args = [tx, mode, ...Object.entries(options).map(([key, value]) => `${key}=${String(value)}`)]
  const child = spawn(harness.producer, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  harness.children.push(child)
  const lines: string[] = []
  const listeners = new Set<() => void>()
  let buffer = '', stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      lines.push(buffer.slice(0, newline).trim().replace(/^\d+ /u, ''))
      buffer = buffer.slice(newline + 1)
    }
    for (const listener of [...listeners]) listener()
  })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const exited = once(child, 'close')
  const line = (word: string) => lines.find(text => text.split(' ')[0] === word)
  return {
    child, lines, exited, line, stderr: () => stderr,
    waitLine: async (words, ms) => {
      const find = () => words.map(line).find(text => text !== undefined)
      let listener = () => {}
      const found = new Promise<string>((resolve) => {
        listener = () => { const text = find(); if (text !== undefined) resolve(text) }
        listeners.add(listener)
        listener()
      })
      try {
        const text = await within(found, ms)
        return text === 'timeout' ? undefined : text
      } finally {
        listeners.delete(listener)
      }
    },
    async kill() {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGKILL')
      await exited
    },
  }
}
