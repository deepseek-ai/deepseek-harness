/** Real Loader and AgentLoop composition with only external native/model fixtures. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
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
import * as NativeProvider from '../src/index.ts'
import { resetFixture, screenshotBase64 } from './fixtures/cua-driver.ts'

vi.mock('@trycua/cua-driver', async () => import('./fixtures/cua-driver.ts'))

class VisualModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      const call = { type: 'tool-call' as const, id: ToolCallId('native-window'), name: 'cua_driver_native__get_window_state', arguments: '{"pid":9,"window_id":7}' }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: call }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Observed the fixture window.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let ctx: Context | undefined
let root: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  ctx = undefined
  root = undefined
})

it('loads from cordis.yml and logs the native screenshot before the next model request', async () => {
  resetFixture()
  root = await mkdtemp(join(tmpdir(), 'dsh-native-composition-'))
  const configPath = join(root, 'cordis.yml')
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-attachment-local', LocalAttachmentStore],
    ['@deepseek-ai/dsh-computer-use', ComputerUseRegistry],
    ['@deepseek-ai/dsh-experimental-computer-use-cua-driver-native', NativeProvider],
  ])
  await writeFile(configPath, [...modules.keys()].flatMap(name => [
    `- name: '${name}'`,
    ...name === '@deepseek-ai/dsh-attachment-local' ? ['  config:', `    dshHome: ${JSON.stringify(root)}`] : [],
  ]).join('\n') + '\n')

  const context = ctx = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected fixture module: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  for (const entry of context.loader.entries()) await entry.fiber?.await()
  const model = new VisualModel()
  context.llm.registerAdapter(['native-fixture'], model)
  const agent = await context.agentLoop.create(SessionId('native-loader'), { provider: 'native-fixture', model: 'vision' })
  const idle: PromiseWithResolvers<void> = Promise.withResolvers()
  const stop = context.on('agent/status', ({ agent: subject, status }) => {
    if (subject === agent && status === 'idle') idle.resolve()
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Observe the fixture window.' }], source: { kind: 'user' } }))
  await idle.promise
  stop()

  expect(model.requests).toHaveLength(2)
  expect(JSON.stringify(model.requests[0])).toContain('cua_driver_native__get_window_state')
  expect(JSON.stringify(model.requests[0])).toContain('Cua Driver native computer-use tools operate the host desktop.')
  const toolEvent = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
  expect(toolEvent?.data.message.source.callId).toBe('native-window')
  const toolResult = agent.session.deriveMessages().flatMap(message => message.content).find(block => block.type === 'tool-result')
  const image = toolResult?.type === 'tool-result' ? toolResult.content.find(block => block.type === 'image') : undefined
  expect(image?.type).toBe('image')
  if (image?.type !== 'image') throw new Error('Native screenshot was not admitted')
  expect(image.attachment).toMatchObject({ mediaType: 'image/png', width: 1, height: 1 })
  const stored = await context.attachments.readImage(image.attachment)
  expect(Buffer.from(stored.data).toString('base64')).toBe(screenshotBase64)
  expect(JSON.stringify(model.requests[1]?.messages)).toContain(JSON.stringify(image.attachment))
  expect(JSON.stringify(toolResult?.content)).not.toContain(screenshotBase64)
  const direct = await context.tools.execute({
    agent, signal: new AbortController().signal, callId: ToolCallId('programmatic-window'),
    name: 'cua_driver_native__get_window_state', arguments: { pid: 9, window_id: 7 },
  })
  if (direct.isError) throw new Error('Programmatic native screenshot failed')
  expect(direct.value).toMatchObject({ structuredContent: { window_id: 7, clicked: false } })
})
