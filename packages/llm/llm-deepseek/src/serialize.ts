/** Map system snapshots, tool changes, and conversation turns to Messages using the configured route capability. */

import { LlmError, requestImageHandleText } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ImageAttachmentAccessResolver, Message, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { DeepSeekConnectionOptions as Connection } from './types.ts'
import type { DeepSeekFileId } from './file-id.ts'
import { readReplay } from './replay.ts'
import type { WireBlock, WireInput, WireMessage, WireRequest } from './wire-types.ts'

function unsupported(type: string): never {
  throw new LlmError(`DeepSeek Messages cannot represent ${type}`, 'UNSUPPORTED_CONTENT')
}

/** Historical arguments that Messages cannot represent use empty input; durable content stays unchanged. */
function toolInput(raw: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(raw) } catch (_invalidToolHistoryJson) {
    return {}
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function assistant(message: Message, model: string, onReplayDegrade?: (reason: string) => void): WireBlock[] {
  const replay = readReplay(message, model, onReplayDegrade)
  return message.content.map((block, index): WireBlock => {
    switch (block.type) {
      case 'text': return { type: 'text', text: block.text }
      case 'reasoning': return {
        type: 'thinking', thinking: block.text,
        ...replay?.[index]?.signature === undefined ? {} : { signature: replay[index].signature },
      }
      case 'tool-call': return { type: 'tool_use', id: block.id, name: block.name, input: toolInput(block.arguments) }
      default: return unsupported(`assistant content ${block.type}`)
    }
  })
}

/** Serialize one complete request using already prepared image bytes.
 * User and tool-result content omits reasoning and tool-call blocks.
 * Empty user messages are skipped; empty tool results retain their call ids.
 * Developer messages, already projected for this route by `LlmRuntime`, become
 * system-role updates after the preceding user turn, with tool changes as
 * `tool_addition` and `tool_removal` references to the declared tool.
 * @param options - provider-neutral request.
 * @param connection - validated defaults and thinking policy.
 * @param history - image-projected history with complete system snapshots; durable messages remain unchanged.
 * @param images - request versions for retained images.
 * @param access - execution-world paths for image descriptions.
 * @param onReplayDegrade - diagnostic for discarded native replay metadata.
 * @param fileIds - resolved Files references; omission selects inline image bytes.
 * @returns the Messages API JSON body.
 */
export function serialize(
  options: GenerateOptions, connection: Connection, history: readonly RequestMessage[],
  images: ReadonlyMap<ImageAttachmentRef['attachmentId'], RequestImageAttachment>, access: ImageAttachmentAccessResolver,
  onReplayDegrade?: (reason: string) => void,
  fileIds?: ReadonlyMap<ImageAttachmentRef['attachmentId'], DeepSeekFileId>,
): WireRequest {
  const model = connection.models.find(entry => entry.id === options.model)
  const inHistory = model?.systemPromptUpdate === 'in-history'
  const input = (blocks: readonly ContentBlock[]): WireInput[] => blocks.flatMap((block): WireInput[] => {
    if (block.type === 'text') return block.text ? [{ type: 'text', text: block.text }] : []
    if (block.type === 'reasoning' || block.type === 'tool-call') return []
    if (block.type !== 'image') return unsupported(`user/tool-result content ${block.type}`)
    const version = images.get(block.attachment.attachmentId)
    if (version === undefined) throw new LlmError('DeepSeek Messages request image is missing', 'INVALID_REQUEST')
    const fileId = fileIds?.get(block.attachment.attachmentId)
    if (fileIds !== undefined && fileId === undefined) throw new LlmError('DeepSeek Messages request file id is missing', 'INVALID_REQUEST')
    return [
      { type: 'text', text: requestImageHandleText(block.attachment, version, access(block.attachment)) },
      fileId === undefined
        ? { type: 'image', source: { type: 'base64', media_type: version.mediaType, data: Buffer.from(version.data).toString('base64') } }
        : { type: 'image', source: { type: 'file', file_id: fileId } },
    ]
  })
  const messages: WireMessage[] = []
  let historySystem: string | undefined
  const systemUpdates: WireMessage[] = []
  // Harness admits system updates before user input. Messages places the same
  // update after that user/tool-result turn and before the next assistant.
  const flushSystemUpdates = () => {
    if (systemUpdates.length === 0) return
    if (messages.at(-1)?.role !== 'user') return unsupported('system update without a preceding user or tool-result turn')
    messages.push(...systemUpdates.splice(0))
  }
  for (const message of history) {
    if (message.role === 'developer') {
      const content = message.content.flatMap((block): WireBlock[] => {
        switch (block.type) {
          case 'text': return block.text.length === 0 ? [] : [{ type: 'text', text: block.text }]
          case 'tool-addition': return [{ type: 'tool_addition', tool: { type: 'tool_reference', name: block.toolName } }]
          case 'tool-removal': return [{ type: 'tool_removal', tool: { type: 'tool_reference', name: block.toolName } }]
          default: return unsupported(`developer content ${block.type}`)
        }
      })
      if (content.length > 0) systemUpdates.push({ role: 'system', content })
      continue
    }
    if (message.content.some(block => block.type === 'tool-addition' || block.type === 'tool-removal')) {
      return unsupported('tool-change blocks outside developer messages')
    }
    if (message.role === 'system') {
      const texts = message.content.filter(block => block.type === 'text')
      if (texts.length !== message.content.length) return unsupported('non-text system message')
      const text = texts.map(block => block.text).join('')
      if (inHistory && messages.length > 0) {
        if (text.length === 0) return unsupported('empty in-history system update')
        systemUpdates.push({ role: 'system', content: [{ type: 'text', text }] })
      } else {
        historySystem = text
      }
      continue
    }
    if (message.role === 'assistant') flushSystemUpdates()
    const content: WireBlock[] = message.role === 'assistant'
      ? assistant(message, options.model, onReplayDegrade)
      : message.role === 'tool'
        ? [{ type: 'tool_result', tool_use_id: message.toolCallId, content: input(message.content), ...message.isError === undefined ? {} : { is_error: message.isError } }]
        : message.content.flatMap((block): WireBlock[] => input([block]))
    if (message.role === 'user' && content.length === 0) continue
    const wireRole = message.role === 'tool' ? 'user' : message.role
    const previous = messages.at(-1)
    if (previous?.role === wireRole) previous.content.push(...content)
    else messages.push({ role: wireRole, content })
  }
  flushSystemUpdates()
  let pending = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      const calls = message.content.filter(block => block.type === 'tool_use')
      pending = new Set(calls.map(block => block.id))
      if (pending.size !== calls.length) throw new LlmError('DeepSeek Messages duplicate tool call id', 'INVALID_REQUEST')
    } else if (message.role === 'user') {
      const results = message.content.filter(block => block.type === 'tool_result')
      for (const result of results) {
        if (!pending.delete(result.tool_use_id)) throw new LlmError('DeepSeek Messages tool result has no matching call', 'INVALID_REQUEST')
      }
      if (pending.size > 0) throw new LlmError('DeepSeek Messages tool calls need immediate results', 'INVALID_REQUEST')
      message.content = [...results, ...message.content.filter(block => block.type !== 'tool_result')]
    }
  }
  if (pending.size > 0) throw new LlmError('DeepSeek Messages history ends with unresolved tools', 'INVALID_REQUEST')
  const effort = options.purpose === 'session-title' ? 'off' : options.reasoningEffort ?? (connection.defaults.reasoningEffort ?? (connection.defaults.thinking === 'disabled' ? 'off' : 'high'))
  if (!['off', 'low', 'high', 'max'].includes(effort) || (connection.defaults.thinking === 'disabled' && effort !== 'off')) {
    throw new LlmError(`DeepSeek Messages does not support reasoning effort ${effort}`, 'UNSUPPORTED_REASONING_EFFORT')
  }
  const system = [options.system, historySystem].filter(Boolean).join('\n\n')
  return {
    model: options.model, stream: true, messages,
    max_tokens: options.maxTokens ?? model?.maxTokens ?? connection.maxTokens,
    thinking: { type: effort === 'off' ? 'disabled' : 'enabled' },
    ...effort === 'off' ? {} : { output_config: { effort: effort as 'low' | 'high' | 'max' } },
    ...system.length === 0 ? {} : { system },
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...options.stop === undefined ? {} : { stop_sequences: options.stop },
    ...options.tools === undefined ? {} : {
      tools: options.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
        ...tool.deferLoading === true ? { defer_loading: true as const } : {},
      })),
    },
  }
}
