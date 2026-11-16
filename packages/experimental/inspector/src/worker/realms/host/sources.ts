/** SourceBackend implementation over native Node Debugger notifications. */

import type { RuntimeScriptKey } from '../../../shared/cdp/ids.ts'
import type { RuntimeScript } from '../../../shared/cdp/index.ts'
import type { HostInspectorNotification, HostInspectorSession } from './bridge.ts'
import type { SourceBackend } from '../../../shared/cdp/realm.ts'
import { hostScriptKey } from './scripts.ts'

interface HostScript {
  readonly descriptor: RuntimeScript
  readonly nativeId: string
}

/** Maintains one connection-local catalog of scripts reported by Node's inspector. */
export class HostSourceBackend implements SourceBackend {
  private readonly scripts = new Map<RuntimeScriptKey, HostScript>()
  private readonly listeners = new Set<(script: RuntimeScript) => void>()
  private readonly unsubscribe: () => void

  constructor(
    private readonly target: HostInspectorSession,
  ) {
    this.unsubscribe = target.subscribe((message) => { this.receive(message) })
  }

  listScripts(): Promise<readonly RuntimeScript[]> {
    return Promise.resolve([...this.scripts.values()].map(script => script.descriptor))
  }

  async getScriptSource(scriptKey: RuntimeScriptKey): Promise<string> {
    const script = this.scripts.get(scriptKey)
    if (script === undefined) throw new Error('Host script is no longer available')
    const result = await this.target.request('Debugger.getScriptSource', { scriptId: script.nativeId })
    if (typeof result.scriptSource !== 'string') throw new Error('Host Debugger returned no script source')
    return result.scriptSource
  }

  getSourceMap(_scriptKey: RuntimeScriptKey): Promise<string | undefined> {
    return Promise.resolve(undefined)
  }

  /**
   * Subscribe to scripts discovered after the initial catalog read.
   * @param listener - Consumer of newly discovered scripts.
   * @returns A disposer removing the consumer.
   */
  subscribe(listener: (script: RuntimeScript) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Release the native notification subscription and cached catalog. */
  close(): void {
    this.unsubscribe()
    this.scripts.clear()
    this.listeners.clear()
  }

  private receive(message: HostInspectorNotification): void {
    if (message.method !== 'Debugger.scriptParsed') return
    const params = message.params
    if (params === undefined
      || typeof params.scriptId !== 'string'
      || typeof params.url !== 'string'
      || !isInteger(params.startLine)
      || !isInteger(params.startColumn)
      || !isInteger(params.endLine)
      || !isInteger(params.endColumn)) return
    const scriptKey = hostScriptKey(params.scriptId)
    const descriptor: RuntimeScript = {
      scriptKey,
      url: params.url,
      hash: typeof params.hash === 'string' ? params.hash : '',
      ...(typeof params.buildId === 'string' ? { buildId: params.buildId } : {}),
      startLine: params.startLine,
      startColumn: params.startColumn,
      endLine: params.endLine,
      endColumn: params.endColumn,
      ...(typeof params.sourceMapURL === 'string' && params.sourceMapURL.length > 0
        ? { sourceMapUrl: params.sourceMapURL }
        : {}),
      ...(isInteger(params.executionContextId) ? { executionContextId: params.executionContextId } : {}),
      ...(typeof params.isModule === 'boolean' ? { isModule: params.isModule } : {}),
      ...(isInteger(params.length) ? { length: params.length } : {}),
    }
    this.scripts.set(scriptKey, { descriptor, nativeId: params.scriptId })
    for (const listener of [...this.listeners]) {
      try {
        listener(descriptor)
      } catch (_listenerFailed) {
        // One source consumer cannot prevent delivery to sibling consumers.
      }
    }
  }
}

function isInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}
