/**
 * In-memory settings provider fixture for manager tests: the smallest real
 * subclass of the settings Service Definition, so the manager's settings
 * integration runs against the real registration, resolution, watch, and
 * publish machinery rather than a hand-rolled stand-in.
 */

import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'

/** In-memory provider with an external-edit hook. */
export class MemorySettings extends SettingsProvider {
  /** Raw document the provider "storage" currently holds. */
  doc: Record<string, unknown>

  constructor(ctx: ConstructorParameters<typeof SettingsProvider>[0], options?: { doc?: Record<string, unknown> }) {
    super(ctx)
    this.doc = structuredClone(options?.doc ?? {})
  }

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }

  /** Simulate an external storage change reaching the provider. */
  pushExternal(doc: Record<string, unknown>): void {
    this.doc = structuredClone(doc)
    this.publish(structuredClone(doc))
  }
}
