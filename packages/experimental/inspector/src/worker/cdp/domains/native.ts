/** Explicit adapter for Host-only native CDP methods during realm migration. */

import { respondToCdpRequest, type CdpRequest, type CdpTransport } from '../protocol.ts'
import type { NativeDomainBackend } from '../../../shared/cdp/realm.ts'

/** Forwards one explicit Host-native domain through a transport-neutral Node session. */
export class HostNativeDomainSession {
  private readonly unsubscribe: () => void

  constructor(
    private readonly transport: CdpTransport,
    private readonly target: NativeDomainBackend,
  ) {
    this.unsubscribe = target.subscribe((message) => {
      if (!this.owns(message.method)
        || message.method === 'Runtime.consoleAPICalled'
        || message.method === 'Runtime.exceptionThrown') return
      if (message.method === 'Runtime.executionContextCreated') {
        const context = message.params?.context
        if (typeof context !== 'object' || context === null || !('auxData' in context)) return
        const auxData = context.auxData
        if (typeof auxData !== 'object' || auxData === null || !('isDefault' in auxData) || auxData.isDefault !== true) return
      }
      this.transport.send(message)
    })
  }

  /**
   * Execute one Host-native CDP request and send its correlated result.
   * @param request - Parsed request owned by a native Host domain.
   * @returns Whether this adapter owns the request's domain.
   */
  handle(request: CdpRequest): boolean {
    if (!this.owns(request.method)) return false
    respondToCdpRequest(this.transport, request, async () => this.target.request(request.method, request.params))
    return true
  }

  /**
   * Test whether this adapter owns a CDP method.
   * @param method - CDP method name.
   * @returns Whether the method belongs to an explicit Host-native domain.
   */
  owns(method: string): boolean {
    return NATIVE_DOMAINS.has(method.slice(0, method.indexOf('.')))
  }

  /** Stop forwarding native notifications to this DevTools connection. */
  close(): void {
    this.unsubscribe()
  }

}

const NATIVE_DOMAINS = new Set(['Runtime', 'Profiler', 'HeapProfiler', 'Schema'])
