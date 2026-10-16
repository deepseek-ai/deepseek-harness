/** Real Loader, AgentLoop and helper-process transport; only desktop and model responses are fixtures. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { z } from 'zod'
import * as NativeProvider from '../src/index.ts'
import { createCuaApi } from '@deepseek-ai/dsh-cua/api'
import { installNativeFixture, startFixtureHost } from './native-fixture.ts'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
const calls = [
  { method: 'getCapabilities', params: {} },
  { method: 'getApp', params: { selector: 'test.fixture' } },
  { method: 'getState', params: { appHandle: 'fixture-app', windowId: 7 } },
  { method: 'click', params: { appHandle: 'fixture-app', snapshotId: 'fixture-snapshot-1', elementIndex: 0 } },
  { method: 'getState', params: { appHandle: 'fixture-app', windowId: 7 } },
  { method: 'screenshot', params: { appHandle: 'fixture-app', windowId: 7 } },
]

class VisualModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const operation = calls[this.requests.length]
    this.requests.push(options)
    if (operation) {
      const call = { type: 'tool-call' as const, id: ToolCallId(`native-${this.requests.length}`), name: 'cua', arguments: JSON.stringify(operation) }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: call }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Observed Count: 1 in the fixture window.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const AuditEvent = z.object({
  event: z.string(), pid: z.number(), method: z.string().optional(), count: z.number().optional(),
  requestId: z.string().optional(), params: z.record(z.string(), z.json()).optional(),
})

// The fixture uses a POSIX executable shebang; stream/protocol unit tests run on every host.
it.skipIf(process.platform === 'win32')('shares one application between retained Agent objects while isolating native handles and releasing each connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-composition-'))
  const context = new Context()
  const fixture: { close?: () => Promise<void> } = {}
  onTestFinished(async () => {
    try { await context.fiber.dispose() } finally {
      try { await fixture.close?.() } finally { await rm(root, { recursive: true, force: true }) }
    }
  })
  const helperPath = await installNativeFixture(root)
  fixture.close = await startFixtureHost(helperPath)
  await writeFile(join(root, 'observe-helper'), '')
  const readEvents = async () => (await readFile(join(root, 'helper-events.jsonl'), 'utf8')).trim().split('\n').map(line => AuditEvent.parse(JSON.parse(line)))
  const modules = {
    llm: LlmRuntime, session: SessionStore, projection: SessionProjectionRegistry,
    systemPrompt: SystemPrompt, tools: ToolRuntime, agents: AgentRegistry, agentLoop: AgentLoop,
    attachments: LocalAttachmentStore, computerUse: ComputerUseRegistry, subprocess: SubprocessLocal,
    cua: NativeProvider,
  }
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, Object.keys(modules).flatMap(name => [
    `- name: 'cordis:${name}'`,
    ...name === 'attachments' ? ['  config:', `    dshHome: ${JSON.stringify(root)}`] : [],
    ...name === 'cua' ? ['  config:', `    helperPath: ${JSON.stringify(helperPath)}`, '    allowedApps: [{"id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "name": "Fixture", "executablePath": "/fixture/app"}]'] : [],
  ]).join('\n') + '\n')
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  Object.assign(context.loader.builtins, modules, { include: Include })
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  for (const entry of context.loader.entries()) await entry.fiber?.await()
  const model = new VisualModel()
  context.llm.registerAdapter(['native-fixture'], model)
  const handle = await context.agents.create({ sessionId: SessionId('native-loader'), agentOptions: { provider: 'native-fixture', model: 'vision' } })
  const agent = handle.agent
  const idle: PromiseWithResolvers<void> = Promise.withResolvers()
  const stop = context.on('agent/status', ({ agent: subject, status }) => {
    if (subject === agent && status === 'idle') idle.resolve()
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Increment the fixture counter and inspect the result.' }], source: { kind: 'user' } }))
  await idle.promise
  stop()

  expect(model.requests).toHaveLength(calls.length + 1)
  const toolMessages = agent.session.deriveMessages().filter(message => message.role === 'tool')
  expect(toolMessages).toHaveLength(calls.length)
  expect(toolMessages.filter(message => message.isError)).toEqual([])
  expect(JSON.stringify(model.requests[0])).toContain('getCapabilities')
  expect(JSON.stringify(model.requests[0])).toContain('appHandle')
  expect(JSON.stringify(model.requests[0])).not.toContain('preloaded')
  expect(JSON.stringify(model.requests[5]?.messages)).toContain('Count: 1')
  const image = toolMessages.at(-1)?.content.find(block => block.type === 'image')
  if (image?.type !== 'image') throw new Error('Native screenshot was not admitted')
  expect(image.attachment).toMatchObject({ mediaType: 'image/png', width: 1, height: 1 })
  const stored = await context.attachments.readImage(image.attachment)
  expect(Buffer.from(stored.data).toString('base64')).toBe(png)
  expect(JSON.stringify(model.requests.at(-1)?.messages)).toContain(JSON.stringify(image.attachment))
  expect(JSON.stringify(toolMessages)).not.toContain(png)
  expect(JSON.stringify(toolMessages.at(-1))).toContain('screenshot-pixels')
  const events = await readEvents()
  expect(events.filter(event => event.event === 'start')).toHaveLength(1)
  expect(events.filter(event => event.event === 'call').map(event => event.method)).toEqual(calls.map(call => call.method))
  const toolCalls = agent.session.snapshotEvents().filter(event => event.type === 'tool/call')
  expect(events.filter(event => event.event === 'call').map(event => event.requestId)).toEqual(toolCalls.map(event => event.data.callId))
  expect(events.find(event => event.event === 'state')?.count).toBe(1)
  expect(events.find(event => event.method === 'getState')?.params).toMatchObject({ maxElements: 2000, maxDepth: 25 })

  const direct = await context.tools.execute({ agent, signal: new AbortController().signal,
    callId: ToolCallId('programmatic-window'), name: 'cua', arguments: { method: 'screenshot', params: { appHandle: 'fixture-app', windowId: 7 } },
  })
  expect(direct.isError).toBe(false)
  expect(direct.value).toMatchObject({ mimeType: 'image/png', data: png })
  expect(context.computerUse.providerName).toBe('dsh-cua')
  for (const [callId, activationRequested, beforePid, beforeWindowId] of [
    ['activate-first', true, 42, 99], ['activate-repeat', false, 9, 7],
  ] as const) {
    const activated = await context.tools.execute({
      agent, signal: new AbortController().signal, callId: ToolCallId(callId), name: 'cua',
      arguments: { method: 'activate', params: { appHandle: 'fixture-app' } },
    })
    expect(activated.isError).toBe(false)
    expect(activated.value).toMatchObject({
      dispatched: true, verified: false, foreground: {
        requestId: callId, operation: 'activate', targetPid: 9, targetWindowId: null, activationRequested, raiseRequested: false,
        before: { frontPid: beforePid, focusedWindowId: 7, frontWindowId: beforeWindowId, frontWindowPid: beforePid },
        after: { frontPid: 9, focusedWindowId: 7, frontWindowId: 7, frontWindowPid: 9 },
      },
    })
    expect(JSON.stringify(activated.content)).toContain(callId)
  }
  const directCalls = (await readEvents()).filter(event => event.event === 'call').slice(-3)
  expect(directCalls.map(event => event.requestId)).toEqual(['programmatic-window', 'activate-first', 'activate-repeat'])

  let objectCall = 0
  const objectApi = (owner: typeof agent) => createCuaApi(async (operation) => {
    const result = await context.tools.execute({ agent: owner, signal: new AbortController().signal,
      callId: ToolCallId(`retained-object-${++objectCall}`), name: 'cua', arguments: operation })
    if (result.isError) throw new Error(JSON.stringify(result.content))
    return z.json().parse(result.value)
  })
  const retainedApp = await objectApi(agent).getApp('test.fixture')
  const retainedWindow = await retainedApp.getWindow(7)
  expect(await retainedWindow.getAXState({ emit: false })).toContain('Count: 1')
  const peer = await context.agents.create({ sessionId: SessionId('native-loader-peer'), agentOptions: { provider: 'native-fixture', model: 'vision' } })
  const peerApp = await objectApi(peer.agent).getApp('test.fixture')
  const peerWindow = await peerApp.getWindow(7)
  expect(peerApp.appHandle).not.toBe(retainedApp.appHandle)
  const screenshot = await peerWindow.getScreenshot({ emit: false })
  expect(screenshot).toMatchObject({ mimeType: 'image/png', pixelWidth: 1, pixelHeight: 1, windowId: 7 })
  expect(Buffer.from(screenshot.bytes).toString('base64')).toBe(png)
  await peerWindow.click(0)
  expect(await retainedWindow.getAXState({ emit: false })).toContain('Count: 2')
  const sharedEvents = await readEvents()
  expect(sharedEvents.filter(event => event.event === 'start')).toHaveLength(1)
  expect(sharedEvents.filter(event => event.event === 'connect')).toHaveLength(2)
  expect(new Set(sharedEvents.map(event => event.pid)).size).toBe(1)
  await handle.dispose()
  expect((await readEvents()).filter(event => event.event === 'exit')).toHaveLength(0)
  expect((await readEvents()).filter(event => event.event === 'disconnect')).toHaveLength(1)
  await peerWindow.click(0)
  expect(await peerWindow.getAXState({ emit: false })).toContain('Count: 3')
  await peer.dispose()
  expect((await readEvents()).filter(event => event.event === 'exit')).toHaveLength(1)

  const next = await context.agents.create({ sessionId: SessionId('native-loader-next'), agentOptions: { provider: 'native-fixture', model: 'vision' } })
  const stale = await context.tools.execute({ agent: next.agent, signal: new AbortController().signal,
    callId: ToolCallId('stale-window'), name: 'cua', arguments: { method: 'screenshot', params: { appHandle: 'fixture-app', windowId: 7 } },
  })
  expect(stale.isError).toBe(true)
  expect(JSON.stringify(stale.content)).toContain('APP_ACCESS_REQUIRED')
  expect((await readEvents()).filter(event => event.event === 'start')).toHaveLength(1)
  const selected = await context.tools.execute({ agent: next.agent, signal: new AbortController().signal,
    callId: ToolCallId('select-new-task'), name: 'cua', arguments: { method: 'getApp', params: { selector: 'test.fixture' } },
  })
  expect(selected.isError).toBe(false)
  const starts = (await readEvents()).filter(event => event.event === 'start')
  expect(starts).toHaveLength(2)
  expect(starts[0]?.pid).not.toBe(starts[1]?.pid)
  const tools = context.tools
  await context.fiber.dispose()
  expect((await readEvents()).filter(event => event.event === 'exit')).toHaveLength(2)
  expect(tools.schemas()).toEqual([])
})
