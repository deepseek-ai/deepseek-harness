/**
 * Process-local dynamic Plugin registry and its opaque identity mints.
 * @module @deepseek-ai/dsh-cordis-host-runner/registry
 */

import type { Fiber } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  ApprovalRequestId, CordisDynamicPackageId, CordisDynamicPluginId, CordisDynamicPluginRunId,
  CordisDynamicRunMode, DynamicCordisRenderFailure, DynamicCordisRunAttempt,
} from './types.ts'

/** One Host method exposed to this package's Client half. */
export type DynamicCordisHandler = (args: unknown) => Promise<unknown>

/** One live activation and everything its teardown owns. */
export interface DynamicCordisRun {
  /** Exact activation identity. */
  pluginRunId: CordisDynamicPluginRunId
  /** Immutable package version being run. */
  packageId: CordisDynamicPackageId
  /** Host-half Fiber, absent for Client-only packages. */
  fiber?: Fiber
  /** Active Host methods. */
  handlers: Map<string, DynamicCordisHandler>
  /** Method registration cleanup. */
  handlerDisposers: (() => void)[]
  /** Runtime failures already sent to the owning Agent during this activation. */
  reportedRuntimeErrors: Set<string>
  /** Last render failure observed for this version's current run. */
  renderFailure?: DynamicCordisRenderFailure
  /** Approval whose transition started this run, when model-driven. */
  startedForRequest?: ApprovalRequestId
}

/** One immutable package version. */
export interface DynamicCordisDefinition {
  /** Package identity. */
  packageId: CordisDynamicPackageId
  /** Package label. */
  name: string
  /** User-facing purpose. */
  purpose: string
  /** Host source. */
  hostCode?: string
  /** Client source. */
  clientCode?: string
}

/** Stable plugin instance containing immutable package versions. */
export interface DynamicCordisPlugin {
  /** Stable identity. */
  pluginId: CordisDynamicPluginId
  /** Owning session. */
  sessionId: SessionId
  /** Versions in define order. */
  packages: Map<CordisDynamicPackageId, DynamicCordisDefinition>
  /** Client-bearing Packages individually authorized by the user. */
  approvedClientPackages: Set<CordisDynamicPackageId>
  /** Whether one user decision authorized future Package versions of this Plugin. */
  clientVersionUpdatesApproved: boolean
  /** Last successfully activated version. */
  currentPackageId?: CordisDynamicPackageId
  /** Failed or in-progress target version. */
  nextPackageId?: CordisDynamicPackageId
  /** Current activation. */
  run?: DynamicCordisRun
  /** Latest activation attempt, including approval and asynchronous failure state. */
  latestRun?: DynamicCordisRunAttempt
}

/** One suspended model-driven activation. */
export interface DynamicCordisPendingRequest {
  /** Session whose model requested this activation. */
  agentId: SessionId
  pluginId: CordisDynamicPluginId
  packageId: CordisDynamicPackageId
  pluginRunId: CordisDynamicPluginRunId
  mode: CordisDynamicRunMode
  /** Whether this request must wait for an explicit user decision. */
  requiresApproval: boolean
}

/** Request accepted by `define`; it never crosses the Remote transport. */
export interface DynamicCordisDefineRequest {
  /** Session that owns the plugin. */
  sessionId: SessionId
  /** Create a plugin or append to an existing one. */
  plugin:
    | { kind: 'new'; idPrefix: string }
    | { kind: 'existing'; pluginId: CordisDynamicPluginId }
  /** Package label. */
  name: string
  /** User-facing purpose. */
  purpose: string
  /** At least one source half. */
  code: { host?: string; client?: string }
}

/** Successful `define` result. */
export interface DynamicCordisDefineReceipt {
  pluginId: CordisDynamicPluginId
  packageId: CordisDynamicPackageId
  name: string
  purpose: string
  hasHostHalf: boolean
  hasClientHalf: boolean
}

/** Source-free modification context for an explicit `@pluginId` reference. */
export interface DynamicCordisReference {
  pluginId: CordisDynamicPluginId
  packageId: CordisDynamicPackageId
  name: string
  purpose: string
  currentPackageId?: CordisDynamicPackageId
  nextPackageId?: CordisDynamicPackageId
  activeRun?: { pluginRunId: CordisDynamicPluginRunId; packageId: CordisDynamicPackageId }
  latestRun?: DynamicCordisRunAttempt
}

/** Source-free Plugin summary returned by layered self inspection. */
export interface DynamicCordisPluginInspection extends DynamicCordisReference {
  /** Immutable Package summaries in define order. */
  packages: Array<{
    packageId: CordisDynamicPackageId
    name: string
    purpose: string
    hasHostHalf: boolean
    hasClientHalf: boolean
  }>
}

/** Exact immutable Package metadata and source returned by explicit inspection. */
export interface DynamicCordisPackageInspection extends DynamicCordisReference {
  /** Host and Client function bodies stored for this Package. */
  code: { host?: string; client?: string }
}

/** Registry, identity mints, and pending approval index. */
export class DynamicCordisRegistry {
  private readonly plugins = new Map<CordisDynamicPluginId, DynamicCordisPlugin>()
  private readonly pendingRequests = new Map<ApprovalRequestId, DynamicCordisPendingRequest>()
  private nextPlugin = 1
  private nextPackage = 1
  private nextRun = 1
  private nextApproval = 1

  /**
   * Mint a semantic plugin ID without reusing a prior suffix.
   * @param prefix - validated lowercase semantic prefix proposed by the model.
   * @returns a process-unique Plugin ID.
   */
  mintPluginId(prefix: string): string {
    let id: CordisDynamicPluginId
    do id = brandString<CordisDynamicPluginId>(`${prefix}-${this.nextPlugin++}`)
    while (this.plugins.has(id))
    return id
  }

  /**
   * Mint an immutable package ID.
   * @returns a process-unique Package ID.
   */
  mintPackageId(): string {
    return `pkg-${this.nextPackage++}`
  }

  /**
   * Mint an activation ID.
   * @returns a process-unique Plugin Run ID.
   */
  mintPluginRunId(): string {
    return `run-${this.nextRun++}`
  }

  /**
   * Mint an approval ID.
   * @returns a process-unique approval request ID.
   */
  mintApprovalRequestId(): string {
    return `approval-${this.nextApproval++}`
  }

  /**
   * Add one stable plugin.
   * @param plugin - Plugin record to retain under its stable ID.
   */
  add(plugin: DynamicCordisPlugin): void {
    this.plugins.set(plugin.pluginId, plugin)
  }

  /**
   * Read one plugin.
   * @param id - stable Plugin ID.
   * @returns the Plugin record, or `undefined` when absent.
   */
  get(id: CordisDynamicPluginId): DynamicCordisPlugin | undefined {
    return this.plugins.get(id)
  }

  /**
   * Delete one plugin and all package versions.
   * @param id - stable Plugin ID to remove.
   * @returns whether a Plugin record was removed.
   */
  delete(id: CordisDynamicPluginId): boolean {
    return this.plugins.delete(id)
  }

  /**
   * Read all plugins in creation order.
   * @returns a snapshot of every Plugin record.
   */
  all(): DynamicCordisPlugin[] {
    return [...this.plugins.values()]
  }

  /**
   * Read one session's plugins in creation order.
   * @param sessionId - owning session to filter by.
   * @returns a snapshot of matching Plugin records.
   */
  ofSession(sessionId: SessionId): DynamicCordisPlugin[] {
    return this.all().filter(plugin => plugin.sessionId === sessionId)
  }

  /**
   * Publish one pending approval.
   * @param id - approval request ID.
   * @param pending - resolver and Plugin metadata retained until settlement.
   */
  armRequest(id: ApprovalRequestId, pending: DynamicCordisPendingRequest): void {
    this.pendingRequests.set(id, pending)
  }

  /**
   * Read one pending approval without claiming it.
   * @param id - approval request ID.
   * @returns the pending request, or `undefined` when absent.
   */
  peekRequest(id: ApprovalRequestId): DynamicCordisPendingRequest | undefined {
    return this.pendingRequests.get(id)
  }

  /**
   * Claim one pending approval; first answer wins.
   * @param id - approval request ID.
   * @returns the claimed request, or `undefined` when already settled.
   */
  claimRequest(id: ApprovalRequestId): DynamicCordisPendingRequest | undefined {
    const pending = this.pendingRequests.get(id)
    if (pending !== undefined) this.pendingRequests.delete(id)
    return pending
  }

  /**
   * Cancel one pending approval.
   * @param id - approval request ID to remove.
   */
  disarmRequest(id: ApprovalRequestId): void {
    this.pendingRequests.delete(id)
  }

  /**
   * Find a pending approval for one Plugin.
   * @param pluginId - stable Plugin ID.
   * @returns its approval request ID, or `undefined` when none is pending.
   */
  pendingRequestFor(pluginId: CordisDynamicPluginId): ApprovalRequestId | undefined {
    for (const [requestId, request] of this.pendingRequests) {
      if (request.pluginId === pluginId) return requestId
    }
    return undefined
  }
}
