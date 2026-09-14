/**
 * The slice of the Client Remote this package calls: the generated
 * `workspaceFiles` methods by name, and the stream supervisor structurally, so
 * the feed and the provider are testable against a scripted face.
 */
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
// Merges the generated `workspaceFiles` namespace into the Remote face.
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'

/** One item of a supervised stream; `accept` marks the delivering generation as healthy. */
export interface SupervisedStreamItem<Item> {
  /** The decoded frame. */
  readonly value: Item
  /** Reset the reconnect backoff: this generation is delivering. */
  accept(): void
}

/** A reconnecting single-consumer stream the Remote supervises. */
export interface SupervisedStream<Item> extends AsyncIterable<SupervisedStreamItem<Item>> {
  /**
   * Stop the stream for good.
   * @returns once the active generation and the consumer iterator are closed.
   */
  dispose(): Promise<void>
}

/** What one supervised stream needs from its owner. */
export interface SupervisedStreamOptions<Item> {
  /** Diagnostic owner name. */
  readonly name: string
  /** Open one physical generation; `signal` aborts it. */
  readonly open: (signal: AbortSignal) => AsyncIterable<Item>
  /** The error a generation's normal end amounts to; a carrier error asks for a reopen, anything else is terminal. */
  readonly ended: (accepted: boolean) => Error
}

/** The `workspaceFiles` namespace methods this package calls, as the generated Remote declares them. */
export type WorkspaceFilesNamespace = Pick<ClientRemote['workspaceFiles'], 'stat' | 'changes'>

/** The Client Remote as this package sees it. */
export interface WorkspaceFilesRemote {
  /**
   * Create one reconnecting stream.
   * @param options - opener and end classification.
   * @returns the supervised stream, unstarted until iterated.
   */
  $stream<Item>(options: SupervisedStreamOptions<Item>): SupervisedStream<Item>
  /** The `workspaceFiles` namespace. */
  readonly workspaceFiles: WorkspaceFilesNamespace
}
