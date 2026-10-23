import { createServer } from 'node:http'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { scanZstdFrames } from '@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.js'
import { execa } from 'execa'
import { describe, expect, it, onTestFinished } from 'vitest'
import { workspaceDependencyPaths, type PrimaryRuntimeManifest } from '@deepseek-ai/dsh-tool-workspace-dependencies'

import { messagesResponse } from './fixtures/messages-response.ts'

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
const launch = resolveExampleLaunch({
  srcBin: fileURLToPath(new URL('../../../src/bin.ts', import.meta.url)),
  mode: 'lib',
})


function waitForLine(
  lines: string[],
  predicate: (value: Record<string, unknown>) => boolean,
  stderr: () => string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000
    const poll = (): void => {
      while (lines.length > 0) {
        const line = lines.shift()!
        if (!line.trim()) continue
        try {
          const value = JSON.parse(line) as Record<string, unknown>
          if (predicate(value)) {
            resolve(value)
            return
          }
        } catch {
          reject(new Error(`non-JSON stdout from JSON-RPC agent runtime: ${line}`))
          return
        }
      }
      if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for JSON-RPC response; stderr=${stderr()}`))
        return
      }
      setTimeout(poll, 10)
    }
    poll()
  })
}

describe('Python SDK dsh profile keyless smoke', () => {
  it.each([
    { label: 'reports max-token turns with the default mapping config', envValue: undefined, editorEnabled: false },
    { label: 'reports max-token turns with mapping enabled through env', envValue: 'true', editorEnabled: false },
    { label: 'reports max-token turns with mapping disabled through env', envValue: 'false', editorEnabled: false },
    { label: 'allows an explicit patch to enable str_replace_editor', envValue: undefined, editorEnabled: true },
    { label: 'uses the PTC executor overlay despite the retired environment selector', envValue: undefined, editorEnabled: false, ptc: true },
  ])('$label', async (scenario) => {
    const { envValue, editorEnabled } = scenario
    const ptc = 'ptc' in scenario && scenario.ptc

    const root = await mkdtemp(join(tmpdir(), 'dsh-python-sdk-runtime-smoke-'))
    const editorPatch = join(root, 'editor.patch.yml')
    if (editorEnabled) await writeFile(editorPatch, [
      '- insert:',
      '    - id: tool-str-replace-editor',
      "      name: '@deepseek-ai/dsh-tool-str-replace-editor'",
      '',
    ].join('\n'))
    const modelRequests: Record<string, unknown>[] = []
    const modelServer = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        modelRequests.push(JSON.parse(body) as Record<string, unknown>)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(messagesResponse({ type: 'text', text: 'done' }, 'max_tokens'))
      })
    })
    await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve))
    const address = modelServer.address()
    if (address === null || typeof address === 'string') throw new Error('model server did not bind a TCP port')
    // The line-predicate protocol driving below is the genuinely custom part;
    // execa owns spawn, the deadline, and exit settlement around it.
    const child = execa(launch.command, [
      ...launch.args,
      '--profile',
      'sdk',
      ...(editorEnabled ? ['--patch', editorPatch] : []),
      ...(ptc ? ['--patch', join(repoRoot, 'apps/cli/config/examples/ptc.yml')] : []),
    ], {
      cwd: repoRoot,
      env: {
        ...launch.env,
        DSH_HOME: join(root, '.dsh'),
        DSH_PERMISSION_MODE: 'danger-full-access',
        DSH_TELEMETRY_DISABLED: '1',
        DSH_TOOLS_MODE: ptc ? 'native' : 'ptc',
        DEEPSEEK_API_KEY: 'keyless-smoke-no-call',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
        ...(envValue === undefined ? {} : { DSH_MAX_TOKENS_AS_SUCCESS: envValue }),
      },
      timeout: 35_000,
      killSignal: 'SIGKILL',
      reject: false,
    })
    const lines: string[] = []
    let stdoutBuffer = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      const parts = stdoutBuffer.split('\n')
      stdoutBuffer = parts.pop() ?? ''
      lines.push(...parts)
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })

    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          cwd: root,
          provider: 'deepseek-official',
          model: 'deepseek-v4-pro',
          reasoningEffort: 'max',
          maxTokens: 1234,
        },
      })}\n`)
      const initialized = await waitForLine(lines, value => value.id === 1, () => stderr)
      expect(initialized).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: { serverInfo: { name: 'deepseek-harness-sdk-runtime' } },
      })

      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/prompt',
        params: { sessionId: 'main', contentBlocks: [{ type: 'text', text: 'inspect tools' }] },
      })}\n`)
      const prompt = await waitForLine(lines, value => value.id === 2, () => stderr)
      expect(prompt).toMatchObject({
        jsonrpc: '2.0',
        id: 2,
        result: { messageId: expect.any(String) as unknown },
      })
      const turnEnd = await waitForLine(lines, (value) => {
        if (value.method !== 'session.event') return false
        const params = value.params as Record<string, unknown> | undefined
        const event = params?.event as Record<string, unknown> | undefined
        return params?.sessionId === 'main' && event?.type === 'turn/end'
      }, () => stderr)
      expect(turnEnd).toMatchObject({
        jsonrpc: '2.0',
        method: 'session.event',
        params: {
          sessionId: 'main',
          event: {
            type: 'turn/end',
            data: { reason: { kind: 'max-tokens' } },
          },
        },
      })
      expect(modelRequests[0]?.tools).toEqual(expect.any(Array))
      const tools = modelRequests[0]?.tools as { name?: string }[]
      const toolNames = tools.map(tool => tool.name)
      expect(modelRequests[0]?.output_config).toEqual({ effort: 'max' })
      expect(modelRequests[0]?.max_tokens).toBe(1234)
      const expectedTools = ['read', 'write', 'edit', 'web_fetch', 'web_search', 'subagent', 'subagent_fork',
        'present', 'ask_user_question', 'schedule_create', 'schedule_delete', 'schedule_list', 'schedule_update']
      const requestText = JSON.stringify(modelRequests[0])
      if (ptc) {
        expect(toolNames).toEqual(['run_code'])
        for (const tool of expectedTools) expect(requestText.includes(`${tool}:`), tool).toBe(true)
      } else {
        expect(toolNames).toEqual(expect.arrayContaining(expectedTools))
        expect(toolNames.includes('str_replace_editor')).toBe(editorEnabled)
        expect(toolNames).not.toContain('list_subagent_models')
      }
      for (const text of ['Tokens prefixed with @', 'Prefer showing the primary results',
        'Time sampled while preparing']) {
        expect(requestText.includes(text), text).toBe(true)
      }
      expect(requestText).not.toContain('Current DeepSeek Harness implementation checkout:')
      expect(requestText).not.toContain('Current DeepSeek Harness Web GUI URL:')

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'shutdown' })}\n`)
      const shutdown = await waitForLine(lines, value => value.id === 3, () => stderr)
      expect(shutdown).toMatchObject({ jsonrpc: '2.0', id: 3, result: {} })
      const exit = await child
      expect(exit.exitCode, `signal=${String(exit.signal)}; stderr=${stderr}`).toBe(0)
      const sessionsRoot = join(root, '.dsh', 'sessions')
      const files = await readdir(sessionsRoot, { recursive: true })
      // Session logs are JSONL across one zstd frame per batch, header frame
      // first. Decompress frames explicitly: a single call over concatenated
      // frames returned only the first frame on Node 24.19 and returns every
      // frame on 24.22, so neither behavior may back the assertion.
      const logs: { compressed: Buffer; header: Record<string, unknown> }[] = []
      for (const file of files.filter(file => file.endsWith('.jsonl.zstd'))) {
        const compressed = await readFile(join(sessionsRoot, file))
        expect(compressed.subarray(0, 4).toString('hex')).toBe('28b52ffd')
        const first = scanZstdFrames(compressed).frames[0]
        if (first === undefined) continue
        const headerLine = zstdDecompressSync(compressed.subarray(first.start, first.end)).toString().trim().split('\n')[0]
        if (headerLine === undefined) continue
        logs.push({ compressed, header: JSON.parse(headerLine) as Record<string, unknown> })
      }
      const log = logs.find(entry => entry.header.type === 'session' && entry.header.id === 'main')
      expect(log).toBeDefined()
      const { frames, tornStart } = scanZstdFrames(log!.compressed)
      expect(tornStart).toBeUndefined()
      const records = frames
        .flatMap(({ start, end }) => zstdDecompressSync(log!.compressed.subarray(start, end)).toString().trim().split('\n'))
        .map(line => JSON.parse(line) as Record<string, unknown>)
      expect(records[0]).toMatchObject({ type: 'session', id: 'main' })
      expect(records.length).toBeGreaterThan(1)
      expect(records.some(record => record.type === 'turn/end')).toBe(true)
    } finally {
      // No-op after exit; reject: false settles on every outcome, so cleanup never races teardown.
      child.kill('SIGKILL')
      await child
      await new Promise<void>(resolve => modelServer.close(() => { resolve() }))
      await rm(root, { recursive: true, force: true })
    }
  }, 40_000)

  it.each([
    { label: 'boots the standalone minimal profile through its generated manifest', editorEnabled: false, imageEnabled: false, optOut: false, offloadEnabled: false },
    { label: 'executes the documented editor opt-in patch with sdk-minimal', editorEnabled: true, imageEnabled: false, optOut: false, offloadEnabled: false },
    { label: 'sends a read_image result to the model with sdk-minimal', editorEnabled: false, imageEnabled: true, optOut: false, offloadEnabled: false },
    { label: 'offloads an over-budget image and continues with sdk-minimal', editorEnabled: false, imageEnabled: true, optOut: false, offloadEnabled: true },
    { label: 'retains the previous tools through the documented opt-out patch', editorEnabled: false, imageEnabled: false, optOut: true, offloadEnabled: false },
  ])('$label', async ({ editorEnabled, imageEnabled, optOut, offloadEnabled }) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-python-sdk-minimal-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const editorPatch = join(root, 'editor.patch.yml')
    if (editorEnabled) {
      const guide = await readFile(join(repoRoot, 'docs/user/guide/python-sdk.md'), 'utf8')
      const yaml = guide.split('<a id="opt-in-to-str_replace_editor"></a>')[1]
        ?.match(/```yaml\n([\s\S]*?)```/)?.[1]
      expect(yaml).toBeDefined()
      await writeFile(editorPatch, yaml!)
    }
    if (optOut) {
      const guide = await readFile(join(repoRoot, 'docs/upgrade-guide/v0.2.1-alpha.2/sdk-minimal-image-compaction/guide.md'), 'utf8')
      const yaml = guide.match(/```yaml\n([\s\S]*?)```/)?.[1]
      expect(yaml).toBeDefined()
      await writeFile(editorPatch, yaml!)
    }
    if (offloadEnabled) await writeFile(editorPatch, [
      '- id: llm-deepseek',
      '  config:',
      '    apiKeyEnv: DEEPSEEK_API_KEY',
      '    maxRequestFilesBytes: 1',
      '    imageOffloadByteQuantum: 1',
      '',
    ].join('\n'))
    const editorFile = join(root, 'editor.txt')
    if (imageEnabled) await writeFile(join(root, 'red.png'), Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64',
    ))
    const editorContent = 'sdk-minimal editor opt-in\n'
    const editorCalls = editorEnabled ? [
      { command: 'create', path: editorFile, file_text: editorContent },
      { command: 'view', path: editorFile },
    ] : []
    const modelRequests: Record<string, unknown>[] = []
    const modelServer = createServer((request, response) => {
      if (imageEnabled && request.url?.endsWith('/files')) {
        request.resume()
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          id: 'file-minimal-image', type: 'file', size_bytes: 69,
          created_at: new Date().toISOString(),
          filename: 'red.png', mime_type: 'image/png',
        }))
        return
      }
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        modelRequests.push(JSON.parse(body) as Record<string, unknown>)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const toolCall = imageEnabled && modelRequests.length === 1
          ? { file_path: 'red.png' }
          : editorCalls[modelRequests.length - 1]
        response.end(messagesResponse(toolCall ? {
          type: 'tool_use',
          id: imageEnabled ? 'minimal-image-read' : `editor-${editorCalls[modelRequests.length - 1]?.command}`,
          name: imageEnabled ? 'read_image' : 'str_replace_editor',
          input: toolCall,
        } : { type: 'text', text: 'done' }, toolCall ? 'tool_use' : 'end_turn'))
      })
    })
    await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve))
    const address = modelServer.address()
    if (address === null || typeof address === 'string') throw new Error('model server did not bind a TCP port')
    const child = execa(launch.command, [
      ...launch.args,
      '--profile',
      'sdk-minimal',
      ...(editorEnabled || optOut || offloadEnabled ? ['--patch', editorPatch] : []),
    ], {
      cwd: repoRoot,
      env: {
        ...launch.env,
        DSH_HOME: join(root, '.dsh'),
        DSH_SYSTEM_PROMPT: 'Minimal allowlist prompt.',
        DEEPSEEK_API_KEY: 'keyless-smoke-no-call',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
      },
      timeout: 35_000,
      killSignal: 'SIGKILL',
      reject: false,
    })
    const lines: string[] = []
    let stdoutBuffer = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      const parts = stdoutBuffer.split('\n')
      stdoutBuffer = parts.pop() ?? ''
      lines.push(...parts)
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })

    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { cwd: root, provider: 'deepseek-official', model: imageEnabled ? 'deepseek-flash' : 'deepseek-v4-pro' },
      })}\n`)
      await waitForLine(lines, value => value.id === 1, () => stderr)
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/prompt',
        params: { sessionId: 'minimal', contentBlocks: [{ type: 'text', text: 'inspect tools' }] },
      })}\n`)
      const offloads: Record<string, unknown>[] = []
      const turnEnd = await waitForLine(lines, (value) => {
        const params = value.params as Record<string, unknown> | undefined
        const event = params?.event as Record<string, unknown> | undefined
        if (params?.sessionId === 'minimal' && event?.type === 'image/offload') offloads.push(event)
        return params?.sessionId === 'minimal' && event?.type === 'turn/end'
      }, () => stderr)
      expect(turnEnd, `${JSON.stringify(turnEnd)}\n${stderr}`).toMatchObject({
        params: { event: { data: { reason: { kind: 'completed' } } } },
      })

      const profile = JSON.parse(
        await readFile(join(root, '.dsh', 'profiles', 'sdk-minimal', 'package.json'), 'utf8'),
      ) as { dsh?: { profile?: { bundles?: string[] } } }
      expect(profile.dsh?.profile).toEqual({
        bundles: ['@deepseek-ai/dsh-sdk-minimal'],
      })
      expect(modelRequests[0]?.tools).toEqual(expect.any(Array))
      const tools = modelRequests[0]?.tools as { name?: string }[]
      expect(tools.map(tool => tool.name)).toEqual([
        process.platform === 'win32' ? 'pwsh' : 'bash',
        ...(optOut ? [] : ['read_image']),
        ...(editorEnabled ? ['str_replace_editor'] : []),
        'working_directory',
      ])
      expect(modelRequests).toHaveLength(editorEnabled ? 3 : imageEnabled ? 2 : 1)
      if (imageEnabled) {
        const messages = modelRequests[1]?.messages as {
          content: { type: string; tool_use_id?: string; content?: { type: string; source?: { type: string; file_id: string } }[] }[]
        }[]
        const imageResult = messages.flatMap(message => message.content)
          .find(block => block.type === 'tool_result' && block.tool_use_id === 'minimal-image-read')
        if (offloadEnabled) {
          expect(offloads).toHaveLength(1)
          expect(offloads[0]).toMatchObject({ data: { targets: [{ imageIndexes: [0] }] } })
          expect(imageResult?.content?.some(block => block.type === 'image')).toBe(false)
          expect(JSON.stringify(imageResult?.content)).toContain('red.png')
        } else {
          expect(offloads).toEqual([])
          expect(imageResult?.content).toEqual(expect.arrayContaining([
            { type: 'image', source: { type: 'file', file_id: 'file-minimal-image' } },
          ]))
        }
        const stored = await readdir(join(root, '.dsh', 'attachments', 'v1', 'objects'), { recursive: true })
        expect(stored.some(file => /[a-f0-9]{64}$/u.test(file))).toBe(true)
      }
      if (editorEnabled) {
        expect(await readFile(editorFile, 'utf8')).toBe(editorContent)
        expect(modelRequests[2]?.messages).toEqual(expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.arrayContaining([
              expect.objectContaining({
                type: 'tool_result',
                tool_use_id: 'editor-view',
                content: expect.arrayContaining([
                  { type: 'text', text: expect.stringContaining(editorContent.trim()) as unknown },
                ]) as unknown,
              }),
            ]) as unknown,
          }),
        ]))
      }

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'shutdown' })}\n`)
      await waitForLine(lines, value => value.id === 3, () => stderr)
      const exit = await child
      expect(exit.timedOut, stderr).toBe(false)
      expect(exit.signal, stderr).toBeUndefined()
      expect(exit.exitCode, `signal=${String(exit.signal)}; stderr=${stderr}`).toBe(0)
    } finally {
      child.kill('SIGKILL')
      await child
      await new Promise<void>(resolve => modelServer.close(() => { resolve() }))
    }
  }, 40_000)

  it.each([false, true])('exits after startup failure with stdin open (logs blocked: %s)', async (blocked) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-startup-exit-'))
    const home = join(root, '.dsh')
    const patch = join(root, 'failure.yml')
    await mkdir(home)
    if (blocked) await writeFile(join(home, 'logs'), 'blocked')
    await writeFile(patch, '- id: agent-loop\n  config:\n    maxParallelToolCalls: 0\n')
    const child = execa(launch.command, [
      ...launch.args, '--profile', 'sdk', '--patch', patch,
    ], {
      cwd: repoRoot,
      env: { ...launch.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: 'keyless-no-call' },
      stdin: 'pipe',
      stripFinalNewline: false,
      timeout: 25_000,
      killSignal: 'SIGKILL',
      reject: false,
    })
    try {
      const result = await child
      expect(result.timedOut, result.stderr).toBe(false)
      expect(result.signal, result.stderr).toBeUndefined()
      expect(result.exitCode, result.stderr).toBe(1)
      expect(result.stderr).toContain('startup failed:')
      expect(result.stderr).toContain('maxParallelToolCalls')
      if (blocked) {
        expect(result.stderr).toContain('Full diagnostics:\nWARNING: Raw diagnostics')
        expect(result.stderr.trimEnd()).toMatch(/\}$/u)
      } else {
        const files = await readdir(join(home, 'logs'))
        expect(files).toHaveLength(1)
        expect(result.stderr).toContain(`Full diagnostics: ${join(home, 'logs', files[0]!)}\n`)
      }
    } finally {
      child.stdin.end()
      child.kill('SIGKILL')
      await child
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('rejects an invalid max-token success env value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-python-sdk-runtime-invalid-'))
    try {
      const { exitCode, stdout, stderr } = await execa(launch.command, [
        ...launch.args,
        '--profile',
        'sdk',
      ], {
        cwd: repoRoot,
        env: {
          ...launch.env,
          DSH_HOME: join(root, '.dsh'),
          DEEPSEEK_API_KEY: 'keyless-smoke-no-call',
          DSH_MAX_TOKENS_AS_SUCCESS: 'sometimes',
        },
        stdin: 'ignore',
        timeout: 25_000,
        killSignal: 'SIGKILL',
        reject: false,
      })

      expect(exitCode, stderr).toBe(1)
      expect(stdout).toBe('')
      expect(stderr).toContain('startup failed:')
      expect(stderr).toContain('sdk-jsonrpc-server (required)\n    Package: @deepseek-ai/dsh-sdk-jsonrpc-server\n    SyntaxError')
      expect(stderr).toContain('sometimes')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})

/** Materialize a native-layout payload whose paths the query can validate without executing binaries. */
async function officeFixture(root: string, pythonOnly: boolean) {
  const source = join(root, 'resources', 'primary-runtime')
  const manifest: PrimaryRuntimeManifest = {
    desktopVersion: '1.0.0', platform: process.platform, arch: process.arch,
    python: '3.12.14',
    ...(pythonOnly ? {} : { node: '24.21.0', pnpm: '11.7.0' }),
    pythonPackages: { 'python-docx': '1.2.0', 'python-pptx': '1.0.2', openpyxl: '3.1.5' },
  }
  const paths = workspaceDependencyPaths(source, manifest)
  for (const file of [paths.python, paths.node, paths.pnpm]) {
    if (file === undefined) continue
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, 'fixture interpreter')
  }
  await mkdir(paths.pythonPackages, { recursive: true })
  if (paths.nodePackages !== undefined) await mkdir(paths.nodePackages, { recursive: true })
  await writeFile(join(source, 'runtime.json'), JSON.stringify(manifest))
  await cp(join(repoRoot, 'packages/skill/skill-office/assets'), join(root, 'resources', 'office-skills'), { recursive: true })
  return { source, paths }
}

it.each(['unset', 'empty', 'bundled', 'full', 'python-only', 'python-only-no-cli', 'missing-assets', 'wrong-type'] as const)('composes Office resources through the SDK profile (%s)', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-office-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const enabled = mode !== 'unset' && mode !== 'empty'
  const { source, paths } = await officeFixture(root, mode.startsWith('python-only'))
  if (mode === 'missing-assets') await rm(join(root, 'resources', 'office-skills'), { recursive: true })
  if (mode === 'wrong-type') {
    await rm(paths.python)
    await mkdir(paths.python)
  }
  const requests: Record<string, unknown>[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8').on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(body) as Record<string, unknown>)
      const query = requests.length === 1 && enabled
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(messagesResponse(query
        ? { type: 'tool_use', id: 'workspace-dependencies', name: 'load_workspace_dependencies', input: {} }
        : { type: 'text', text: 'done' }, query ? 'tool_use' : 'end_turn'))
    })
  })
  onTestFinished(() => new Promise<void>((resolve) => { server.close(() => { resolve() }) }))
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('model fixture did not bind')
  const home = join(root, 'home')
  const cliPatch = join(root, 'cli.patch.yml')
  await writeFile(cliPatch, JSON.stringify(mode === 'python-only-no-cli' ? [{ id: 'skill-office', config: { assetRoot: join(root, 'resources', 'office-skills'), cli: false } }] : []))
  const officeLaunch = resolveExampleLaunch({
    srcBin: fileURLToPath(new URL('../../../src/bin.ts', import.meta.url)), mode: 'lib',
    configArgs: ['--profile', 'sdk', '--patch', cliPatch],
    env: { DSH_HOME: home, DSH_PRIMARY_RUNTIME: mode === 'unset' || mode === 'bundled' ? undefined : mode === 'empty' ? '' : source + '/',
      DSH_BUNDLED_PRIMARY_RUNTIME: mode === 'unset' ? undefined : mode === 'bundled' || mode === 'empty' ? source : join(root, 'unused-default'),
      DSH_PERMISSION_MODE: 'danger-full-access', DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: 'local-fixture', DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}` },
  })
  const child = execa(officeLaunch.command, officeLaunch.args, { cwd: repoRoot, env: officeLaunch.env, timeout: 60_000, reject: false })
  onTestFinished(async () => { child.kill('SIGKILL'); await child })
  let buffer = '', stderr = ''
  const lines: string[] = []
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    lines.push(...parts)
  })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const send = (id: number, method: string, params?: object) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return waitForLine(lines, value => value.id === id, () => stderr)
  }
  expect(await send(1, 'initialize', { cwd: root, provider: 'deepseek-official', model: 'deepseek-v4-pro' })).toHaveProperty('result')
  await send(2, 'session/prompt', { sessionId: 'office', contentBlocks: [{ type: 'text', text: 'Query workspace dependencies.' }] })
  await waitForLine(lines, (value) => {
    const params = value.params as { sessionId?: string; event?: { type?: string } } | undefined
    return value.method === 'session.event' && params?.sessionId === 'office' && params.event?.type === 'turn/end'
  }, () => stderr)
  const names = (requests[0]!.tools as { name: string }[]).map(value => value.name)
  expect(names.includes('load_workspace_dependencies')).toBe(enabled)
  expect(JSON.stringify(requests[0]!.messages).includes('`office`')).toBe(enabled && mode !== 'missing-assets')
  expect(names).not.toContain('office_tools')
  expect(names).not.toContain('render_document')
  for (const name of ['office-docx', 'office-pptx', 'office-xlsx']) {
    expect(JSON.stringify(requests[0]!.messages).includes(name)).toBe(enabled && mode !== 'missing-assets')
  }
  if (mode === 'wrong-type') {
    expect(requests).toHaveLength(2)
    const messages = requests[1]!.messages as { content: { type: string; tool_use_id?: string; content?: unknown }[] }[]
    const result = messages.flatMap(message => message.content).find(block => block.tool_use_id === 'workspace-dependencies')
    expect(JSON.parse(JSON.stringify(result).replaceAll(JSON.stringify(paths.python).slice(1, -1), '<python>'))).toMatchInlineSnapshot(`
      {
        "content": [
          {
            "text": "Error: primary runtime: expected file at <python>",
            "type": "text",
          },
        ],
        "is_error": true,
        "tool_use_id": "workspace-dependencies",
        "type": "tool_result",
      }
    `)
  } else if (enabled) {
    expect(requests).toHaveLength(2)
    const content: unknown = expect.arrayContaining([
      expect.objectContaining({ type: 'tool_result', tool_use_id: 'workspace-dependencies',
        content: [{ type: 'text', text: JSON.stringify(paths, undefined, 2) }] }),
    ])
    expect(requests[1]!.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content }),
    ]))
  }
  if (mode === 'python-only') expect(stderr).not.toContain('ENOENT')
  if (mode === 'missing-assets') expect(stderr).toContain('SKILL.md')
  await send(3, 'shutdown')
  const exit = await child
  expect(exit.timedOut).toBe(false)
  expect(exit.signal).toBeUndefined()
  expect(exit.exitCode, stderr).toBe(0)
  await expect(readFile(join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'runtime.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})
