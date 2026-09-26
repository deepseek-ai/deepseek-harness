/** Shared DeepSeek Messages API endpoint and header policy. @module dsh-llm-deepseek/messages-api */

/** Required opt-in for Messages file operations and file-referenced image requests. */
export const MESSAGES_FILES_BETA = 'files-api-2025-04-14'

/** Required opt-in for mid-conversation `tool_addition` and `tool_removal` blocks. */
export const MESSAGES_TOOL_CHANGES_BETA = 'mid-conversation-tool-changes-2026-07-01'

/**
 * Resolve the API root without duplicating an explicit provider version path.
 * @param baseURL - validated configured endpoint root.
 * @returns the root beneath which Messages resources are exposed.
 */
export function messagesApiRoot(baseURL: string): string {
  const base = baseURL.replace(/\/+$/u, '')
  return new URL(base).pathname.endsWith('/v1') ? base : `${base}/v1`
}
