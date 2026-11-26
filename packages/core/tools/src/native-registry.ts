/** Registry whose entries are model-callable tools. @module */
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import type { ToolDefinition } from './contracts.ts'
import type { ToolRegistry } from './registry.ts'
import { ToolEntries } from './entries.ts'

/**
 * Registry whose entries are its registrations plus the entries of the
 * registries it includes. Each entry is a model-callable tool; as a root, it
 * offers every registration its scope sees.
 */
export class NativeToolRegistry implements ToolRegistry {
  private readonly entries: ToolEntries

  /** @param label - registry name used in duplicate and cycle diagnostics. */
  constructor(label = 'a native tool registry') {
    this.entries = new ToolEntries(label)
  }

  register(tool: ToolDefinition): () => void {
    return this.entries.register(tool)
  }

  include(registry: Pick<ToolRegistry, 'get' | 'getAll'>): () => void {
    return this.entries.include(registry)
  }

  get(name: string, scope?: ScopeKey): ToolDefinition | undefined {
    return this.entries.get(name, scope)
  }

  getAll(scope?: ScopeKey): readonly ToolDefinition[] {
    return this.entries.getAll(scope)
  }
}
