import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  runScenario,
  type InputScript,
} from '@deepseek-ai/dsh-session-snapshot'

const AGENT = {
  binScript: fileURLToPath(new URL('../../../../src/bin.ts', import.meta.url)),
  configPath: fileURLToPath(new URL('../../../../../../snapshots/acp/escalation-approved/cordis.yml', import.meta.url)),
  profile: 'acp',
  tsconfigPath: fileURLToPath(new URL('../../../../../../tsconfig.json', import.meta.url)),
}
const IMAGE_OFFLOAD_CONFIG = fileURLToPath(new URL('./fixtures/image-offload.cordis.yml', import.meta.url))
const SNAPSHOTS_DIR = fileURLToPath(new URL('../../../../../../snapshots/acp/', import.meta.url))
const READ_IMAGE_WORKSPACE = fileURLToPath(new URL('../../../../../../snapshots/session/read-image/workspace/', import.meta.url))

it.each(['chat-completions', 'messages'] as const)('pins %s Files offload and inline fallback in assembled requests', async (protocol) => {
  const filesPath = protocol === 'messages' ? '/v1/files' : '/files'
  const modelPath = protocol === 'messages' ? '/v1/messages' : '/chat/completions'
  const requests: Record<string, unknown>[] = []
  const fileRequests: Array<{ method: string; path: string; bytes: number }> = []
  let rejectFiles = false
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      void (async () => {
        const url = new URL(request.url ?? '/', 'http://localhost')
        const body = Buffer.concat(chunks)
        if (url.pathname === filesPath && request.method === 'POST') {
          const headers = new Headers()
          for (const [name, value] of Object.entries(request.headers)) {
            if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
          }
          const form = await new Request('http://localhost/files', {
            method: 'POST', headers, body,
          }).formData()
          const file = form.get('file')
          if (!(file instanceof Blob)) throw new Error('snapshot Files upload omitted file')
          fileRequests.push({ method: 'POST', path: url.pathname, bytes: file.size })
          if (rejectFiles) {
            response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({
              error: { message: 'Files temporarily unavailable' },
            }))
            return
          }
          const createdAt = Math.floor(Date.now() / 1_000)
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(protocol === 'messages' ? {
            id: 'file-api-snapshot-1',
            type: 'file',
            size_bytes: file.size,
            created_at: new Date(createdAt * 1_000).toISOString(),
            filename: 'dsh-snapshot.png',
            mime_type: file.type,
          } : {
            id: 'file-api-snapshot-1',
            object: 'file',
            bytes: file.size,
            created_at: createdAt,
            filename: 'dsh-snapshot.png',
            purpose: 'user_data',
            expires_at: createdAt + Number(form.get('expires_after[seconds]')),
          }))
          return
        }
        if (url.pathname !== modelPath) {
          response.writeHead(404).end()
          return
        }
        requests.push(JSON.parse(body.toString('utf8')) as Record<string, unknown>)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        if (protocol === 'messages') {
          const toolCall = requests.length === 1
          const events = [
            { type: 'message_start', message: { id: 'offload-response', model: 'deepseek-v4-flash-vision-exp', usage: { input_tokens: 3, output_tokens: 0 } } },
            { type: 'content_block_start', index: 0, content_block: toolCall
              ? { type: 'tool_use', id: 'native-read-image', name: 'read_image', input: { file_path: 'red.png' } }
              : { type: 'text', text: 'DONE' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: toolCall ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } },
            { type: 'message_stop' },
          ]
          response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
          return
        }
        const events = requests.length === 1
          ? [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"native-read-image","type":"function","function":{"name":"read_image","arguments":"{\\"file_path\\":\\"red.png\\"}"}}]},"index":0,"finish_reason":null}]}',
            'data: {"choices":[{"delta":{},"index":0,"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
            'data: [DONE]',
            '',
          ]
          : [
            'data: {"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
            'data: {"choices":[{"delta":{"content":"DONE"},"index":0,"finish_reason":null}]}',
            'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
            'data: [DONE]',
            '',
          ]
        response.end(events.join('\n\n'))
      })().catch((error: unknown) => {
        response.writeHead(500, { 'content-type': 'text/plain' }).end(String(error))
      })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('image-offload snapshot server has no port')

  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
  const input: InputScript = {
    steps: [
      { op: 'initialize' },
      { op: 'newSession' },
      {
        op: 'promptContent',
        content: [
          { type: 'text', text: 'Compare the older image ' },
          { type: 'image', data: image, mimeType: 'image/png' },
          { type: 'text', text: ' with the newer image ' },
          { type: 'image', data: image, mimeType: 'image/png' },
          { type: 'text', text: ', then use read_image on red.png and reply with DONE.' },
        ],
      },
    ],
  }

  try {
    const result = await runScenario(input, {
      agent: AGENT,
      mode: 'record',
      configPath: IMAGE_OFFLOAD_CONFIG,
      fixtureFile: join(SNAPSHOTS_DIR, 'image-offload-request', 'session.jsonl'),
      workspaceDir: READ_IMAGE_WORKSPACE,
      env: {
        DSH_SNAPSHOT_PROTOCOL: protocol,
        DSH_SNAPSHOT_API_KEY: 'snapshot-key',
        DSH_SNAPSHOT_BASE_URL: `http://127.0.0.1:${address.port}`,
      },
    })
    expect(result.stderr).toBe('')
    expect(requests).toHaveLength(2)
    expect(fileRequests).toEqual([{ method: 'POST', path: filesPath, bytes: 69 }])
    const attachmentDigest = 'b1ff9c8ea3a780bad09b346c423d2d0e46815926879b18e841d928376a946640'
    const attachmentId = `sha256:${attachmentDigest}`
    const accessText = (cwd: string): string => {
      const attachmentPath = join(
        cwd,
        '.dsh',
        'attachments',
        'v1',
        'objects',
        attachmentDigest.slice(0, 2),
        attachmentDigest,
      )
      return ` Normalized copy (read-only; may be resized or re-encoded): ${JSON.stringify(attachmentPath)} (1x1px, image/png).`
        + ' Source dimensions, format, and byte size may differ.'
        + ' Copy to a writable path ending in .png before editing.'
    }
    const normalizedAccess = accessText(result.cwd)
    const imagePrefix = protocol === 'messages' ? '' : '\n'
    const fileImage = protocol === 'messages'
      ? { type: 'image', source: { type: 'file', file_id: 'file-api-snapshot-1' } }
      : { type: 'file', file_id: 'file-api-snapshot-1' }
    const offloadedImage = `[image omitted to fit request image limits; ${attachmentId}.${normalizedAccess}]`
    const imageHandle = `Image ${attachmentId}; request preview 1x1px.${normalizedAccess}`
    const normalizedToolImageHandle = `Image "red.png" (${attachmentId}); request preview 1x1px.${normalizedAccess}`
      .replaceAll(result.cwd, '{{cwd}}')
    const runtimeContext = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n'
      + 'Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.\n\n'
      + 'Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).'
    const messages = requests[0]?.messages as { content?: unknown }[] | undefined
    const offloaded = messages?.find(message => JSON.stringify(message.content).includes('[image omitted'))
    expect(offloaded?.content).toEqual([
      { type: 'text', text: 'Compare the older image ' },
      { type: 'text', text: offloadedImage },
      { type: 'text', text: ' with the newer image ' },
      { type: 'text', text: `${imagePrefix}${imageHandle}` },
      fileImage,
      { type: 'text', text: ', then use read_image on red.png and reply with DONE.' },
      ...protocol === 'messages' ? [{ type: 'text', text: runtimeContext }] : [],
    ])

    if (protocol === 'messages') {
      const followup = requests[1]?.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
      expect(followup).toHaveLength(3)
      expect(followup[0]?.content.filter(block => block.type === 'image')).toEqual([])
      expect(followup[0]?.content.filter(block => block.text === offloadedImage)).toHaveLength(2)
      expect(followup[1]).toEqual({ role: 'assistant', content: [
        { type: 'tool_use', id: 'native-read-image', name: 'read_image', input: { file_path: 'red.png' } },
      ] })
      expect(followup[2]?.role).toBe('user')
      expect(followup[2]?.content).toHaveLength(1)
      const toolResult = followup[2]!.content[0]!
      expect(toolResult.type).toBe('tool_result')
      expect(toolResult.tool_use_id).toBe('native-read-image')
      const content = toolResult.content as Array<Record<string, unknown>>
      expect(content[0]?.type).toBe('text')
      expect(content[0]?.text).toContain('image/png image, 1x1 px, 69 bytes')
      expect(content.slice(1)).toEqual([
        { type: 'text', text: `Image "red.png" (${attachmentId}); request preview 1x1px.${normalizedAccess}` },
        fileImage,
      ])
    } else {
      const followup = structuredClone((requests[1]?.messages as unknown[]).slice(1)) as Array<{
        role?: unknown
        content?: unknown
      }>
      const toolMessage = followup.find(message => message.role === 'tool')
      if (toolMessage === undefined || typeof toolMessage.content !== 'string') {
        throw new Error('native read_image request has no tool content')
      }
      const cwdSpellings = [...new Set([result.cwd, ...result.cwdAliases].flatMap(cwd => (
        cwd.startsWith('/private/') ? [cwd, cwd.slice('/private'.length)] : [cwd, `/private${cwd}`]
      )))]
      let toolContent = toolMessage.content
      for (const cwd of cwdSpellings) toolContent = toolContent.replaceAll(cwd, '{{cwd}}')
      toolMessage.content = toolContent
      expect(followup).toEqual([
        {
          role: 'user',
          content: `Compare the older image ${offloadedImage} with the newer image ${offloadedImage}, then use read_image on red.png and reply with DONE.`,
        },
        {
          role: 'user',
          content: runtimeContext,
        },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'native-read-image',
            type: 'function',
            function: { name: 'read_image', arguments: '{"file_path":"red.png"}' },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'native-read-image',
          content: '<path>{{cwd}}/red.png</path>\n<type>image</type>\n<content>\nimage/png image, 1x1 px, 69 bytes\n'
            + `</content>\n${normalizedToolImageHandle}`,
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Attached image(s) from tool result:' },
            { type: 'file', file_id: 'file-api-snapshot-1' },
          ],
        },
      ])
    }

    rejectFiles = true
    const fallback = await runScenario(input, {
      agent: AGENT,
      mode: 'record',
      configPath: IMAGE_OFFLOAD_CONFIG,
      fixtureFile: join(SNAPSHOTS_DIR, 'image-offload-request', 'session.jsonl'),
      workspaceDir: READ_IMAGE_WORKSPACE,
      env: {
        DSH_SNAPSHOT_PROTOCOL: protocol,
        DSH_SNAPSHOT_API_KEY: 'snapshot-fallback-key',
        DSH_SNAPSHOT_BASE_URL: `http://127.0.0.1:${address.port}`,
      },
    })
    expect(fallback.stderr).toBe('')
    expect(fileRequests).toEqual([
      { method: 'POST', path: filesPath, bytes: 69 },
      { method: 'POST', path: filesPath, bytes: 69 },
    ])
    expect(requests).toHaveLength(3)
    const fallbackMessages = requests[2]?.messages as { content?: unknown }[] | undefined
    const fallbackInput = fallbackMessages?.find(message => JSON.stringify(message.content).includes('[image omitted'))
    const fallbackAccess = accessText(fallback.cwd)
    expect(fallbackInput?.content).toEqual([
      { type: 'text', text: 'Compare the older image ' },
      { type: 'text', text: `[image omitted to fit request image limits; ${attachmentId}.${fallbackAccess}]` },
      { type: 'text', text: ' with the newer image ' },
      { type: 'text', text: `${imagePrefix}Image ${attachmentId}; request preview 1x1px.${fallbackAccess}` },
      protocol === 'messages'
        ? { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } }
        : { type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } },
      { type: 'text', text: ', then use read_image on red.png and reply with DONE.' },
      ...protocol === 'messages' ? [{ type: 'text', text: runtimeContext }] : [],
    ])
  } finally {
    await new Promise<void>(resolve => server.close(() => { resolve() }))
  }
}, 45_000)
