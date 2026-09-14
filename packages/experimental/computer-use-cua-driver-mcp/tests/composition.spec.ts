/** Loader composition with a real stdio child and a scripted external model. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import ComputerUse from '@deepseek-ai/dsh-computer-use'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import * as Provider from '../src/index.ts'

const TOOL = 'mcp__cua-driver-mcp__screenshot'
const fixture = fileURLToPath(new URL('./fixtures/driver.mjs', import.meta.url))
const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(async root => rm(root, { recursive: true, force: true })))
})

class ScreenshotModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      const id = ToolCallId('screenshot-call')
      const args = '{"display":0}'
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: TOOL, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: TOOL, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'The display is visible.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'The display is visible.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

async function load(mode?: string): Promise<{ ctx: Context; root: string; model: ScreenshotModel }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-computer-use-mcp-'))
  roots.push(root)
  const model = new ScreenshotModel()
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-computer-use', ComputerUse],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-attachment-local', LocalAttachmentStore],
    ['@fixture/model', { inject: ['llm'], apply(ctx: Context) { ctx.effect(() => ctx.llm.registerAdapter(['fixture'], model)) } }],
    ['@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp', Provider],
  ])
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([...modules.keys()].map(name => ({
    id: name === '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp' ? 'computer-use-driver' : undefined,
    name,
    config: name === '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp'
      ? {
        command: process.execPath,
        args: [fixture, root, ...(mode === undefined ? [] : [mode])],
        reconnect: { initialDelayMs: 20, maxDelayMs: 40, maxAttempts: 2 },
      }
      : name === '@deepseek-ai/dsh-attachment-local'
        ? { dshHome: root }
        : name === '@deepseek-ai/dsh-agent-loop' ? { agents: [] } : {},
  }))))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return { ctx, root, model }
}

async function driverEvents(root: string): Promise<{ event: string; pid: number; name?: string; arguments?: unknown }[]> {
  return (await readFile(join(root, 'driver.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { event: string; pid: number })
}

function expectProcessExited(pid: number): void {
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
}

async function expectActiveDriver(root: string, connectionCount: number): Promise<void> {
  const events = await driverEvents(root)
  const starts = events.filter(event => event.event === 'start').map(event => event.pid)
  const probes = events.filter(event => event.event === 'discover').map(event => event.pid)
  const drivers = events.filter(event => event.event === 'initialize').map(event => event.pid)
  expect(probes).toHaveLength(connectionCount)
  expect(drivers).toHaveLength(connectionCount)
  expect(starts).toHaveLength(connectionCount * 2)
  expect(new Set(starts)).toEqual(new Set([...probes, ...drivers]))
  for (const pid of [...probes, ...drivers.slice(0, -1)]) expectProcessExited(pid)
  expect(() => process.kill(drivers[connectionCount - 1]!, 0)).not.toThrow()
}

describe('installed Cua Driver Loader composition', () => {
  it('keeps upstream schemas and stores screenshot history as durable images through a real Agent', async () => {
    const { ctx, root, model } = await load()
    await expectActiveDriver(root, 1)
    const fibers = [...ctx.loader.entries()].flatMap(entry => entry.fiber === undefined ? [] : [entry.fiber])
    expect(fibers.every(fiber => fiber.state === FiberState.ACTIVE)).toBe(true)
    expect(ctx.computerUse.providerName).toBe('cua-driver-mcp')
    const agent = await ctx.agentLoop.create(SessionId('computer-use-composition'), { provider: 'fixture', model: 'vision' })
    const idle = new Promise<void>((resolve) => {
      const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'idle') { dispose(); resolve() }
      })
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect display zero.' }], source: { kind: 'user' } }))
    await idle
    expect(model.requests).toHaveLength(2)
    expect(model.requests[0]?.tools?.find(tool => tool.name === TOOL)).toMatchObject({
      description: 'Capture the selected display.',
      parameters: { type: 'object', properties: { display: { type: 'integer', minimum: 0 } }, required: ['display'], additionalProperties: false },
    })
    const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
    expect(result?.data).toMatchObject({ message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'Display 0' }, { type: 'image' }] }] } })
    if (result?.type !== 'tool/result') throw new Error('Missing durable screenshot result')
    const toolResult = result.data.message.content[0]
    if (toolResult?.type !== 'tool-result') throw new Error('Missing tool result block')
    const image = toolResult.content.find(block => block.type === 'image')
    if (image?.type !== 'image') throw new Error('Missing durable screenshot image')
    expect(await ctx.attachments.readImage(image.attachment)).toMatchObject({ ref: { width: 1, height: 1, mediaType: 'image/png' } })
    expect(JSON.stringify(agent.session.snapshotEvents())).not.toContain('iVBORw0KGgo')
    expect(model.requests[1]?.messages).toEqual(agent.session.deriveMessages().slice(0, -1))
    expect(await driverEvents(root)).toContainEqual(expect.objectContaining({ event: 'call', name: 'screenshot', arguments: { display: 0 } }))
    const entry = [...ctx.loader.entries()].find(item => item.options.id === 'computer-use-driver')
    await entry?.fiber?.dispose()
    expect(ctx.tools.get(TOOL)).toBeUndefined()
    expect(ctx.computerUse.providerName).toBeUndefined()
    const events = await driverEvents(root)
    for (const event of events.filter(event => event.event === 'start')) expectProcessExited(event.pid)
  })

  it('retains exclusive ownership when the external process disconnects and reconnects', async () => {
    const { ctx, root } = await load()
    await ctx.tools.execute({ name: 'mcp__cua-driver-mcp__disconnect', arguments: {}, callId: ToolCallId('disconnect'), signal: new AbortController().signal })
    expect(ctx.computerUse.providerName).toBe('cua-driver-mcp')
    expect(() => ctx.computerUse.register(ComputerUseProviderName('replacement'))).toThrow('already registered')
    await vi.waitFor(async () => {
      expect((await driverEvents(root)).filter(event => event.event === 'initialize')).toHaveLength(2)
    }, { timeout: 10_000 })
    await vi.waitFor(async () => {
      const result = await ctx.tools.execute({ name: TOOL, arguments: { display: 2 }, callId: ToolCallId('reconnected'), signal: new AbortController().signal })
      expect(result.isError).not.toBe(true)
      expect(result.content[0]).toEqual({ type: 'text', text: 'Display 2' })
    })
    expect(ctx.computerUse.providerName).toBe('cua-driver-mcp')
    await expectActiveDriver(root, 2)
    await ctx.fiber.dispose()
    for (const event of (await driverEvents(root)).filter(event => event.event === 'start')) expectProcessExited(event.pid)
  })

  it('fails the Loader entry and releases ownership when installed driver initialization fails', async () => {
    const { ctx, root } = await load('fail')
    const entry = [...ctx.loader.entries()].find(item => item.options.id === 'computer-use-driver')
    expect(entry?.fiber?.state).toBe(FiberState.FAILED)
    await expect(entry?.fiber?.await()).rejects.toThrow('initial connection or tool synchronization failed')
    expect(ctx.computerUse.providerName).toBeUndefined()
    expect(ctx.tools.get(TOOL)).toBeUndefined()
    const events = await driverEvents(root)
    expect(events.filter(event => event.event === 'discover')).toHaveLength(1)
    expect(events.filter(event => event.event === 'initialize')).toHaveLength(1)
    expect(events.filter(event => event.event === 'start')).toHaveLength(2)
    for (const event of events.filter(event => event.event === 'start')) expectProcessExited(event.pid)
  })
})
