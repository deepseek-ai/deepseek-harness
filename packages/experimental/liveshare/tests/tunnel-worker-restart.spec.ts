/**
 * A crashed tunnel worker is replaced, and the shares the owner still holds are registered again.
 *
 * Every case runs a real child process over IPC: the fixture records each registration it receives
 * and exits on a chosen trigger, so the assertions are about what the replacement process was
 * actually handed rather than about the supervisor's internal state.
 */

import { ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { ShareAccessStateFrame, TunnelShareSpec, TunnelWorkerEvent } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { TunnelWorker } from '../src/host/tunnel-worker.ts'
import {
  INITIAL_RETRY_BACKOFF,
  RETRY_BACKOFF_MAX_MS,
  retryBackoffNext,
  retryBackoffSettled,
} from '../src/owner-gateway/retry-backoff.ts'

interface RecordedRegistration {
  readonly shareId: string
  readonly registrationToken: string
  readonly at: number
}

/** Trigger one worker generation exits on, so a test chooses when the process crashes. */
type ExitTrigger = 'first-registration' | 'remove-share'

function workerScript(recordPath: string, exitOn: ExitTrigger): string {
  const exit = exitOn === 'remove-share'
    ? 'if (command.type === "remove-share") setTimeout(() => process.exit(9), 10)'
    : 'if (registered === 1) setTimeout(() => process.exit(7), 20)'
  return `
    const { appendFileSync } = require('node:fs')
    const record = ${JSON.stringify(recordPath)}
    let registered = 0
    process.send({ type: 'ready' })
    process.on('message', (command) => {
      if (command.type === 'shutdown') process.exit(0)
      if (command.type === 'add-share') {
        registered += 1
        appendFileSync(record, JSON.stringify({ shareId: command.share.shareId, registrationToken: command.registrationToken, at: Date.now() }) + '\\n')
        process.send({ type: 'share-connected', registrationToken: command.registrationToken, shareId: command.share.shareId })
      }
      ${exit}
    })
  `
}

function recordPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'liveshare-worker-restart-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  return join(root, 'registrations.ndjson')
}

function registrations(path: string): RecordedRegistration[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(line => line !== '')
    .map(line => JSON.parse(line) as RecordedRegistration)
}

function shareSpec(shareId: string): TunnelShareSpec {
  return {
    shareId,
    sessionId: 'session-1',
    sessionTitle: 'session-1',
    accessMode: 'open',
    relay: 'http://relay.invalid',
    gatewayToken: 'gateway-token',
    ownerDisplayName: 'owner',
    allowedSubjectIds: [],
  }
}

describe('Liveshare tunnel worker restart', () => {
  it('registers the owner shares again after the worker exits', async () => {
    const record = recordPath()
    const worker = new TunnelWorker({
      command: { executable: process.execPath, args: ['-e', workerScript(record, 'first-registration')] },
    })
    const events: string[] = []
    const failures: string[] = []
    worker.onEvent((event) => {
      if (event.type === 'share-connected') events.push(`connected:${event.shareId}`)
      if (event.type === 'share-error') {
        events.push(`offline:${event.shareId}`)
        failures.push(event.message)
      }
    })
    worker.start()
    worker.send({ type: 'add-share', share: shareSpec('share-1') })

    try {
      // The exit marks the share offline; the replacement process then registers it again.
      await expect.poll(() => events).toContain('offline:share-1')
      await expect.poll(() => events.filter(event => event === 'connected:share-1')).toHaveLength(2)

      const registered = registrations(record).filter(entry => entry.shareId === 'share-1')
      // One registration per generation: the replay is the owner's set, not an extra copy of it.
      expect(registered).toHaveLength(2)
      expect(registered[1]!.registrationToken).toBe(registered[0]!.registrationToken)
      expect(registered[0]!.registrationToken).toMatch(/^[0-9a-f-]{36}$/)
      // The replacement waits for the restart delay instead of retrying immediately.
      expect(registered[1]!.at - registered[0]!.at).toBeGreaterThanOrEqual(400)
      expect(failures[0]).toContain('code=7')
    } finally {
      await worker.stop()
    }
  })

  it('hands the replacement only the shares the owner still holds', async () => {
    const record = recordPath()
    const worker = new TunnelWorker({
      command: { executable: process.execPath, args: ['-e', workerScript(record, 'remove-share')] },
    })
    worker.start()
    worker.send({ type: 'add-share', share: shareSpec('share-1') })
    worker.send({ type: 'add-share', share: shareSpec('share-2') })

    try {
      await expect.poll(() => registrations(record).map(entry => entry.shareId))
        .toEqual(['share-1', 'share-2'])
      // Dropping one share is the crash trigger: the worker exits while the owner still holds
      // share-1, so only share-1 belongs to the process that replaces it.
      worker.send({ type: 'remove-share', shareId: 'share-2' })
      await expect.poll(() => registrations(record).map(entry => entry.shareId))
        .toEqual(['share-1', 'share-2', 'share-1'])
    } finally {
      await worker.stop()
    }
  })

  it('leaves the worker stopped when the owner stops it during a restart', async () => {
    const record = recordPath()
    const worker = new TunnelWorker({
      command: { executable: process.execPath, args: ['-e', workerScript(record, 'first-registration')] },
    })
    worker.start()
    worker.send({ type: 'add-share', share: shareSpec('share-1') })

    try {
      await expect.poll(() => registrations(record)).toHaveLength(1)
      await worker.stop()
      await new Promise((resolve) => { setTimeout(resolve, 700) })
      // A pending restart that outlived stop() would resurrect the process the owner just ended.
      expect(registrations(record)).toHaveLength(1)
    } finally {
      await worker.stop()
    }
  })
})

describe('Committed access-state restart intent', () => {
  const snapshot: ShareAccessStateFrame = {
    type: 'share-access-state', version: 3, accessMode: 'selected',
    allowedSubjectIds: ['remaining-viewer'], sessionMode: 'view',
  }

  function snapshotWorker(record: string): TunnelWorker {
    const script = `
      const { appendFileSync, existsSync } = require('node:fs')
      const record = ${JSON.stringify(record)}
      const firstGeneration = !existsSync(record)
      const registered = new Map()
      process.send({ type: 'ready' })
      process.on('message', command => {
        if (command.type === 'shutdown') process.exit(0)
        if (command.type === 'remove-share') {
          if (command.shareId === 'crash-marker') process.exit(7)
          else process.send({ ...${JSON.stringify(snapshot)}, registrationToken: registered.get(command.shareId)?.registrationToken, shareId: command.shareId,
            version: 99, sessionMode: 'write', allowedSubjectIds: ['obsolete-viewer'] })
        }
        if (command.type !== 'add-share') return
        registered.set(command.share.shareId, command)
        appendFileSync(record, JSON.stringify({ ...command.share, registrationToken: command.registrationToken }) + '\\n')
        process.send({ type: 'share-connected', registrationToken: command.registrationToken, shareId: command.share.shareId })
        if (firstGeneration && command.share.sessionMode === 'write') {
          process.send({ ...${JSON.stringify(snapshot)}, registrationToken: command.registrationToken, shareId: command.share.shareId })
          process.send({ ...${JSON.stringify(snapshot)}, registrationToken: command.registrationToken, shareId: command.share.shareId,
            version: 2, sessionMode: 'write', allowedSubjectIds: ['obsolete-viewer'] })
          process.send({ ...${JSON.stringify(snapshot)}, registrationToken: command.registrationToken, shareId: command.share.shareId,
            sessionMode: 'write', allowedSubjectIds: ['obsolete-viewer'] })
        }
        process.send({ type: 'share-rpc-request', registrationToken: command.registrationToken, shareId: command.share.shareId,
          token: 'registration-' + Date.now(), id: 1, body: { recorded: true },
          actor: { providerId: 'mock', tenantId: 'tenant', subjectId: 'barrier' } })
      })
    `
    const worker = new TunnelWorker({ command: { executable: process.execPath, args: ['-e', script] } })
    onTestFinished(() => worker.stop())
    return worker
  }

  function recordedSpecs(record: string): Array<TunnelShareSpec & { registrationToken: string }> {
    if (!existsSync(record)) return []
    return readFileSync(record, 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as TunnelShareSpec & { registrationToken: string })
  }

  it('replays accepted view mode and ACL after a write registration crashes', async () => {
    const record = recordPath()
    const worker = snapshotWorker(record)
    const events: TunnelWorkerEvent[] = []
    worker.onEvent((event) => { events.push(event) })
    worker.send({ type: 'add-share', share: {
      ...shareSpec('share'), sessionMode: 'write', allowsFork: true,
      allowedSubjectIds: ['obsolete-viewer'], expiresAt: '2030-01-01T00:00:00Z',
    } })
    await expect.poll(() => events.filter(event => event.type === 'share-rpc-request')).toHaveLength(1)
    const originalProcess: unknown = Object.getOwnPropertyDescriptor(worker, 'child')?.value
    if (!(originalProcess instanceof ChildProcess)) throw new Error('Supervisor did not retain its child process')
    expect(events.filter(event => event.type === 'share-access-state')).toEqual([{
      ...snapshot, registrationToken: recordedSpecs(record)[0]!.registrationToken, shareId: 'share',
    }])
    worker.send({ type: 'remove-share', shareId: 'crash-marker' })
    await expect.poll(() => recordedSpecs(record), { timeout: 10_000 }).toHaveLength(2)
    await expect.poll(() => events.filter(event => event.type === 'share-rpc-request')).toHaveLength(2)
    const settled = events.length
    const registrationToken = recordedSpecs(record)[0]!.registrationToken
    // Re-deliver old IPC callbacks with the preserved registration UUID after replacement activation.
    originalProcess.emit('message', { type: 'ready' })
    originalProcess.emit('message', { type: 'share-connected', registrationToken, shareId: 'share' })
    originalProcess.emit('message', { ...snapshot, registrationToken, shareId: 'share', version: 100, sessionMode: 'write' })
    originalProcess.emit('message', { type: 'share-error', registrationToken, shareId: 'share', message: 'old-process' })
    originalProcess.emit('message', { type: 'share-closed', registrationToken, shareId: 'share' })
    originalProcess.emit('message', { type: 'share-rpc-request', registrationToken, token: 'old-process', shareId: 'share', id: 1,
      body: {}, actor: { providerId: 'mock', tenantId: 'tenant', subjectId: 'alice' } })
    expect(events).toHaveLength(settled)
    expect(recordedSpecs(record)[1]).toEqual({
      ...shareSpec('share'), registrationToken: recordedSpecs(record)[0]!.registrationToken, accessMode: 'selected', sessionMode: 'view', allowsFork: false,
      allowedSubjectIds: ['remaining-viewer'],
    })
    await worker.stop()
  })

  it('keeps explicit remove/add intent ahead of queued prior-registration snapshots', async () => {
    const record = recordPath()
    const worker = snapshotWorker(record)
    const events: TunnelWorkerEvent[] = []
    worker.onEvent((event) => { events.push(event) })
    worker.send({ type: 'add-share', share: { ...shareSpec('share'), sessionMode: 'write', allowsFork: true } })
    await expect.poll(() => events.filter(event => event.type === 'share-rpc-request')).toHaveLength(1)
    const explicit: TunnelShareSpec = {
      ...shareSpec('share'), sessionMode: 'view', allowsFork: true, allowedSubjectIds: ['owner-choice'],
    }
    worker.send({ type: 'remove-share', shareId: 'share' })
    worker.send({ type: 'add-share', share: explicit })
    await expect.poll(() => events.filter(event => event.type === 'share-rpc-request')).toHaveLength(2)
    expect(events.filter(event => event.type === 'share-access-state')).toEqual([{
      ...snapshot, registrationToken: recordedSpecs(record)[0]!.registrationToken, shareId: 'share',
    }])
    worker.send({ type: 'remove-share', shareId: 'crash-marker' })
    await expect.poll(() => recordedSpecs(record), { timeout: 10_000 }).toHaveLength(3)
    const initialToken = recordedSpecs(record)[0]!.registrationToken
    const explicitToken = recordedSpecs(record)[1]!.registrationToken
    expect(explicitToken).not.toBe(initialToken)
    expect(recordedSpecs(record).slice(1)).toEqual([
      { ...explicit, registrationToken: explicitToken }, { ...explicit, registrationToken: explicitToken },
    ])
    await worker.stop()
  })

  it('ignores removed registration lifecycle, authority and request events after a same-process add', async () => {
    const record = recordPath()
    const script = `
      const { appendFileSync } = require('node:fs')
      const record = ${JSON.stringify(record)}
      let previous
      let current
      process.send({ type: 'ready' })
      const identity = command => ({ shareId: command.share.shareId, registrationToken: command.registrationToken })
      const state = command => ({ type: 'share-access-state', ...identity(command), version: 100,
        accessMode: 'selected', sessionMode: 'write', allowedSubjectIds: ['obsolete-viewer'] })
      const request = (command, token) => ({ type: 'share-rpc-request', ...identity(command), token, id: 1,
        body: { marker: token }, actor: { providerId: 'mock', tenantId: 'tenant', subjectId: 'barrier' } })
      process.on('message', command => {
        if (command.type === 'shutdown') process.exit(0)
        if (command.type === 'remove-share' && command.shareId === 'crash-marker') process.exit(7)
        if (command.type === 'add-share') {
          appendFileSync(record, JSON.stringify({ ...command.share, registrationToken: command.registrationToken }) + '\\n')
          current = command
          if (!previous) {
            previous = command
            process.send({ type: 'share-connected', ...identity(current) })
            process.send(request(current, 'initial-barrier'))
          } else {
            process.send({ type: 'share-connected', ...identity(previous) })
            process.send(state(previous))
            process.send(request(previous, 'stale-request'))
            process.send({ type: 'share-error', ...identity(previous), message: 'obsolete-error' })
            process.send({ type: 'share-closed', ...identity(previous) })
            process.send(request(current, 'current-barrier'))
          }
        }
        if (command.type === 'share-rpc-response' && command.token === 'current-barrier') {
          process.send({ type: 'share-connected', ...identity(current) })
          process.send({ ...state(current), version: 1, sessionMode: 'view', allowedSubjectIds: ['remaining-viewer'] })
          process.send(state(previous))
          process.send({ type: 'share-error', ...identity(previous), message: 'obsolete-error' })
          process.send({ type: 'share-closed', ...identity(previous) })
          process.send(request(current, 'post-state-barrier'))
          process.send({ type: 'share-rpc-cancel', ...identity(previous), token: 'post-state-barrier', id: 1 })
          process.send(request(current, 'cancel-barrier'))
        }
      })
    `
    const worker = new TunnelWorker({ command: { executable: process.execPath, args: ['-e', script] } })
    onTestFinished(() => worker.stop())
    const events: TunnelWorkerEvent[] = []
    worker.onEvent((event) => { events.push(event) })
    const requests = () => events.filter((event): event is Extract<TunnelWorkerEvent, { type: 'share-rpc-request' }> =>
      event.type === 'share-rpc-request')
    worker.send({ type: 'add-share', share: { ...shareSpec('share'), sessionMode: 'write' } })
    await expect.poll(() => requests().length).toBe(1)
    worker.send({ type: 'remove-share', shareId: 'share' })
    worker.send({ type: 'add-share', share: { ...shareSpec('share'), sessionMode: 'view' } })
    await expect.poll(() => requests().some(event => event.token === 'current-barrier')).toBe(true)
    expect(requests().map(event => event.token)).toEqual(['initial-barrier', 'current-barrier'])
    expect(events.filter(event => event.type === 'share-connected')).toHaveLength(1)
    expect(events.filter(event => event.type === 'share-access-state' || event.type === 'share-error'
      || event.type === 'share-closed')).toEqual([])
    const current = requests().find(event => event.token === 'current-barrier')!
    expect(current.registrationToken).not.toBe(requests()[0]!.registrationToken)
    worker.send({ type: 'share-rpc-response', token: current.token, shareId: current.shareId, id: current.id, status: 200 })
    await expect.poll(() => requests().some(event => event.token === 'cancel-barrier')).toBe(true)
    expect(events.filter(event => event.type === 'share-connected')).toHaveLength(2)
    expect(events.filter(event => event.type === 'share-access-state')).toEqual([{
      type: 'share-access-state', registrationToken: current.registrationToken, shareId: 'share', version: 1,
      accessMode: 'selected', sessionMode: 'view', allowedSubjectIds: ['remaining-viewer'],
    }])
    expect(events.filter(event => event.type === 'share-error' || event.type === 'share-closed')).toEqual([])
    expect(events.some(event => event.type === 'share-rpc-cancel' && event.token === 'post-state-barrier')).toBe(false)
    worker.send({ type: 'remove-share', shareId: 'crash-marker' })
    await expect.poll(() => recordedSpecs(record), { timeout: 10_000 }).toHaveLength(3)
    expect(recordedSpecs(record)[2]).toEqual({
      ...shareSpec('share'), registrationToken: current.registrationToken, accessMode: 'selected',
      sessionMode: 'view', allowsFork: false, allowedSubjectIds: ['remaining-viewer'],
    })
    await worker.stop()
  })

})

describe('Liveshare reconnect schedule', () => {
  it('doubles the delay up to a ceiling', () => {
    const delays: number[] = []
    let state = INITIAL_RETRY_BACKOFF
    for (let attempt = 0; attempt < 6; attempt += 1) {
      delays.push(state.delayMs)
      state = retryBackoffNext(state)
    }
    expect(delays).toEqual([500, 1_000, 2_000, 4_000, 8_000, RETRY_BACKOFF_MAX_MS])
    expect(state).toEqual({ delayMs: RETRY_BACKOFF_MAX_MS, attempt: 6 })
  })

  it('starts the delays over once a connection has proven stable', () => {
    const grown = retryBackoffNext(retryBackoffNext(INITIAL_RETRY_BACKOFF))
    expect(grown.delayMs).toBe(2_000)
    expect(retryBackoffSettled()).toEqual(INITIAL_RETRY_BACKOFF)
  })
})
