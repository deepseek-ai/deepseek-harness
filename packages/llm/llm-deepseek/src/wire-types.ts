/** DeepSeek's supported subset of the Anthropic Messages request protocol. */

/** Text and inline or file-referenced images accepted in user messages and tool results. */
export type WireInput =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'image'; source: { type: 'file'; file_id: string } }

/** Content serialized into one Messages conversation turn. */
export type WireBlock = WireInput
  /** Activates or removes a declared tool by name in conversation order. */
  | { type: 'tool_addition' | 'tool_removal'; tool: { type: 'tool_reference'; name: string } }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: WireInput[]; is_error?: boolean }

/** Conversation turn; capable routes retain later system updates in message history. */
export type WireMessage = {
  role: 'user' | 'assistant' | 'system'
  content: WireBlock[]
}

/** JSON body submitted to the resolved Messages endpoint. */
export type WireRequest = {
  model: string
  stream: true
  max_tokens: number
  messages: WireMessage[]
  system?: string
  thinking: { type: 'enabled' | 'disabled' }
  output_config?: { effort: 'low' | 'high' | 'max' }
  temperature?: number
  stop_sequences?: string[]
  tools?: {
    name: string
    description: string
    input_schema: Record<string, unknown>
    /** Delays tool availability until a tool_addition block activates it. */
    defer_loading?: true
  }[]
}
