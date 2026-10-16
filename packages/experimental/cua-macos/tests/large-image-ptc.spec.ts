/** Valid large PNG admission through Loader, Harness tool rendering, disk attachments and a real Node PTC process. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { inlineImages, prepareImages } from '@deepseek-ai/dsh-llm-deepseek/src/images.ts'
import { serialize } from '@deepseek-ai/dsh-llm-deepseek/src/serialize.ts'
import { resolveRequestImageTarget } from '@deepseek-ai/dsh-llm-deepseek/src/request-pricing.ts'
import NodePtcRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import sharp from 'sharp'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as NativeProvider from '../src/index.ts'
import { installNativeFixture, startFixtureHost } from './native-fixture.ts'

const WIDTH = 2048
const HEIGHT = 1024
const MODEL = 'large-image-vision-fixture'

// The external native substitute is a POSIX executable; it never accesses the desktop.
it.skipIf(process.platform === 'win32')('delivers a valid PNG larger than 4 MiB through disk storage and Node PTC into the next model image request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cua-large-image-'))
  const context = new Context()
  const fixture: { close?: () => Promise<void> } = {}
  onTestFinished(async () => {
    try { await context.fiber.dispose() } finally {
      try { await fixture.close?.() } finally { await rm(root, { recursive: true, force: true }) }
    }
  })
  // Uncompressed encoding makes the size deterministic without private screenshots
  // or random pixels. The attachment store still uses its ordinary normalization policy.
  const source = await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: '#4488cc' } })
    .png({ compressionLevel: 0, adaptiveFiltering: false, palette: false }).toBuffer()
  expect(source.byteLength).toBeGreaterThan(4 * 1024 * 1024)
  const decodedSource = await sharp(source).raw().toBuffer({ resolveWithObject: true })
  expect(decodedSource.info).toMatchObject({ width: WIDTH, height: HEIGHT, channels: 3 })
  expect(decodedSource.data.subarray(0, 3)).toEqual(Buffer.from([0x44, 0x88, 0xcc]))
  const sourcePath = join(root, 'generated-screenshot.png')
  await writeFile(sourcePath, source)

  const helperPath = await installNativeFixture(root)
  fixture.close = await startFixtureHost(helperPath)
  await writeFile(join(root, 'fixture-screenshot.json'), JSON.stringify({
    file: './generated-screenshot.png', pixelWidth: WIDTH, pixelHeight: HEIGHT,
    bounds: { x: 0, y: 0, width: 1024, height: 512 },
  }))
  const modules = {
    llm: LlmRuntime, session: SessionStore, projection: SessionProjectionRegistry,
    systemPrompt: SystemPrompt, tools: ToolRuntime, agents: AgentRegistry, agentLoop: AgentLoop,
    attachments: LocalAttachmentStore, fs: FileSystem, subprocess: SubprocessLocal,
    sandbox: Sandbox, sandboxPolicy: SandboxPolicy, ptc: NodePtcRuntime,
    computerUse: ComputerUseRegistry, cua: NativeProvider, workingDirectory: WorkingDirectory,
  }
  const configPath = join(root, 'cordis.yml')
  const configs: Record<string, object> = {
    tools: { mode: 'ptc' }, attachments: { dshHome: join(root, 'home') }, workingDirectory: { defaultDirectory: root },
    fs: { cwd: root }, sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: root }, cua: { helperPath, allowedApps: [{ 'id': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'name': 'Fixture', 'executablePath': '/fixture/app' }] },
  }
  await writeFile(configPath, Object.keys(modules).flatMap(name => [
    `- name: 'cordis:${name}'`, ...configs[name] === undefined ? [] : [`  config: ${JSON.stringify(configs[name])}`],
  ]).join('\n') + '\n')
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  Object.assign(context.loader.builtins, modules, { include: Include })
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  for (const entry of context.loader.entries()) await entry.fiber?.await()

  const connection = resolveAdapterOptions({ models: [{ id: MODEL, inputModalities: ['text', 'image'] }] })
  const access = (ref: ImageAttachmentRef) => resolveImageAttachmentAccess(
    context.attachments, path => context.fs.processPathFromHostPath(path), ref,
  )
  class VisionModel extends LlmAdapter {
    readonly requests: GenerateOptions[] = []
    readonly requestImages: Buffer[] = []

    override imageRequestTarget(_provider: string, _model: string, image: ImageAttachmentRef) {
      const entry = connection.models.find(model => model.id === MODEL)
      if (!entry) throw new Error('Missing image fixture route')
      return resolveRequestImageTarget(entry, image)
    }

    override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
      return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
    }

    async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      this.requests.push(options)
      if (this.requests.length === 1) {
        const code = 'const app = await tools.cua({ method: "getApp", params: { selector: "9" } }); '
          + 'const result = await tools.cua({ method: "screenshot", params: { appHandle: app.appHandle, windowId: 7 } }); '
          + 'return { mimeType: result.mimeType, encodedLength: result.data.length };'
        const call = { type: 'tool-call' as const, id: ToolCallId('large-image-ptc'), name: 'run_code',
          arguments: JSON.stringify({ code, description: 'Inspect the generated large screenshot' }),
        }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: call }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      // Serialize the real next AgentLoop request using the provider's image reader
      // and message serializer, but do not contact a model endpoint.
      const prepared = await prepareImages(options.messages, connection, MODEL, context.attachments, access,
        options.signal ?? new AbortController().signal)
      const history = inlineImages(prepared.messages, prepared.versions, connection)
      const body = serialize(options, connection, history, prepared.versions, access)
      const blocks = body.messages.flatMap(message => message.content.flatMap(block => block.type === 'tool_result' ? block.content : [block]))
      for (const block of blocks) {
        if (block.type !== 'image') continue
        if (block.source.type !== 'base64') throw new Error('Expected inline request image bytes')
        this.requestImages.push(Buffer.from(block.source.data, 'base64'))
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Received the screenshot through PTC.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const saveImages = vi.spyOn(context.attachments, 'saveImages')
  const model = new VisionModel()
  context.llm.registerAdapter(['large-image-fixture'], model)
  const handle = await context.agents.create({ sessionId: SessionId('large-image-ptc'), meta: { cwd: root },
    agentOptions: { provider: 'large-image-fixture', model: MODEL },
  })
  const idle: PromiseWithResolvers<void> = Promise.withResolvers()
  const stop = context.on('agent/status', ({ agent, status }) => {
    if (agent === handle.agent && status === 'idle') idle.resolve()
  })
  onTestFinished(() => { stop() })
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect the generated screenshot.' }] }))
  await idle.promise
  stop()

  expect(saveImages).toHaveBeenCalledTimes(1)
  expect(model.requests).toHaveLength(2)
  expect(model.requests[0]?.tools?.map(tool => tool.name)).toEqual(['run_code'])
  const messages = handle.agent.session.deriveMessages()
  const result = messages.find(message => message.role === 'tool' && message.toolCallId === 'large-image-ptc')
  if (result?.role !== 'tool') throw new Error('The PTC result was not recorded')
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(result.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
    .toContain(String(model.requestImages[0]?.toString('base64').length))
  const nextImages = model.requests[1]?.messages.flatMap(message => message.content).filter(block => block.type === 'image')
  expect(nextImages).toHaveLength(1)
  const image = nextImages?.[0]
  if (image === undefined) throw new Error('The next model request is missing the PTC screenshot')
  expect(image.attachment).toMatchObject({ width: WIDTH, height: HEIGHT })
  const stored = await context.attachments.readImage(image.attachment)
  const path = context.attachments.imageHostPath(image.attachment)
  if (path === undefined) throw new Error('The real local attachment has no disk path')
  expect(await readFile(path)).toEqual(Buffer.from(stored.data))
  expect(stored.data.byteLength).toBe(image.attachment.bytes)
  const decodedStored = await sharp(stored.data).raw().toBuffer({ resolveWithObject: true })
  expect(decodedStored.info).toMatchObject({ width: WIDTH, height: HEIGHT, channels: 3 })
  const dispatches = handle.agent.session.snapshotEvents().filter(event => event.type === 'tool/ptc-dispatch')
  expect(dispatches).toHaveLength(2)
  expect(dispatches.every(event => event.data.name === 'cua' && !event.data.isError)).toBe(true)
  expect(dispatches[1]?.data.content.find(block => block.type === 'image')?.attachment).toEqual(image.attachment)
  expect(messages.filter(message => message.source.kind === 'ptc-mode').flatMap(message => message.content))
    .toContainEqual({ type: 'image', attachment: image.attachment })
  expect(JSON.stringify(model.requests[1]?.messages)).not.toContain(source.toString('base64'))

  expect(model.requestImages).toHaveLength(1)
  const requestImage = model.requestImages[0]
  if (requestImage === undefined) throw new Error('The provider request is missing inline image bytes')
  const requestRaster = await sharp(requestImage).raw().toBuffer({ resolveWithObject: true })
  expect(requestRaster.info.width).toBeGreaterThan(0)
  expect(requestRaster.info.height).toBeGreaterThan(0)
  expect(requestRaster.data.byteLength).toBe(requestRaster.info.width * requestRaster.info.height * requestRaster.info.channels)
  const { dominant } = await sharp(requestImage).stats()
  for (const [actual, expected] of [[dominant.r, 0x44], [dominant.g, 0x88], [dominant.b, 0xcc]]) {
    if (actual === undefined || expected === undefined) throw new Error('Missing generated image color channel')
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(4)
  }
})
