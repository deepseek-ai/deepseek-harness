/**
 * Client-safe wire vocabulary of the dynamic Cordis plugin runner.
 * @module @deepseek-ai/dsh-cordis-host-runner/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Stable identity of one dynamic plugin instance. */
export type CordisDynamicPluginId = Branded<'CordisDynamicPluginId'>

/** Identity of one immutable package version belonging to a dynamic plugin. */
export type CordisDynamicPackageId = Branded<'CordisDynamicPackageId'>

/** Identity of one successful activation attempt. */
export type CordisDynamicPluginRunId = Branded<'CordisDynamicPluginRunId'>

/** Identity of one human approval request. */
export type ApprovalRequestId = Branded<'ApprovalRequestId'>

/** Identity of one cross-page inspect query. */
export type CordisInspectRequestId = Branded<'CordisInspectRequestId'>

/** Runtime plane that owns an inspect provider. */
export type CordisInspectPlatform = 'host' | 'client'

/** One model-callable read-only query exposed by an inspect provider. */
export interface CordisInspectMethodManifest {
  /** Method name, unique within its provider. */
  name: string
  /** What the query returns and when to use it. */
  description: string
  /** JSON Schema accepted by the query. */
  inputSchema: JsonValue
  /** JSON Schema produced by the query. */
  outputSchema: JsonValue
}

/** Serializable directory entry for one inspect provider. */
export interface CordisInspectProviderManifest {
  /** Provider identity, unique within one platform. */
  id: string
  /** Capability described by this provider. */
  description: string
  /** Explicit read-only queries. */
  methods: readonly CordisInspectMethodManifest[]
}

/** Provider directory row returned by `cordis_inspect_list`. */
export interface CordisInspectProviderView extends CordisInspectProviderManifest {
  /** Runtime plane that executes these methods. */
  platform: CordisInspectPlatform
}

/** Host broadcast requesting one live Client inspect result. */
export interface CordisInspectQueryRequest {
  /** Correlation identity. */
  requestId: CordisInspectRequestId
  /** Session whose model requested the query. */
  agentId: SessionId
  /** Provider selected from the Client manifest. */
  provider: string
  /** Method selected from the provider manifest. */
  method: string
  /** JSON query input, omitted when the method has no fields. */
  input?: JsonValue
}

/** Result sent from a Client provider to the waiting Host query. */
export type CordisInspectQueryResolution =
  | { ok: true; data: JsonValue }
  | {
    ok: false
    reason: 'provider-missing' | 'method-missing' | 'invalid-input' | 'provider-error' | 'cancelled'
    message: string
  }

/** Notification that a Client inspect request can no longer be answered. */
export interface CordisInspectQueryResolved {
  /** Query that left the pending state. */
  requestId: CordisInspectRequestId
}

/** Whether a Client answer claimed the still-pending query. */
export interface CordisInspectResolveAck {
  /**
   * True only for a valid success that settles the query;
   * false for retained failures and unknown, timed out, cancelled, or late answers.
   */
  accepted: boolean
}

/** Whether a package starts the current version or replaces it. */
export type CordisDynamicRunMode = 'run' | 'update'

/** How a model-driven Client activation request left the pending state. */
export type RequestRunOutcome = 'approved' | 'completed' | 'rejected' | 'cancelled' | 'failed'

/** Error fields preserved across the Host/Client transport. */
export interface CordisErrorDetails {
  /** Original error message. */
  message: string
  /** Original stack when the thrown value supplied one. */
  stack?: string
}

/** Persisted state of the latest activation attempt. */
export type CordisRunStatus =
  | 'awaiting-approval'
  | 'starting-host'
  | 'client-pending'
  | 'running'
  | 'waiting'
  | 'rejected'
  | 'failed'
  | 'cancelled'
  | 'stopped'

/** One platform half within an activation attempt. */
export interface CordisHalfState {
  /** Lifecycle state of this half. */
  status: 'absent' | 'pending' | 'stopped' | 'running' | 'waiting' | 'failed'
  /** Services still needed by a successfully created Fiber. */
  waitingFor: readonly string[]
  /** Failure text for this half. */
  error?: string
}

/** Structured failure associated with an exact activation attempt. */
export interface CordisRunDiagnostic {
  /** Stage that failed. */
  phase: 'approval' | 'host-load' | 'host-apply' | 'client-load' | 'client-apply' | 'client-render'
  /** Original failure text. */
  message: string
  /** Original failure stack when available. */
  stack?: string
  /** Stable Plugin identity. */
  pluginId: CordisDynamicPluginId
  /** Immutable Package identity. */
  packageId: CordisDynamicPackageId
  /** Exact attempt identity. */
  pluginRunId: CordisDynamicPluginRunId
}

/** Latest activation attempt retained independently from the physical run. */
export interface DynamicCordisRunAttempt {
  /** Exact attempt identity. */
  pluginRunId: CordisDynamicPluginRunId
  /** Target Package. */
  packageId: CordisDynamicPackageId
  /** Explicit run/update intent. */
  mode: CordisDynamicRunMode
  /** Current attempt state. */
  status: CordisRunStatus
  /** Pending Client activation request; it represents approval only when `requiresApproval` is true. */
  approvalRequestId?: ApprovalRequestId
  /** Whether the pending Client activation requires a user decision. */
  requiresApproval?: boolean
  /** Host-half state. */
  host: CordisHalfState
  /** Client-half state. */
  client: CordisHalfState
  /** Most recent failure. */
  error?: CordisRunDiagnostic
}

/** One running package announced to browser pages. */
export interface DynamicCordisPackage {
  /** Stable plugin instance. */
  pluginId: CordisDynamicPluginId
  /** Immutable package version currently active. */
  packageId: CordisDynamicPackageId
  /** This activation's identity. */
  pluginRunId: CordisDynamicPluginRunId
  /** Package label. */
  name: string
}

/** One pending model-driven Client activation forwarded to browser pages. */
export interface DynamicCordisRunRequest {
  /** Correlation identity of the activation request. */
  requestId: ApprovalRequestId
  /** Session whose plugin and tool call own the request. */
  agentId: SessionId
  /** Stable plugin instance being acted on. */
  pluginId: CordisDynamicPluginId
  /** Package version the request will activate. */
  packageId: CordisDynamicPackageId
  /** Explicit lifecycle intent. */
  mode: CordisDynamicRunMode
  /** Package label. */
  name: string
  /** User-facing reason supplied at define time. */
  purpose: string
  /** Whether a page must wait for an explicit user decision before activation. */
  requiresApproval: boolean
}

/** One settled model-driven Client activation request broadcast to all pages. */
export interface DynamicCordisRequestResolved {
  /** Request that left the pending state. */
  requestId: ApprovalRequestId
  /** How the request settled. */
  outcome: RequestRunOutcome
}

/** One activation withdrawn from every page. */
export interface DynamicCordisRetracted {
  /** Stable plugin instance. */
  pluginId: CordisDynamicPluginId
  /** Package version that was active. */
  packageId: CordisDynamicPackageId
  /** Exact activation being withdrawn. */
  pluginRunId: CordisDynamicPluginRunId
}

/** Package metadata exposed by the inventory without source code. */
export interface DynamicCordisInventoryPackage {
  /** Immutable package version. */
  packageId: CordisDynamicPackageId
  /** Package label. */
  name: string
  /** User-facing purpose. */
  purpose: string
  /** Whether this version contains Host code. */
  hasHostHalf: boolean
  /** Whether this version contains Client code. */
  hasClientHalf: boolean
}

/** One stable plugin row in the frame-wide inventory. */
export interface DynamicCordisInventoryRow {
  /** Stable plugin instance. */
  pluginId: CordisDynamicPluginId
  /** Session that owns this plugin. */
  agentId: SessionId
  /** Immutable versions in define order. */
  packages: readonly DynamicCordisInventoryPackage[]
  /** Last package that completed activation successfully. */
  currentPackageId?: CordisDynamicPackageId
  /** Package selected for a failed or in-progress transition. */
  nextPackageId?: CordisDynamicPackageId
  /** Current activation, absent while stopped. */
  activeRun?: {
    pluginRunId: CordisDynamicPluginRunId
    packageId: CordisDynamicPackageId
  }
  /** Latest activation attempt, including pending approval and diagnostics. */
  latestRun?: DynamicCordisRunAttempt
}

/** Answer to removing a plugin and all of its package versions. */
export type DynamicCordisUndefineReceipt =
  | { ok: true; wasRunning: boolean }
  | { ok: false; reason: 'plugin-missing'; message: string }

/** One render failure observed after a Client half loaded. */
export interface DynamicCordisRenderFailure {
  /** Slot whose component failed. */
  slot: string
  /** Render failure text. */
  message: string
  /** Original render failure stack when available. */
  stack?: string
  /** Whether the failing contribution relinquished its slot. */
  abdicated: boolean
}

/** Result shared by model-driven and panel-driven activation. */
export type DynamicCordisRunResponse =
  | {
    ok: true
    /** Whether activation completed synchronously, is starting in a Client, or awaits user approval. */
    status: 'awaiting-approval' | 'starting' | 'running'
    pluginId: CordisDynamicPluginId
    packageId: CordisDynamicPackageId
    pluginRunId: CordisDynamicPluginRunId
    /** Missing Host services; a parked Fiber is a successful activation. */
    waitingFor: readonly string[]
    /** Missing Client services reported by the approving page. */
    clientWaitingFor?: readonly string[]
    /** Last fully successful Package. */
    currentPackageId?: CordisDynamicPackageId
    /** Selected transition target. */
    nextPackageId?: CordisDynamicPackageId
    /** Explicit lifecycle intent. */
    mode: CordisDynamicRunMode
  }
  | {
    ok: false
    reason:
      | 'plugin-missing'
      | 'package-missing'
      | 'invalid-mode'
      | 'transition-in-flight'
      | 'host-half-failed'
      | 'client-half-failed'
      | 'rejected'
      | 'cancelled'
      | 'not-running'
    message: string
    /** Original failure stack when available. */
    stack?: string
  }

/** Result of stopping a Plugin without deleting its Packages. */
export type DynamicCordisStopResponse =
  | { ok: true }
  | { ok: false; reason: 'plugin-missing' | 'not-running'; message: string }

/** Result of bringing up the Host half before loading the Client half. */
export type DynamicCordisHostHalfResult =
  | {
    ok: true
    pluginId: CordisDynamicPluginId
    packageId: CordisDynamicPackageId
    pluginRunId: CordisDynamicPluginRunId
    waitingFor: readonly string[]
    /** False when a panel merely attaches this page to an already active run. */
    startedHere: boolean
  }
  | ({ ok: false } & CordisErrorDetails)

/** Client-half source for one exact activation. */
export interface DynamicCordisClientSource {
  /** Browser JavaScript body. */
  code: string
  /** Package label. */
  name: string
  /** Stable plugin instance. */
  pluginId: CordisDynamicPluginId
  /** Immutable source version. */
  packageId: CordisDynamicPackageId
  /** Exact activation the source belongs to. */
  pluginRunId: CordisDynamicPluginRunId
}

/** Browser verdict used for both approved tool runs and panel runs. */
export type DynamicCordisRunResolution =
  | { ok: true; pluginRunId: CordisDynamicPluginRunId; waitingFor?: readonly string[] }
  | {
    ok: false
    reason: 'rejected' | 'host-half-failed' | 'client-half-failed'
    /** Activation that failed; absent for a refusal before activation. */
    pluginRunId?: CordisDynamicPluginRunId
    /** Whether this page created the failed activation instead of attaching to it. */
    startedHere?: boolean
    message?: string
    stack?: string
  }

/** Whether a Client activation resolution reached the still-pending request. */
export interface DynamicCordisResolveAck {
  /** False for late, unknown, or stale answers. */
  accepted: boolean
}

/** Result of routing one Client call to the active Host half. */
export type DynamicCordisInvokeResult =
  | { ok: true; value: JsonValue }
  | ({ ok: false; code: 'plugin-not-running' | 'stale-run' | 'method-not-found' | 'handler-error' } & CordisErrorDetails)

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A Client-bearing activation needs a browser page, and may require a user decision.
     * @param request - correlation identity, owner, target version, mode, and approval requirement.
     * @mode emit
     */
    'cordis/request-run'(request: DynamicCordisRunRequest): void
    /**
     * A pending Client activation request left the answerable state.
     * @param resolved - request identity and outcome.
     * @mode emit
     */
    'cordis/request-run-resolved'(resolved: DynamicCordisRequestResolved): void
    /**
     * One exact Plugin/Package activation is now live in the Host.
     * @param pkg - stable plugin, immutable package, run identity, and label.
     * @mode emit
     */
    'cordis/dynamic-package'(pkg: DynamicCordisPackage): void
    /**
     * One exact activation was withdrawn.
     * @param retracted - plugin, package, and run identity.
     * @mode emit
     */
    'cordis/dynamic-retract'(retracted: DynamicCordisRetracted): void
    /**
     * Request a live read-only query from the Client inspect registry.
     * @param request - correlation, Session, provider, method, and JSON input.
     * @mode emit
     */
    'cordis/inspect-query'(request: CordisInspectQueryRequest): void
    /**
     * Notify every Client that an inspect query has settled or been cancelled.
     * @param resolved - exact query identity that is no longer answerable.
     * @mode emit
     */
    'cordis/inspect-query-resolved'(resolved: CordisInspectQueryResolved): void
  }
}
