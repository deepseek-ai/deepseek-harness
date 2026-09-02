import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision, type SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'
import { startHttpMcpFixture } from '../../../mcp/mcp-client/tests/http-fixture.ts'

/** Wrap a bare header as the snapshot shape `SessionPersistence.list` now returns. */
function snapshotOf(header: SessionHeader): SessionPersistenceSnapshot {
  return { header, revision: SessionPersistenceRevision(`test-${header.id}`) }
}

function oneToolCall(): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId('call-switch'), name: 'switch_model', argumentsDelta: '{}' },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: ToolCallId('call-switch'), name: 'switch_model', arguments: '{}' },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

describe('automation-only ACP bridge', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('advertises the standard automation controls without private metadata', async () => {
    harness = await makeBridgeHarness()
    const response = await harness.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { _meta: { terminal_output: true } },
    })

    expect(response).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
      agentCapabilities: {
        mcpCapabilities: { http: true },
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { close: {}, list: {}, resume: {} },
      },
      authMethods: [],
    })
  })

  it('advertises image prompts only with an exact capable route and attachment store', async () => {
    harness = await makeBridgeHarness({ imageCapable: true })
    const capable = await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    expect(capable.agentCapabilities?.promptCapabilities?.image).toBe(true)
    await harness.dispose()

    harness = await makeBridgeHarness({ imageCapable: true, attachments: false })
    const noStore = await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    expect(noStore.agentCapabilities?.promptCapabilities?.image).toBe(false)
  })

  it('negotiates an unsupported version and accepts the required no-op authentication call', async () => {
    harness = await makeBridgeHarness()
    const response = await harness.client.initialize({ protocolVersion: 0, clientCapabilities: {} })
    expect(response.protocolVersion).toBe(PROTOCOL_VERSION)
    await expect(harness.client.authenticate({ methodId: 'unused' })).resolves.toEqual({})
  })

  it('creates a session, emits one committed answer, and settles the prompt', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('hello there')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const result = await harness.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'say hello' }],
    })

    expect(result.stopReason).toBe('end_turn')
    await vi.waitFor(() => { expect(harness!.updates.at(-1)?.sessionUpdate).toBe('usage_update') })
    expect(harness.updates[0]).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello there' },
    })
    expect('messageId' in harness.updates[0]!).toBe(true)
    if ('messageId' in harness.updates[0]!) expect(typeof harness.updates[0].messageId).toBe('string')
    expect(harness.ctx.agents.get(SessionId(sessionId))?.session.header.cwd).toBe(process.cwd())
    expect(harness.adapter.requests[0]?.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'say hello' }])
  })

  it('closes one active session without affecting its neighbor', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const first = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const second = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await harness.client.closeSession({ sessionId: first.sessionId })

    expect(harness.ctx.agents.get(SessionId(first.sessionId))).toBeUndefined()
    expect(harness.ctx.agents.get(SessionId(second.sessionId))).toBeDefined()
    await expect(harness.client.prompt({
      sessionId: first.sessionId,
      prompt: [{ type: 'text', text: 'closed' }],
    })).rejects.toThrow(/unknown session/)
  })

  it('cancels a running prompt and makes its session resumable before close returns', async () => {
    harness = await makeBridgeHarness({ script: ['hang', textResponse('resumed')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const prompt = harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'hang' }] })
    await vi.waitFor(() => {
      expect(harness!.ctx.agents.get(SessionId(created.sessionId))?.status).toBe('running')
    })

    await harness.client.closeSession({ sessionId: created.sessionId })

    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
    await expect(harness.client.listSessions({})).resolves.toMatchObject({
      sessions: [{ sessionId: created.sessionId, cwd: process.cwd() }],
    })
    await harness.client.resumeSession({ sessionId: created.sessionId, cwd: process.cwd(), mcpServers: [] })
  })

  it('shares one close operation and rejects new work while close is draining', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const flushing: PromiseWithResolvers<void> = Promise.withResolvers()
    const flush = vi.spyOn(harness.ctx.sessions, 'flush').mockImplementationOnce(() => flushing.promise.then(() => true))

    const first = harness.client.closeSession({ sessionId: created.sessionId })
    await vi.waitFor(() => { expect(flush).toHaveBeenCalled() })
    const second = harness.client.closeSession({ sessionId: created.sessionId })
    harness.registerCatalogProvider('closing-topology')
    await expect(harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'too late' }],
    })).rejects.toThrow(/session is closing/)
    flushing.resolve()

    await expect(Promise.all([first, second])).resolves.toEqual([{}, {}])
  })

  it('disposes the Agent and reports an explicit close drain failure', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(created.sessionId))!
    vi.spyOn(agent, 'whenIdle').mockRejectedValueOnce(new Error('idle probe failed'))

    await expect(harness.client.closeSession({ sessionId: created.sessionId })).rejects.toThrow(/session close failed/)

    expect(harness.ctx.agents.get(SessionId(created.sessionId))).toBeUndefined()
  })

  it('resumes a closed persisted session without replaying its history', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('first answer'), textResponse('second answer')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'first prompt' }] })
    await harness.client.closeSession({ sessionId: created.sessionId })
    const updatesBeforeResume = harness.updates.length

    const statSpy = vi.spyOn(harness.ctx.sessionPersistence, 'stat')
    const listSpy = vi.spyOn(harness.ctx.sessionPersistence, 'list')
    const resumed = await harness.client.resumeSession({
      sessionId: created.sessionId,
      cwd: process.cwd(),
      mcpServers: [],
    })
    // Resume authorizes one known id through a point stat, never a corpus scan.
    expect(statSpy).toHaveBeenCalledWith(SessionId(created.sessionId), expect.anything())
    expect(listSpy).not.toHaveBeenCalled()
    expect(Array.isArray(resumed.configOptions)).toBe(true)
    expect(harness.updates).toHaveLength(updatesBeforeResume)
    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'second prompt' }] })

    expect(harness.adapter.requests[1]?.messages.map(message => message.content)).toContainEqual([
      { type: 'text', text: 'first prompt' },
    ])
  })

  it('materializes an empty closed session for list and resume', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await harness.client.closeSession({ sessionId: created.sessionId })

    await expect(harness.client.listSessions({})).resolves.toEqual({
      sessions: [{ sessionId: created.sessionId, cwd: process.cwd() }],
    })
    await expect(harness.client.resumeSession({ sessionId: created.sessionId, cwd: process.cwd() }))
      .resolves.toHaveProperty('configOptions')
  })

  it('rejects active or wrong-workspace resume before composing another Agent', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('persisted')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await expect(harness.client.resumeSession({
      sessionId: created.sessionId,
      cwd: process.cwd(),
      mcpServers: [],
    })).rejects.toThrow(/already active/)
    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'persist' }] })
    await harness.client.closeSession({ sessionId: created.sessionId })
    const resume = vi.spyOn(harness.ctx.agents, 'resume')

    await expect(harness.client.resumeSession({
      sessionId: created.sessionId,
      cwd: tmpdir(),
      mcpServers: [],
    })).rejects.toThrow(/cwd does not match/)
    expect(resume).not.toHaveBeenCalled()

    await expect(harness.client.resumeSession({
      sessionId: created.sessionId,
      cwd: `${process.cwd()}/packages/..`,
      mcpServers: [],
    })).resolves.toHaveProperty('configOptions')
  })

  it('reserves a persisted id across concurrent resume admission', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('persisted')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'persist' }] })
    await harness.client.closeSession({ sessionId: created.sessionId })
    const resume = harness.ctx.agents.resume.bind(harness.ctx.agents)
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const release: PromiseWithResolvers<void> = Promise.withResolvers()
    vi.spyOn(harness.ctx.agents, 'resume').mockImplementationOnce(async (options) => {
      entered.resolve()
      await release.promise
      return resume(options)
    })

    const first = harness.client.resumeSession({ sessionId: created.sessionId, cwd: process.cwd() })
    await entered.promise
    await expect(harness.client.resumeSession({ sessionId: created.sessionId, cwd: process.cwd() }))
      .rejects.toThrow(/already active/)
    await expect(harness.client.listSessions({})).resolves.toEqual({ sessions: [] })
    release.resolve()

    await expect(first).resolves.toHaveProperty('configOptions')
  })

  it('excludes a globally live session owned outside this ACP bridge', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const sessionId = SessionId('other-frontend-live')
    harness.ctx.sessions.create(sessionId, { meta: { cwd: process.cwd() } })
    vi.spyOn(harness.ctx.sessionPersistence, 'list').mockResolvedValue([snapshotOf({
      version: 0,
      id: sessionId,
      createdAt: 1,
      isSeeded: false,
      cwd: process.cwd(),
    })])
    const resume = vi.spyOn(harness.ctx.agents, 'resume')

    await expect(harness.client.listSessions({})).resolves.toEqual({ sessions: [] })
    await expect(harness.client.resumeSession({
      sessionId,
      cwd: process.cwd(),
      mcpServers: [],
    })).rejects.toThrow(/already active/)
    expect(resume).not.toHaveBeenCalled()
  })

  it('rejects unknown resume ids and rolls back invalid resume MCP', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('persisted')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await expect(harness.client.resumeSession({
      sessionId: 'missing',
      cwd: process.cwd(),
    })).rejects.toThrow(/not resumable/)
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'persist' }] })
    await harness.client.closeSession({ sessionId: created.sessionId })
    const duplicate = { name: 'same', command: process.execPath, args: [], env: [] }

    await expect(harness.client.resumeSession({
      sessionId: created.sessionId,
      cwd: process.cwd(),
      mcpServers: [duplicate, duplicate],
    })).rejects.toThrow(/duplicate normalized name/)
    expect(harness.ctx.agents.list()).toHaveLength(0)
  })

  it('restores the deployment selection when persisted events have no request header', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(created.sessionId))!
    agent.session.append('session/title', { title: 'materialized', messageSeqs: [], source: { kind: 'fallback' } })
    await harness.client.closeSession({ sessionId: created.sessionId })

    const resumed = await harness.client.resumeSession({ sessionId: created.sessionId, cwd: process.cwd() })

    expect(resumed.configOptions?.find(option => option.id === 'model')).toMatchObject({
      currentValue: '["mock","mock"]',
    })
  })

  it('restores an explicitly selected reasoning effort', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('persisted')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'reasoning_effort',
      value: 'low',
    })
    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'persist' }] })
    await harness.client.closeSession({ sessionId: created.sessionId })

    const resumed = await harness.client.resumeSession({ sessionId: created.sessionId, cwd: process.cwd() })

    expect(resumed.configOptions?.find(option => option.id === 'reasoning_effort')).toMatchObject({
      currentValue: 'low',
    })
  })

  it('lists closed persisted sessions without presentation metadata', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('answer')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'persist me' }] })
    await harness.client.closeSession({ sessionId: created.sessionId })

    await expect(harness.client.listSessions({})).resolves.toEqual({
      sessions: [{ sessionId: created.sessionId, cwd: process.cwd() }],
    })
  })

  it('paginates resumable sessions with an opaque deterministic cursor', async () => {
    harness = await makeBridgeHarness({
      config: { sessionListPageSize: 1 },
      script: [textResponse('first'), textResponse('second')],
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const first = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId: first.sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await harness.client.closeSession({ sessionId: first.sessionId })
    const second = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId: second.sessionId, prompt: [{ type: 'text', text: 'second' }] })
    await harness.client.closeSession({ sessionId: second.sessionId })

    const firstPage = await harness.client.listSessions({})
    expect(firstPage.sessions).toHaveLength(1)
    expect(firstPage.nextCursor).toEqual(expect.any(String))
    if (typeof firstPage.nextCursor !== 'string') throw new Error('expected a pagination cursor')
    const secondPage = await harness.client.listSessions({ cursor: firstPage.nextCursor })
    expect(secondPage.sessions).toHaveLength(1)
    expect(secondPage.nextCursor).toBeUndefined()
    expect(new Set([...firstPage.sessions, ...secondPage.sessions].map(item => item.sessionId)))
      .toEqual(new Set([first.sessionId, second.sessionId]))
    await expect(harness.client.listSessions({ cursor: 'not-a-cursor' })).rejects.toThrow(/cursor is invalid/)
  })

  it('filters non-resumable headers and canonical missing workspaces', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const active = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const persistence = harness.ctx.get('sessionPersistence')!
    vi.spyOn(persistence, 'list').mockResolvedValue(([
      { version: 0, id: SessionId(active.sessionId), createdAt: 9, isSeeded: false, cwd: process.cwd() },
      { version: 0, id: SessionId('subagent'), createdAt: 8, isSeeded: false, cwd: '/missing/filter', origin: 'subagent' },
      { version: 0, id: SessionId('fork'), createdAt: 7, isSeeded: false, cwd: '/missing/filter', parentSession: SessionId('parent') },
      { version: 0, id: SessionId('no-cwd'), createdAt: 6, isSeeded: false },
      { version: 0, id: SessionId('relative'), createdAt: 5, isSeeded: false, cwd: 'relative' },
      { version: 0, id: SessionId('other'), createdAt: 4, isSeeded: false, cwd: '/missing/other' },
      { version: 0, id: SessionId('valid-b'), createdAt: 3, isSeeded: false, cwd: '/missing/filter' },
      { version: 0, id: SessionId('valid-a'), createdAt: 3, isSeeded: false, cwd: '/missing/filter' },
    ] satisfies SessionHeader[]).map(snapshotOf))
    // Resume authorizes through a point stat, not the list scan mocked above.
    vi.spyOn(persistence, 'stat').mockImplementation(async id => (id === SessionId('no-cwd')
      ? snapshotOf({ version: 0, id: SessionId('no-cwd'), createdAt: 6, isSeeded: false })
      : undefined))

    await expect(harness.client.listSessions({ cwd: 'relative' })).rejects.toThrow(/absolute path/)
    await expect(harness.client.listSessions({ cwd: '/missing/filter' })).resolves.toEqual({
      sessions: [
        { sessionId: 'valid-a', cwd: '/missing/filter' },
        { sessionId: 'valid-b', cwd: '/missing/filter' },
      ],
    })
    await expect(harness.client.resumeSession({
      sessionId: 'no-cwd',
      cwd: '/missing/filter',
    })).rejects.toThrow(/cwd does not match/)
  })

  it.each([
    [null],
    [[]],
    [['not-a-number', 'id']],
    [[-1, 'id']],
    [[1, '']],
  ] as const)('rejects malformed decoded list cursors %#', async (decoded) => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const cursor = Buffer.from(JSON.stringify(decoded)).toString('base64url')
    await expect(harness.client.listSessions({ cursor })).rejects.toThrow(/cursor is invalid/)
  })

  it('rejects invalid and non-canonical cursor encodings', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await expect(harness.client.listSessions({ cursor: '*' })).rejects.toThrow(/cursor is invalid/)
    const bytes = Buffer.from(JSON.stringify([1, 'id']))
    const canonical = bytes.toString('base64url')
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const nonCanonical = alphabet.split('')
      .map(char => canonical.slice(0, -1) + char)
      .find(candidate => candidate !== canonical && Buffer.from(candidate, 'base64url').equals(bytes))
    if (nonCanonical === undefined) throw new Error('expected an alternate base64url spelling')

    await expect(harness.client.listSessions({ cursor: nonCanonical })).rejects.toThrow(/cursor is invalid/)
  })

  it('rolls back new and resume when configuration discovery fails', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('persisted')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const resolve = vi.spyOn(harness.ctx.llm, 'resolveCallConfig')
    resolve.mockRejectedValueOnce(new Error('catalog resolution failed'))
    await expect(harness.client.newSession({ cwd: process.cwd(), mcpServers: [] }))
      .rejects.toThrow(/Internal error/)
    expect(harness.ctx.agents.list()).toHaveLength(0)
    // The loop seeds the log through its write handle before activation fails,
    // so the rolled-back session's durable log remains; only the live agent and
    // the bridge record are rolled back.
    await expect(harness.ctx.sessionPersistence.list()).resolves.toHaveLength(1)

    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'persist' }] })
    await harness.client.closeSession({ sessionId: created.sessionId })
    resolve.mockRejectedValueOnce(new Error('resume catalog failed'))
    await expect(harness.client.resumeSession({ sessionId: created.sessionId, cwd: process.cwd() }))
      .rejects.toThrow(/Internal error/)
    expect(harness.ctx.agents.list()).toHaveLength(0)
  })

  it('propagates non-MCP Agent factory failures and non-config selection failures', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('persisted')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const create = vi.spyOn(harness.ctx.agents, 'create')
    create.mockRejectedValueOnce(new Error('factory create failed'))
    await expect(harness.client.newSession({ cwd: process.cwd(), mcpServers: [] }))
      .rejects.toThrow(/Internal error/)

    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const model = created.configOptions?.find(option => option.id === 'model')
    if (model?.type !== 'select') throw new Error('expected model options')
    const plain = model.options.flatMap(option => 'group' in option ? option.options : [option])
      .find(option => option.name === 'Mock Plain')
    if (plain === undefined) throw new Error('expected plain model')
    const resolution = vi.spyOn(harness.ctx.llm, 'resolveCallConfig').mockRejectedValue(new Error('selection failed'))
    await expect(harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'model',
      value: plain.value,
    })).rejects.toThrow(/Internal error/)
    resolution.mockRestore()

    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'persist' }] })
    await harness.client.closeSession({ sessionId: created.sessionId })
    vi.spyOn(harness.ctx.agents, 'resume').mockRejectedValueOnce(new Error('factory resume failed'))
    await expect(harness.client.resumeSession({ sessionId: created.sessionId, cwd: process.cwd() }))
      .rejects.toThrow(/Internal error/)
  })

  it('lists and resumes persisted sessions after an equivalent process restart', async () => {
    const persistenceRoot = await mkdtemp(join(tmpdir(), 'dsh-acp-restart-'))
    try {
      harness = await makeBridgeHarness({ persistenceRoot, script: [textResponse('before restart')] })
      await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
      await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'first' }] })
      await harness.client.closeSession({ sessionId: created.sessionId })
      await harness.dispose()

      harness = await makeBridgeHarness({ persistenceRoot, script: [textResponse('after restart')] })
      await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      await expect(harness.client.listSessions({})).resolves.toEqual({
        sessions: [{ sessionId: created.sessionId, cwd: process.cwd() }],
      })
      await harness.client.resumeSession({ sessionId: created.sessionId, cwd: process.cwd(), mcpServers: [] })
      await expect(harness.client.prompt({
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'second' }],
      })).resolves.toEqual({ stopReason: 'end_turn' })
    } finally {
      await harness?.dispose()
      harness = undefined
      await rm(persistenceRoot, { recursive: true, force: true })
    }
  })

  it('discovers and selects a session model through standard config options', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('plain answer')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const model = created.configOptions?.find(option => option.id === 'model')
    if (model?.type !== 'select') throw new Error('expected a model select option')
    const choices = model.options.flatMap(option => 'group' in option ? option.options : [option])
    const plain = choices.find(option => option.name === 'Mock Plain')
    if (plain === undefined) throw new Error('expected Mock Plain in the model catalog')

    const selected = await harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'model',
      value: plain.value,
    })
    expect(selected.configOptions.find(option => option.id === 'reasoning_effort')).toBeUndefined()
    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'use plain' }] })

    expect(harness.adapter.requests[0]).toMatchObject({ provider: 'mock', model: 'plain' })
  })

  it('publishes complete config options when adapter topology changes', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    harness.registerCatalogProvider('other')

    await vi.waitFor(() => {
      const update = harness!.updates.find(item => item.sessionUpdate === 'config_option_update')
      expect(update).toBeDefined()
      if (update?.sessionUpdate !== 'config_option_update') return
      const model = update.configOptions.find(option => option.id === 'model')
      if (model?.type !== 'select') throw new Error('expected a model select option')
      expect(model.options.some(option => 'group' in option && option.group === 'other')).toBe(true)
    })
    expect(harness.sessionUpdates.at(-1)?.sessionId).toBe(created.sessionId)
  })

  it('does not let hung topology discovery block prompt completion or close', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('still responsive')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const original = harness.ctx.llm.listModels.bind(harness.ctx.llm)
    const blocked = Promise.withResolvers<Awaited<ReturnType<typeof original>>>()
    const listModels = vi.spyOn(harness.ctx.llm, 'listModels').mockImplementation((provider: string) => (
      provider === 'hung' ? blocked.promise : original(provider)
    ))

    try {
      harness.registerCatalogProvider('hung')
      await vi.waitFor(() => { expect(listModels).toHaveBeenCalledWith('hung') })
      await expect(harness.client.prompt({
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'continue while discovery is pending' }],
      })).resolves.toEqual({ stopReason: 'end_turn' })
      await expect(harness.client.closeSession({ sessionId: created.sessionId })).resolves.toEqual({})
    } finally {
      blocked.resolve([])
      listModels.mockRestore()
    }
  })

  it('publishes recoverable options when the selected adapter disappears', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    harness.registerCatalogProvider('other')
    await vi.waitFor(() => {
      expect(harness!.updates.some(update => update.sessionUpdate === 'config_option_update')).toBe(true)
    })

    harness.replacePrimaryProviders([])
    expect(harness.ctx.llm.listProviders().map(provider => provider.id)).toEqual(['other'])

    await vi.waitFor(() => {
      const configUpdates = harness!.updates.filter(item => item.sessionUpdate === 'config_option_update')
      expect(configUpdates).toHaveLength(2)
      const update = configUpdates.at(-1)
      if (update?.sessionUpdate !== 'config_option_update') throw new Error('expected config update')
      const model = update.configOptions.find(option => option.id === 'model')
      if (model?.type !== 'select') throw new Error('expected model options')
      const groups = model.options.filter(option => 'group' in option)
      expect(groups.map(group => group.group)).toEqual(['other', 'mock'])
      expect(model.currentValue).toBe('["mock","mock"]')
    })
    expect(harness.sessionUpdates.at(-1)?.sessionId).toBe(created.sessionId)
  })

  it('selects an advertised reasoning effort for the next turn', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('reasoned')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const reasoning = created.configOptions?.find(option => option.id === 'reasoning_effort')
    if (reasoning?.type !== 'select') throw new Error('expected a reasoning select option')
    const low = reasoning.options.find(option => !('group' in option) && option.name === 'Low')
    if (low === undefined || 'group' in low) throw new Error('expected Low reasoning effort')

    await harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'reasoning_effort',
      value: low.value,
    })
    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'reason' }] })

    expect(harness.adapter.requests[0]?.reasoningEffort).toBe('low')
  })

  it('rejects unknown config choices without changing the selected route', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('unchanged')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await expect(harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'model',
      value: 'not-advertised',
    })).rejects.toThrow(/unknown model option/)
    await expect(harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'private_option',
      value: 'anything',
    })).rejects.toThrow(/unknown session config option/)
    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'go' }] })

    expect(harness.adapter.requests[0]).toMatchObject({ provider: 'mock', model: 'mock' })
  })

  it('serializes concurrent standard config changes in receive order', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('plain')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const model = created.configOptions?.find(option => option.id === 'model')
    const reasoning = created.configOptions?.find(option => option.id === 'reasoning_effort')
    if (model?.type !== 'select' || reasoning?.type !== 'select') throw new Error('expected model and reasoning options')
    const plain = model.options.flatMap(option => 'group' in option ? option.options : [option])
      .find(option => option.name === 'Mock Plain')
    const low = reasoning.options.find(option => !('group' in option) && option.name === 'Low')
    if (plain === undefined || low === undefined || 'group' in low) throw new Error('expected selectable values')

    await Promise.all([
      harness.client.setSessionConfigOption({
        sessionId: created.sessionId,
        configId: 'reasoning_effort',
        value: low.value,
      }),
      harness.client.setSessionConfigOption({
        sessionId: created.sessionId,
        configId: 'model',
        value: plain.value,
      }),
    ])
    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'go' }] })

    expect(harness.adapter.requests[0]).toMatchObject({ provider: 'mock', model: 'plain' })
    expect(harness.adapter.requests[0]?.reasoningEffort).toBeUndefined()
  })

  it('pins image admission and request routing to one prompt selection', async () => {
    harness = await makeBridgeHarness({ imageCapable: true, script: [textResponse('image accepted')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const model = created.configOptions?.find(option => option.id === 'model')
    if (model?.type !== 'select') throw new Error('expected a model option')
    const plain = model.options.flatMap(option => 'group' in option ? option.options : [option])
      .find(option => option.name === 'Mock Plain')
    if (plain === undefined) throw new Error('expected Mock Plain')
    const validationStarted = Promise.withResolvers<undefined>()
    const releaseValidation = Promise.withResolvers<undefined>()
    harness.attachments!.beforeValidate = () => {
      validationStarted.resolve(undefined)
      return releaseValidation.promise
    }

    const prompt = harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }],
    })
    await validationStarted.promise
    await harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'model',
      value: plain.value,
    })
    releaseValidation.resolve(undefined)
    await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' })

    expect(harness.adapter.requests[0]).toMatchObject({ provider: 'mock', model: 'mock' })
    harness.attachments!.beforeValidate = undefined
    await expect(harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'image', data: 'Ag==', mimeType: 'image/png' }],
    })).rejects.toThrow(/does not declare image input/)
  })

  it('applies a mid-turn model change to the following turn', async () => {
    harness = await makeBridgeHarness({ script: [oneToolCall(), textResponse('first turn'), textResponse('second turn')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const model = created.configOptions?.find(option => option.id === 'model')
    if (model?.type !== 'select') throw new Error('expected a model select option')
    const choices = model.options.flatMap(option => 'group' in option ? option.options : [option])
    const plain = choices.find(option => option.name === 'Mock Plain')
    if (plain === undefined) throw new Error('expected Mock Plain in the model catalog')
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'switch_model',
      description: 'Switch the following turn to the plain model.',
      parameters: {},
      execute: async () => {
        await harness!.client.setSessionConfigOption({
          sessionId: created.sessionId,
          configId: 'model',
          value: plain.value,
        })
        return [{ type: 'text', text: 'selected' }]
      },
    }))

    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'second' }] })

    expect(harness.adapter.requests.map(request => request.model)).toEqual(['mock', 'mock', 'plain'])
  })

  it('mounts a standard stdio MCP server inside the created session', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('used MCP')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const fixtureServer = fileURLToPath(new URL('../../../mcp/mcp-client/tests/fixture-server.ts', import.meta.url))
    const created = await harness.client.newSession({
      cwd: process.cwd(),
      mcpServers: [{ name: 'fixture', command: process.execPath, args: [fixtureServer], env: [] }],
    })

    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'use MCP' }] })

    expect(harness.adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('mcp__fixture__add')
    await harness.client.closeSession({ sessionId: created.sessionId })
  }, 30_000)

  it('mounts a standard Streamable HTTP MCP server with request headers', async () => {
    const fixture = await startHttpMcpFixture()
    try {
      harness = await makeBridgeHarness({ script: [textResponse('used HTTP MCP')] })
      await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      const created = await harness.client.newSession({
        cwd: process.cwd(),
        mcpServers: [{
          type: 'http',
          name: 'web',
          url: fixture.url,
          headers: [{ name: 'Authorization', value: 'Bearer acp-test' }],
        }],
      })

      await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'use HTTP MCP' }] })

      expect(harness.adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('mcp__web__ping')
      expect(fixture.authorization).toContain('Bearer acp-test')
      await harness.client.closeSession({ sessionId: created.sessionId })
    } finally {
      await fixture.close()
    }
  }, 30_000)

  it('allows the same MCP server namespace in independent sessions', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const fixtureServer = fileURLToPath(new URL('../../../mcp/mcp-client/tests/fixture-server.ts', import.meta.url))
    const mcpServers = [{ name: 'fixture', command: process.execPath, args: [fixtureServer], env: [] }]

    const first = await harness.client.newSession({ cwd: process.cwd(), mcpServers })
    const second = await harness.client.newSession({ cwd: process.cwd(), mcpServers })

    await Promise.all([
      harness.client.closeSession({ sessionId: first.sessionId }),
      harness.client.closeSession({ sessionId: second.sessionId }),
    ])
  }, 30_000)

  it('validates standard MCP declarations before publishing an Agent', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const stdio = { name: 'fixture', command: process.execPath, args: [], env: [] }
    const invalidLists = [
      [stdio, stdio],
      [{ ...stdio, name: '   ' }],
      [{ ...stdio, command: 'node' }],
      [{ ...stdio, env: [{ name: 'BAD=NAME', value: 'x' }] }],
      [{ type: 'http' as const, name: 'web', url: 'file:///tmp/mcp', headers: [] }],
      [{ type: 'http' as const, name: 'web', url: 'https://example.test/mcp', headers: [{ name: 'bad header', value: 'x' }] }],
      [{ type: 'sse' as const, name: 'legacy', url: 'https://example.test/sse', headers: [] }],
      [{ type: 'acp' as const, name: 'nested', serverId: 'server-1' }],
    ]
    for (const mcpServers of invalidLists) {
      await expect(harness.client.newSession({
        cwd: process.cwd(),
        mcpServers,
      })).rejects.toThrow(/mcpServers/)
      expect(harness.ctx.agents.list()).toHaveLength(0)
    }
  })

  it('reconnects requested MCP servers when resuming a closed session', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('first'), textResponse('second')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const fixtureServer = fileURLToPath(new URL('../../../mcp/mcp-client/tests/fixture-server.ts', import.meta.url))
    const mcpServers = [{ name: 'fixture', command: process.execPath, args: [fixtureServer], env: [] }]
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers })
    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await harness.client.closeSession({ sessionId: created.sessionId })

    await harness.client.resumeSession({ sessionId: created.sessionId, cwd: process.cwd(), mcpServers })
    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'second' }] })

    expect(harness.adapter.requests[1]?.tools?.map(tool => tool.name)).toContain('mcp__fixture__add')
  }, 30_000)

  it('leaves absent agent targets for request listeners to supply', async () => {
    harness = await makeBridgeHarness({ config: { provider: undefined, model: undefined } })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    expect(harness.ctx.agents.get(SessionId(sessionId))?.options).toEqual({})
  })

  it('allows request listeners to supply a route when ACP has no initial selection', async () => {
    harness = await makeBridgeHarness({
      config: { provider: undefined, model: undefined },
      script: [textResponse('listener-routed')],
    })
    harness.ctx.on('agent/request', async (_payload, next) => ({
      ...await next(),
      provider: 'mock',
      model: 'mock',
    }))
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    expect(created.configOptions).toEqual([])
    await expect(harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'route me' }],
    })).resolves.toEqual({ stopReason: 'end_turn' })
    expect(harness.adapter.requests[0]).toMatchObject({ provider: 'mock', model: 'mock' })
  })

  it('concatenates text blocks without exposing protocol framing to the model', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('done')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({
      sessionId,
      prompt: [
        { type: 'text', text: 'first' },
        { type: 'text', text: ' second' },
      ],
    })

    expect(harness.adapter.requests[0]?.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'first second' }])
  })

  it('admits mixed text/image prompts in wire order and logs references only', async () => {
    harness = await makeBridgeHarness({ imageCapable: true, script: [textResponse('done')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const resolve = vi.spyOn(harness.ctx.llm, 'resolveModelInfo')
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await harness.client.prompt({
      sessionId,
      prompt: [
        { type: 'text', text: 'before' },
        { type: 'image', data: 'AQ==', mimeType: 'image/png' },
        { type: 'text', text: 'between' },
        { type: 'image', data: 'Ag==', mimeType: 'image/jpeg' },
        { type: 'text', text: 'after' },
      ],
    })

    expect(resolve).toHaveBeenCalledWith('mock', 'mock', expect.any(AbortSignal))
    expect(harness.attachments?.saved.map(input => [...input.data])).toEqual([[1], [2]])
    const requestContent = harness.adapter.requests[0]?.messages.at(-1)?.content
    expect(requestContent?.map(block => block.type)).toEqual(['text', 'image', 'text', 'image', 'text'])
    expect(requestContent?.[0]).toEqual({ type: 'text', text: 'before' })
    expect(requestContent?.[2]).toEqual({ type: 'text', text: 'between' })
    expect(requestContent?.[4]).toEqual({ type: 'text', text: 'after' })
    const firstImage = requestContent?.[1]
    const secondImage = requestContent?.[3]
    if (firstImage?.type !== 'image' || secondImage?.type !== 'image') throw new Error('expected ordered image blocks')
    expect(firstImage.attachment.mediaType).toBe('image/png')
    expect(firstImage.attachment.bytes).toBe(1)
    expect(secondImage.attachment.mediaType).toBe('image/jpeg')
    expect(secondImage.attachment.bytes).toBe(1)
    const agent = harness.ctx.agents.get(SessionId(sessionId))
    expect(JSON.stringify(agent?.session.snapshotEvents())).not.toContain('AQ==')
  })

  it('rejects a malformed image batch atomically and frees the prompt slot', async () => {
    harness = await makeBridgeHarness({ imageCapable: true, script: [textResponse('recovered')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await expect(harness.client.prompt({
      sessionId,
      prompt: [
        { type: 'image', data: 'AQ==', mimeType: 'image/png' },
        { type: 'image', data: 'not base64', mimeType: 'image/png' },
      ],
    })).rejects.toThrow(/canonical base64/)
    expect(harness.attachments?.saved).toEqual([])

    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'retry' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
  })

  it('reports durable image write failures as internal prompt failures', async () => {
    harness = await makeBridgeHarness({ imageCapable: true })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    vi.spyOn(harness.attachments!, 'saveImages').mockRejectedValueOnce(
      new AttachmentError('disk failed', 'ATTACHMENT_WRITE_FAILED'),
    )

    await expect(harness.client.prompt({
      sessionId,
      prompt: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }],
    })).rejects.toThrow(/unable to persist the prompt image batch/)
  })

  it('renders the deployment persona for an ACP-created agent', async () => {
    harness = await makeBridgeHarness({ persona: 'Automation persona for {{model}} in {{cwd}}.', script: [textResponse('ok')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    expect(harness.adapter.requests[0]?.system).toContain(`Automation persona for mock in ${process.cwd()}.`)
  })

  it('requires one absolute primary workspace', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })

    await expect(harness.client.newSession({ cwd: 'relative', mcpServers: [] })).rejects.toThrow(/absolute path/)
    await expect(harness.client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      additionalDirectories: ['/tmp/other'],
    })).rejects.toThrow(/additionalDirectories/)
    await expect(harness.client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      additionalDirectories: [],
    })).resolves.toHaveProperty('sessionId')
  })

  it('rejects empty and unadvertised image prompts before a turn starts', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: '  ' }] }))
      .rejects.toThrow(/empty prompt/)
    await expect(harness.client.prompt({
      sessionId,
      prompt: [{ type: 'image', data: '', mimeType: 'image/png' }],
    })).rejects.toThrow(/inline image prompts were not advertised/)
    expect(harness.ctx.agents.get(SessionId(sessionId))?.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
  })

  it('renders baseline resource links as textual references in the user message', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('done')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({
      sessionId,
      prompt: [
        { type: 'text', text: 'summarize' },
        { type: 'resource_link', name: 'notes.txt', uri: 'file:///tmp/notes.txt' },
      ],
    })
    expect(harness.adapter.requests[0]?.messages.at(-1)?.content).toEqual([{
      type: 'text',
      text: 'summarize\n[resource_link name="notes.txt" uri="file:///tmp/notes.txt"]\n',
    }])
  })

  it('rejects prompts for unknown sessions and ignores unknown cancellation', async () => {
    harness = await makeBridgeHarness()
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await expect(harness.client.prompt({ sessionId: 'missing', prompt: [{ type: 'text', text: 'go' }] }))
      .rejects.toThrow(/unknown session/)
    await expect(harness.client.cancel({ sessionId: 'missing' })).resolves.toBeUndefined()
  })
})
