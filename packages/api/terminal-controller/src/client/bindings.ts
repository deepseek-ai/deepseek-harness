/** Independent content-to-terminal records keep concurrent browser writes disjoint. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WebTerminalId } from '../types.ts'

const PREFIX = 'dsh.terminal.binding.v1.'

/** Saved recovery targets keyed by Session and globally unique terminal content identity. */
export class TerminalBindings {
  private readonly memory = new Map<string, WebTerminalId>()

  /**
   * Read a saved target, retaining this window's value when storage is unavailable.
   * @param sessionId - owning Session.
   * @param contentId - terminal content identity, shared only by deliberate copies.
   * @returns the existing Host identity, if one has been saved.
   */
  get(sessionId: SessionId, contentId: string): WebTerminalId | undefined {
    const key = this.key(sessionId, contentId)
    const known = this.memory.get(key)
    if (known !== undefined) return known
    if (typeof localStorage === 'undefined') return undefined
    try {
      const raw = localStorage.getItem(key)
      if (raw === null) return undefined
      const value: unknown = JSON.parse(raw)
      if (typeof value !== 'string' || !/^[\w-]{1,128}$/u.test(value)) return undefined
      this.memory.set(key, value as WebTerminalId)
      return value as WebTerminalId
    } catch (_storageUnavailable) { return undefined }
  }

  /**
   * Save an identity before its Host allocation begins.
   * @param sessionId - owning Session.
   * @param contentId - globally unique terminal content identity.
   * @param id - existing or newly allocated Host identity.
   */
  set(sessionId: SessionId, contentId: string, id: WebTerminalId): void {
    const key = this.key(sessionId, contentId)
    this.memory.set(key, id)
    if (typeof localStorage === 'undefined') return
    try { localStorage.setItem(key, JSON.stringify(id)) }
    catch (error) { console.error('Terminal binding persistence failed:', error) }
  }

  /**
   * Remove this content's target after its close intent has been saved.
   * @param sessionId - owning Session.
   * @param contentId - closing terminal content identity.
   */
  delete(sessionId: SessionId, contentId: string): void {
    const key = this.key(sessionId, contentId)
    this.memory.delete(key)
    if (typeof localStorage === 'undefined') return
    try { localStorage.removeItem(key) }
    catch (error) { console.error('Terminal binding cleanup failed:', error) }
  }

  /** Release cached values when the Client service is disposed. */
  clear(): void { this.memory.clear() }

  private key(sessionId: SessionId, contentId: string): string { return PREFIX + JSON.stringify([sessionId, contentId]) }
}
