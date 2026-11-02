import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { TunnelShareSpec, TunnelWorkerEvent } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { TunnelWorker } from '../src/host/tunnel-worker.ts'

const share: TunnelShareSpec = { shareId: 'share', sessionId: 'session', sessionTitle: 'session',
  accessMode: 'open', relay: 'http://relay.invalid', gatewayToken: 'token', ownerDisplayName: 'owner', allowedSubjectIds: [] }

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Liveshare tunnel worker transport environment', () => {
  it('spawns the worker with the transport settings the Host itself resolves and trusts', async () => {
    // The worker is a separate process: a Relay the Host reaches through a private CA or an explicit
    // proxy is only reachable to the worker when these settings travel with it.
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '/etc/liveshare/relay-ca.pem')
    vi.stubEnv('SSL_CERT_FILE', '/etc/liveshare/tls-ca.pem')
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.example.test:3128')
    vi.stubEnv('NO_PROXY', 'relay.internal.example.test')
    vi.stubEnv('HTTP_PROXY', '')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'liveshare-worker-env-')))
    const envFile = join(root, 'env.json')
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const script = `
      const { writeFileSync } = require('node:fs')
      writeFileSync(process.argv[1], JSON.stringify({
        extraCaCerts: process.env.NODE_EXTRA_CA_CERTS,
        sslCertFile: process.env.SSL_CERT_FILE,
        httpsProxy: process.env.HTTPS_PROXY,
        noProxy: process.env.NO_PROXY,
        emptyProxy: process.env.HTTP_PROXY,
        mode: process.env.LIVESHARE_TUNNEL_MODE,
        ipc: typeof process.send,
      }))
      process.send({ type: 'ready' })
      setInterval(() => {}, 1_000)
    `
    const worker = new TunnelWorker({ command: { executable: process.execPath, args: ['-e', script, envFile] } })
    onTestFinished(() => worker.stop())
    worker.onEvent(() => {})
    worker.send({ type: 'add-share', share })
    try {
      await expect.poll(() => {
        try {
          return readFileSync(envFile, 'utf8') !== ''
        } catch {
          return false
        }
      }, { timeout: 10_000 }).toBe(true)
      expect(JSON.parse(readFileSync(envFile, 'utf8'))).toEqual({
        extraCaCerts: '/etc/liveshare/relay-ca.pem',
        sslCertFile: '/etc/liveshare/tls-ca.pem',
        httpsProxy: 'http://proxy.example.test:3128',
        noProxy: 'relay.internal.example.test',
        mode: 'gateway',
        ipc: 'function',
      })
      // An empty variable is not forwarded as an empty value: the worker keeps its own default rather
      // than reading a blank proxy as configured.
      expect(JSON.parse(readFileSync(envFile, 'utf8'))).not.toHaveProperty('emptyProxy')
    } finally {
      await worker.stop()
    }
  })
})

describe('Liveshare tunnel worker lifecycle', () => {
  it('cancels Host requests before reporting worker exit and drops late responses', async () => {
    const events: TunnelWorkerEvent[] = []
    const script = `
      process.send({ type: 'ready' })
      process.on('message', command => {
        if (command.type === 'add-share') {
          process.send({ type: 'share-rpc-request', registrationToken: command.registrationToken, token: 'exited-request', shareId: 'share', id: 1,
            body: { op: 'read' }, actor: { providerId: 'mock', tenantId: 'tenant', subjectId: 'alice' } })
        } else process.exit(7)
      })
    `
    const worker = new TunnelWorker({ command: { executable: process.execPath, args: ['-e', script] } })
    onTestFinished(() => worker.stop())
    worker.onEvent((event) => { events.push(event) })
    worker.send({ type: 'add-share', share })
    try {
      await expect.poll(() => events.some(event => event.type === 'share-rpc-request')).toBe(true)
      const request = events.find(event => event.type === 'share-rpc-request')
      if (request?.type !== 'share-rpc-request') throw new Error('Request missing')
      worker.send({ type: 'remove-share', shareId: 'crash-marker' })
      await expect.poll(() => events.some(event => event.type === 'share-rpc-cancel')).toBe(true)
      expect(events.find(event => event.type === 'share-rpc-cancel')).toEqual({
        type: 'share-rpc-cancel', registrationToken: request.registrationToken, token: request.token, id: request.id, shareId: request.shareId,
      })
      await expect.poll(() => events.some(event => event.type === 'share-error')).toBe(true)
      expect(events.findIndex(event => event.type === 'share-rpc-cancel'))
        .toBeLessThan(events.findIndex(event => event.type === 'share-error'))
      worker.send({ type: 'share-rpc-response', token: request.token, shareId: request.shareId, id: request.id, status: 200 })
      await worker.stop()
      expect(events.filter(event => event.type === 'ready')).toHaveLength(1)
    } finally {
      await worker.stop()
    }
  })

  it('cancels Host requests once when stop disposes the worker', async () => {
    const events: TunnelWorkerEvent[] = []
    const script = `
      process.send({ type: 'ready' })
      process.on('message', command => {
        if (command.type === 'shutdown') process.exit(0)
        if (command.type === 'add-share') process.send({ type: 'share-rpc-request', registrationToken: command.registrationToken, token: 'stopped-request', shareId: 'share', id: 1,
          body: { op: 'read' }, actor: { providerId: 'mock', tenantId: 'tenant', subjectId: 'alice' } })
      })
    `
    const worker = new TunnelWorker({ command: { executable: process.execPath, args: ['-e', script] } })
    onTestFinished(() => worker.stop())
    worker.onEvent((event) => { events.push(event) })
    worker.send({ type: 'add-share', share })
    try {
      await expect.poll(() => events.some(event => event.type === 'share-rpc-request')).toBe(true)
      await worker.stop()
      expect(events.filter(event => event.type === 'share-rpc-cancel')).toEqual([
        { type: 'share-rpc-cancel', registrationToken: events.find(event => event.type === 'share-rpc-request')!.registrationToken, token: 'stopped-request', id: 1, shareId: 'share' },
      ])
      worker.start()
      await worker.stop()
      expect(events.filter(event => event.type === 'ready')).toHaveLength(1)
    } finally {
      await worker.stop()
    }
  })

  it('marks connected shares offline when the worker exits', async () => {
    const events: Array<{ type: string; shareId?: string }> = []
    const script = `
      process.send({ type: 'ready' })
      process.on('message', command => {
        if (command.type === 'shutdown') process.exit(0)
        if (command.type === 'add-share') {
          process.send({ type: 'share-connected', registrationToken: command.registrationToken, shareId: 'share-1' })
          setTimeout(() => process.exit(7), 10)
        }
      })
    `
    const worker = new TunnelWorker({
      command: { executable: process.execPath, args: ['-e', script] },
    })
    onTestFinished(() => worker.stop())
    worker.onEvent((event) => { events.push(event) })
    worker.send({ type: 'add-share', share: { ...share, shareId: 'share-1' } })

    await expect.poll(() => events.some(event => event.type === 'share-connected')).toBe(true)
    await expect.poll(() => events.some(event => event.type === 'share-error' && event.shareId === 'share-1')).toBe(true)
    await worker.stop()
  })

  it('keeps a share whose socket dropped expected until the worker itself exits', async () => {
    const events: Array<{ type: string; shareId?: string }> = []
    const script = `
      process.send({ type: 'ready' })
      process.on('message', command => {
        if (command.type === 'shutdown') process.exit(0)
        if (command.type === 'add-share') {
          process.send({ type: 'share-connected', registrationToken: command.registrationToken, shareId: 'share-2' })
          process.send({ type: 'share-closed', registrationToken: command.registrationToken, shareId: 'share-2' })
          setTimeout(() => process.exit(7), 10)
        }
      })
    `
    const worker = new TunnelWorker({
      command: { executable: process.execPath, args: ['-e', script] },
    })
    onTestFinished(() => worker.stop())
    worker.onEvent((event) => { events.push(event) })
    worker.send({ type: 'add-share', share: { ...share, shareId: 'share-2' } })

    await expect.poll(() => events.some(event => event.type === 'share-closed')).toBe(true)
    await expect.poll(() => events.some(event => event.type === 'share-error' && event.shareId === 'share-2')).toBe(true)
    await worker.stop()
  })
})
