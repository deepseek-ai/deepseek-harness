/** Owner choices and management reads constrain live external execution. */
import { Context } from '@deepseek-ai/cordis'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ShareAccessStateFrame, TunnelRegistrationToken, TunnelRequestToken, TunnelWorkerEvent } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { identityKeyOf } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import type {} from '../src/index.ts'
import { apply } from '../src/host/share-host.ts'
import { executeOneTool } from './tool-call.ts'
import type { TunnelWorkerInput } from '../src/host/tunnel-worker.ts'
import type { ForkEnforcementFs } from '../src/host/fork-enforcement.ts'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'

const worker = vi.hoisted(() => ({ listener: undefined as ((event: TunnelWorkerEvent) => void) | undefined,
  sent: [] as TunnelWorkerInput[] }))
vi.mock('../src/host/tunnel-worker.ts', () => ({ TunnelWorker: class {
  start() {}
  onEvent(listener: (event: TunnelWorkerEvent) => void) { worker.listener = listener; return () => {} }
  send(command: TunnelWorkerInput) { worker.sent.push(command) }
  stop() { worker.listener = undefined; return Promise.resolve() }
} }))
const alice = { providerId: 'mock', tenantId: 'tenant', subjectId: 'alice' }
const bob = { ...alice, subjectId: 'bob' }

async function fixture(mode: 'view' | 'write') {
  const directory = mkdtempSync(join(tmpdir(), 'liveshare-management-authority-'))
  const ctx = new Context()
  const opened = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const pending: Promise<unknown>[] = []
  const lifecycle: { stop?: () => Promise<void> } = {}
  onTestFinished(async () => {
    release.resolve(undefined)
    await Promise.allSettled(pending)
    await lifecycle.stop?.()
    await ctx.fiber.dispose()
    vi.unstubAllGlobals()
    rmSync(directory, { recursive: true, force: true })
  })
  worker.sent.length = 0
  const stateFile = join(directory, 'owner.json')
  writeFileSync(stateFile, JSON.stringify({ instanceId: 'owner', relayUrl: 'https://relay.test',
    shares: [{ relay: 'https://relay.test', shareId: 'share', sessionId: 'source',
      sessionTitle: 'Source', accessMode: 'selected', allowedSubjectIds: [identityKeyOf(alice), identityKeyOf(bob)],
      gatewayToken: 'token', createdAt: '2026-10-08T00:00:00Z', sessionMode: mode, allowsFork: mode !== 'view' }] }))
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const session = Session.create(SessionId('source'), [], { version: SESSION_FORMAT_VERSION,
    id: SessionId('source'), cwd: directory, createdAt: 0, isSeeded: false })
  const unsupported = (): never => { throw new Error('this fixture does not drive the Inbox') }
  const key: Omit<Agent, 'ctx'> = { id: session.id, session, status: 'running', options: {},
    model: { current: () => undefined, select: () => {} },
    inbox: { nextTurn: [], nextStep: [], clear: unsupported, append: unsupported, prepend: unsupported,
      replace: unsupported, remove: unsupported, splice: unsupported },
    send: unsupported, followup: unsupported, steer: unsupported, inject: unsupported,
    cancel: vi.fn(), whenIdle: () => Promise.resolve(), runMaintenance: task => task(new AbortController().signal) }
  let scope: Scope | undefined
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) }, { inject: ['tools', 'systemPrompt'] }))
  if (scope === undefined) throw new Error('source scope missing')
  const agent: Agent = Object.assign(key, { ctx: scope.ctx })
  const delegated = vi.fn(async () => 'file contents')
  for (const name of ['read', 'write']) ctx.effect(() => ctx.tools.register(defineTool({ name, description: 'Use a file',
    parameters: { file_path: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: delegated })))
  const root = { targetKey: FsTargetKey('root'), displayPath: directory }
  let holdOpen = false
  // A held read blocks while resolving its target, after admission and before the deployment's read runs.
  const fs: ForkEnforcementFs = {
    resolve: async () => {
      if (holdOpen) { opened.resolve(undefined); await release.promise }
      return root
    },
    contains: () => true, processPath: () => directory,
    writeText: async () => { throw new Error('writes not exercised here') },
    editText: async () => { throw new Error('edits not exercised here') } }
  ctx.provide('fs', fs as never)
  // The host derives each execution's turn from this maintained boundary, exactly as the Agents service serves it.
  ctx.provide('agents', { get: () => agent } as never)
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: directory }) } as never)
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const dispatched = vi.fn(async () => Response.json({ result: { ok: true, value: { accepted: true } } }))
  ctx.provide('connection', { fetch: { register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => {
    routes.set(route.path, route.fetch); return () => { routes.delete(route.path) }
  } }, createPeer: (options: ConstructorParameters<typeof Peer>[1]) => new Peer(ctx, options),
  createSharedFetchHandler: () => ({ fetch: dispatched }) } as never)
  let authority: ShareAccessStateFrame = { type: 'share-access-state', version: 1, accessMode: 'selected',
    allowedSubjectIds: [identityKeyOf(alice), identityKeyOf(bob)], sessionMode: 'write' }
  let reachable = true
  // A Relay built before the upload switch retired may still state it; the host must ignore the field.
  let legacyUploadSwitch: boolean | undefined
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    expect(new URL(request.url).origin).toBe('https://relay.test')
    if (request.url.endsWith('/owner-credential')) return Response.json({ supported: true })
    expect(new URL(request.url).pathname).toBe('/__liveshare/requests')
    expect(request.headers.get('authorization')).toBe('Bearer token')
    if (!reachable) return new Response('', { status: 410 })
    return Response.json({ ...authority, ...(legacyUploadSwitch === undefined ? {} : { allowsFileUpload: legacyUploadSwitch }),
      requests: [] })
  })
  lifecycle.stop = await apply(ctx, { ownerStateFile: stateFile })
  const registrationToken = randomUUID() as TunnelRegistrationToken
  const manage = async () => await ctx.liveshareShares.list()
  const snapshot = (state: ShareAccessStateFrame) => {
    authority = state
    worker.listener?.({ ...state, registrationToken, shareId: 'share' })
  }
  const prompt = async (readOnly = false) => {
    const token = randomUUID() as TunnelRequestToken
    worker.listener?.({ type: 'share-rpc-request', registrationToken, token, shareId: 'share', id: 1, actor: alice,
      body: { op: 'call', path: readOnly ? '/api/commands/list' : '/api/session/prompt',
        body: { type: 'client-request', rpcId: token,
          method: readOnly ? 'commands/list' : 'session/prompt',
          payload: readOnly ? { args: {} } : { args: { request: { sessionId: 'source', requestId: token,
            mode: 'queue', content: [{ type: 'text', text: 'viewer' }] } } } } } })
    await vi.waitFor(() => { expect(worker.sent.some(command => command.type === 'share-rpc-response' && command.token === token)).toBe(true) })
    return worker.sent.find(command => command.type === 'share-rpc-response' && command.token === token)
  }
  return { ctx, agent, stateFile, delegated, dispatched, opened: opened.promise, manage, snapshot, prompt,
    get authority() { return authority }, setAuthority: (state: ShareAccessStateFrame) => { authority = state },
    unavailable: () => { reachable = false },
    stateLegacyUploadSwitch: (value: boolean) => { legacyUploadSwitch = value },
    releaseOpen: () => { release.resolve(undefined) },
    startRead: (turn = 1) => { session.append('turn/start', { turn }); holdOpen = true; const reading = executeOneTool(ctx, { name: 'read',
      arguments: { file_path: join(directory, 'file') }, callId: ToolCallId(`external-read-${turn}`),
      agent, signal: new AbortController().signal }); pending.push(reading); return reading } }
}

it('keeps the Owner view choice below a writable Relay snapshot', async () => {
  const f = await fixture('view')
  f.snapshot(f.authority)
  await f.ctx.serial('agent/created', { agent: f.agent, source: 'startup' })
  expect(await f.manage()).toMatchObject({
    shares: [{ sessionMode: 'view', allowsFork: false }],
  })
  const persisted = JSON.parse(readFileSync(f.stateFile, 'utf8')) as { shares: Array<{ sessionMode: string }> }
  expect(persisted.shares[0]?.sessionMode).toBe('view')
  // Both tiers drive the shared Session, so the owner's own choice is what the reader receives.
  expect(await f.prompt()).toMatchObject({ status: 200 })
  expect(f.dispatched).toHaveBeenCalled()
})

it('returns a terminal denial when the Host first reads revocation from GET', async () => {
  const f = await fixture('view')
  expect(await f.prompt(true)).toMatchObject({ status: 200 })
  f.setAuthority({ ...f.authority, version: 2, allowedSubjectIds: [identityKeyOf(bob)] })
  expect(await f.prompt(true)).toMatchObject({ status: 403, body: { error: 'viewer-not-authorized' } })
  expect(f.dispatched).toHaveBeenCalledOnce()
})

it('does not persist a temporary Relay mode downgrade as the Owner choice', async () => {
  const f = await fixture('write')
  f.snapshot({ ...f.authority, version: 2, sessionMode: 'view' })
  await f.manage()
  const persisted = JSON.parse(readFileSync(f.stateFile, 'utf8')) as { shares: Array<{ sessionMode: string }> }
  expect(persisted.shares[0]?.sessionMode).toBe('write')
})

// An older Relay may still state the retired upload switch. The frame is accepted and the field is
// ignored: nothing reads it back, and the share row no longer has an upload decision to report.
it('ignores an upload switch an older Relay still states', async () => {
  const f = await fixture('write')
  f.stateLegacyUploadSwitch(true)
  const body = await f.manage()
  expect(body.shares[0]).toMatchObject({ sessionMode: 'write', allowsFork: true })
  expect(body.shares[0]).not.toHaveProperty('allowsFileUpload')
  const persisted = JSON.parse(readFileSync(f.stateFile, 'utf8')) as {
    readonly shares: ReadonlyArray<Record<string, unknown>>
  }
  expect(persisted.shares[0]).not.toHaveProperty('allowsFileUpload')
})
