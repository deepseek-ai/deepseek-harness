/**
 * Types for the TypeScript SDK client: launch options, notification shapes,
 * and owned activity results.
 *
 * @module @deepseek-ai/dsh-sdk-client/types
 */

import type { ContentBlock, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SdkPromptContentBlock, SdkUserQuestionResult, SdkUserQuestionRequest } from '@deepseek-ai/dsh-sdk-protocol'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One server-to-client notification as received off the wire. */
export interface HarnessNotification {
  /** The JSON-RPC notification method name. */
  method: string
  /** The raw params object; see `HarnessSdkNotificationMap` for the shapes per method. */
  params: Record<string, unknown>
}

/** Predicate deciding whether a subscription receives a notification. */
export type NotificationFilter = (notification: HarnessNotification) => boolean

/** Launch and timeout options for {@link HarnessClient}. */
export interface HarnessClientOptions {
  /** Answer or dismiss runtime questions; observe the signal to release host work on runtime cancellation. */
  onUserQuestion?: (request: SdkUserQuestionRequest, context: { signal: AbortSignal }) => Promise<SdkUserQuestionResult>
  /** Absolute or caller-relative dsh CLI module; omitted resolves this package's same-version dependency. */
  dshBin?: string
  /** Named profile serving the SDK protocol (default `sdk`). */
  profile?: string
  /** Ordered per-launch profile patches; relative paths resolve before spawn. */
  patches?: string[]
  /** Explicit Harness home for this child; relative paths resolve before spawn. */
  dshHome?: string
  /** Working directory for the dsh process itself. */
  processCwd?: string
  /**
   * The complete child environment, read when {@link HarnessClient.start}
   * spawns. `undefined` reads the parent env at that time; passing an object
   * reads that object at spawn and replaces the parent environment entirely, so callers own
   * credential policy (see `scrubbedParentEnv` in `@deepseek-ai/dsh-subprocess`
   * for the shared scrub-then-merge base).
   */
  env?: NodeJS.ProcessEnv
  /** Bound (ms) on the initial profile handshake (default 10000). */
  initializeTimeoutMs?: number
  /** Per-request timeout (ms); `undefined` waits indefinitely (a turn can legitimately run long). */
  requestTimeoutMs?: number
  /** Bound (ms) on the protocol `shutdown` exchange inside `close()` (default 1000). */
  shutdownTimeoutMs?: number
  /** Grace (ms) for the runtime's stdin-EOF quiesce during `close()` (default 6000). */
  disposeEofGraceMs?: number
  /** Termination confirmation window (ms) after SIGTERM/SIGKILL during `close()` (default 3000). */
  disposeGraceMs?: number
}

/** Options for the high-level {@link DeepSeekHarness} wrapper. */
export interface DeepSeekHarnessOptions extends HarnessClientOptions {
  /** Workspace cwd recorded on every SDK-created session (default: the process cwd, else `process.cwd()`). */
  cwd?: string
  /** Provider route for SDK-created agents (default `deepseek-official`). */
  provider?: string
  /** Model for SDK-created agents (default `deepseek-v4-flash`). */
  model?: string
  /** Adapter-owned reasoning effort for the selected provider/model route. */
  reasoningEffort?: ReasoningEffortId
  /** Maximum output tokens for each conversation-model request. */
  maxTokens?: number
  /** Enable server approval requests; install client.onRequest() after client.start() and before harness.start(). */
  approvalRequests?: boolean
}

/** Result of one SDK input, including the model activity or native operation it owns. */
export interface RunResult {
  /** The session the activity ran on. */
  sessionId: string
  /** Final assistant text (empty when absent), native state-only result text, or a failure diagnostic. */
  finalResponse: string
  /** Model turn ending or native operation outcome; null when no terminal reason was recorded. */
  finishReason: string | null
  /** Every `session.event` payload for the root session, in wire order. */
  events: SessionEvent[]
  /** Every notification for the root session and discovered descendants, in wire order. */
  notifications: HarnessNotification[]
}

/** Re-exported content-block alias so SDK callers need no extra import. */
export type { ContentBlock }
export type { SdkPromptContentBlock }
export type { SdkEncodedImageBlock } from '@deepseek-ai/dsh-sdk-protocol'
export type { SdkUserQuestionAnswer, SdkUserQuestionResult, SdkUserQuestionRequest } from '@deepseek-ai/dsh-sdk-protocol'
