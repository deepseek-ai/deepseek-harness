/** Chat-owned approval detail resolving a correlated Tool call's command. */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-approval/client'
import type { ChatNode } from '../contract/chat-nodes.ts'

interface ApprovalToolCall {
  readonly callId: string
  readonly name: string
  readonly argsRaw: string
}

/**
 * Extract the command line from a correlated Tool call: a shell `command`, or the text `terminal_send` types into a terminal.
 * @param call - Tool call name and arguments, when a correlated call exists.
 * @returns command text, or undefined for absent, empty, malformed, or unrelated arguments.
 */
export function commandOf(call: ApprovalToolCall | undefined): string | undefined {
  if (call === undefined) return undefined
  try {
    const args = JSON.parse(call.argsRaw) as Record<string, unknown>
    const command = call.name === 'terminal_send' ? args.text : args.command
    return typeof command === 'string' && command.length > 0 ? command : undefined
  } catch {
    return undefined
  }
}

/**
 * Render the command of the Chat Tool node correlated with an approval.
 * @param props - Approval identity and Session-standard Chat selector hook.
 * @returns command text when the correlated call carries one.
 */
export function ApprovalCommand({ callId, useChat }: PropsRuntime<'conversation.approval.detail'>) {
  const command = useChat((snapshot) => {
    for (const node of snapshot.nodes.values()) {
      const root = node.kind === 'tool-call' ? (node as ChatNode<'tool-call'>).data.root : undefined
      if (root !== undefined && root.callId === callId && !('kind' in root) && root.phase === 'start') return commandOf(root)
    }
    return undefined
  })
  return command ?? null
}
