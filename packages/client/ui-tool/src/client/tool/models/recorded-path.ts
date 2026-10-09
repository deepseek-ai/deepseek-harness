/** Operation-time filesystem locations carried by settled tool results. */
import { isAbsoluteWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'

/**
 * Read one absolute location from opaque persisted result metadata.
 * @param meta - tool-owned result metadata from the Session log.
 * @param field - the file path or command working directory.
 * @returns the recorded path, or undefined for old or malformed metadata.
 */
export function recordedAbsolutePath(meta: unknown, field: 'path' | 'cwd'): string | undefined {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  const value = (meta as Record<string, unknown>)[field]
  return typeof value === 'string' && isAbsoluteWorkspacePath(value) ? value : undefined
}
