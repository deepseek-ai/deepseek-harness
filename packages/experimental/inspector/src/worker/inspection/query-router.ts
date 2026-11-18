/** Worker-side admission, execution, and bounded settlement of non-CDP queries. */

import type { CordisRuntimeTreeReader } from '../../shared/cordis/reader.ts'
import type { InspectorSourceGeneration, InspectorSourceId } from '../../shared/bridge/ids.ts'
import { jsonByteLength, type InspectorJsonValue } from '../../shared/json.ts'
import type { InspectorSourceDescriptor } from '../../shared/bridge/messages/observation.ts'
import type { InspectorQueryError } from '../../shared/bridge/messages/query/commands.ts'
import {
  isInspectorQueryRequestEnvelope,
  parseInspectorQueryFrameIdentity,
  parseInspectorQueryRequestFrame,
} from '../../shared/bridge/messages/query/codec.ts'
import type {
  InspectorQueryRequestFrame,
  InspectorQueryRequestId,
  InspectorQueryResponseFrame,
} from '../../shared/bridge/messages/query/frames.ts'
import { INSPECTOR_PROTOCOL_VERSION } from '../../shared/bridge/version.ts'
import { executeInspectorQuery } from './cordis-query.ts'

/** Carrier operations owned by one Worker query peer. */
export interface InspectorQueryPeerTransport {
  /** Send one bounded Worker response. */
  send(frame: InspectorQueryResponseFrame): void
  /** Reject a malformed peer whose request cannot be correlated safely. */
  close(code: number, reason: string): void
}

interface AcceptedGeneration {
  readonly sourceId: InspectorSourceId
  readonly generation: InspectorSourceGeneration
}

/** Creates isolated query peers over one shared semantic reader. */
export class InspectorQueryRouter {
  private readonly peers = new Set<InspectorQueryPeer>()
  private readonly activeBySource = new Map<InspectorSourceId, {
    readonly generation: InspectorSourceGeneration
    readonly peer: InspectorQueryPeer
  }>()

  constructor(
    private readonly reader: CordisRuntimeTreeReader,
    private readonly maxFrameBytes: number,
  ) {}

  /**
   * Create query state for one Host MessagePort or Client WebSocket.
   * @param transport - Carrier response and rejection operations.
   * @returns The peer that receives frames from this carrier only.
  */
  open(transport: InspectorQueryPeerTransport): InspectorQueryPeer {
    const peer: InspectorQueryPeer = new InspectorQueryPeer(
      this.reader,
      this.maxFrameBytes,
      transport,
      (accepted) => {
        for (const [sourceId, active] of this.activeBySource) {
          if (active.peer === peer) this.activeBySource.delete(sourceId)
        }
        this.activeBySource.set(accepted.sourceId, { ...accepted, peer })
      },
      (accepted): boolean => this.activeBySource.get(accepted.sourceId)?.peer === peer
        && this.activeBySource.get(accepted.sourceId)?.generation === accepted.generation,
      () => {
        this.peers.delete(peer)
        for (const [sourceId, active] of this.activeBySource) {
          if (active.peer === peer) this.activeBySource.delete(sourceId)
        }
      },
    )
    this.peers.add(peer)
    return peer
  }

  /**
   * Revoke query access when the source registry closes one generation.
   * @param source - Closed source generation.
   */
  disconnect(source: InspectorSourceDescriptor): void {
    const active = this.activeBySource.get(source.sourceId)
    if (active?.generation !== source.generation) return
    this.activeBySource.delete(source.sourceId)
    active.peer.revoke(source.sourceId, source.generation)
  }

  /** Revoke every peer during Worker shutdown. */
  close(): void {
    for (const peer of [...this.peers]) peer.close()
    this.activeBySource.clear()
  }
}

/** Query protocol state associated with exactly one source carrier. */
export class InspectorQueryPeer {
  private accepted: AcceptedGeneration | undefined
  private readonly inFlight = new Map<InspectorQueryRequestId, AcceptedGeneration>()
  private closed = false

  constructor(
    private readonly reader: CordisRuntimeTreeReader,
    private readonly maxFrameBytes: number,
    private readonly transport: InspectorQueryPeerTransport,
    private readonly register: (accepted: AcceptedGeneration) => void,
    private readonly isRegistered: (accepted: AcceptedGeneration) => boolean,
    private readonly unregister: () => void,
  ) {}

  /**
   * Admit the source generation after the source registry accepts it.
   * @param sourceId - Stable source identity.
   * @param generation - Active carrier generation.
   */
  accept(sourceId: InspectorSourceId, generation: InspectorSourceGeneration): void {
    if (this.closed) return
    this.accepted = { sourceId, generation }
    this.inFlight.clear()
    this.register(this.accepted)
  }

  /**
   * Revoke one generation while leaving its carrier available for a later source/open.
   * @param sourceId - Stable source identity.
   * @param generation - Generation being removed by the source registry.
   */
  revoke(sourceId: InspectorSourceId, generation: InspectorSourceGeneration): void {
    if (this.accepted?.sourceId !== sourceId || this.accepted.generation !== generation) return
    this.accepted = undefined
    this.inFlight.clear()
  }

  /**
   * Consume a decoded carrier value when it belongs to the query protocol.
   * @param value - Untrusted source-to-Worker value.
   * @returns Whether this peer owned the value.
   */
  receive(value: unknown): boolean {
    if (!isInspectorQueryRequestEnvelope(value)) return false
    let frame: InspectorQueryRequestFrame
    try {
      frame = parseInspectorQueryRequestFrame(value)
      if (jsonByteLength(frame as unknown as InspectorJsonValue) > this.maxFrameBytes) {
        throw new Error(`inspector protocol: query request exceeds ${String(this.maxFrameBytes)} bytes`)
      }
    } catch (error) {
      this.rejectMalformed(value, renderError(error))
      return true
    }
    const accepted = this.accepted
    if (this.closed || accepted === undefined || !this.isRegistered(accepted)
      || accepted.sourceId !== frame.sourceId
      || accepted.generation !== frame.generation) {
      this.sendFailure(frame, 'stale-source', 'Inspector query does not belong to the accepted source generation')
      return true
    }
    if (this.inFlight.has(frame.requestId)) {
      this.sendFailure(frame, 'invalid-request', 'Inspector query requestId is already in flight')
      return true
    }
    this.inFlight.set(frame.requestId, accepted)
    void this.execute(frame, accepted)
    return true
  }

  /** Stop this peer and suppress completion from in-flight readers. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.accepted = undefined
    this.inFlight.clear()
    this.unregister()
  }

  private async execute(frame: InspectorQueryRequestFrame, accepted: AcceptedGeneration): Promise<void> {
    try {
      const result = await executeInspectorQuery(this.reader, frame.query)
      if (!this.canReply(frame, accepted)) return
      const response: InspectorQueryResponseFrame = {
        v: INSPECTOR_PROTOCOL_VERSION,
        t: 'query/response',
        sourceId: frame.sourceId,
        generation: frame.generation,
        requestId: frame.requestId,
        outcome: { ok: true, result },
      }
      if (jsonByteLength(response as unknown as InspectorJsonValue) > this.maxFrameBytes) {
        this.sendFailure(frame, 'result-too-large', `Inspector query result exceeds ${String(this.maxFrameBytes)} bytes`)
        return
      }
      this.deliver(response)
    } catch (error) {
      if (this.canReply(frame, accepted)) this.sendFailure(frame, 'internal-error', renderError(error).message)
    } finally {
      if (this.inFlight.get(frame.requestId) === accepted) this.inFlight.delete(frame.requestId)
    }
  }

  private rejectMalformed(value: unknown, error: Error): void {
    try {
      const identity = parseInspectorQueryFrameIdentity(value)
      this.sendFailure(identity, 'invalid-request', error.message)
    } catch {
      this.rejectTransport(1008, error.message)
    }
  }

  private sendFailure(
    frame: Pick<InspectorQueryRequestFrame, 'sourceId' | 'generation' | 'requestId'>,
    code: InspectorQueryError['code'],
    message: string,
  ): void {
    if (this.closed) return
    const response: InspectorQueryResponseFrame = {
      v: INSPECTOR_PROTOCOL_VERSION,
      t: 'query/response',
      sourceId: frame.sourceId,
      generation: frame.generation,
      requestId: frame.requestId,
      outcome: { ok: false, error: { code, message } },
    }
    if (jsonByteLength(response as unknown as InspectorJsonValue) > this.maxFrameBytes) {
      this.rejectTransport(1009, 'Inspector query error exceeds the frame limit')
      return
    }
    this.deliver(response)
  }

  private canReply(frame: InspectorQueryRequestFrame, accepted: AcceptedGeneration): boolean {
    return !this.closed
      && this.accepted === accepted
      && this.isRegistered(accepted)
      && this.inFlight.get(frame.requestId) === accepted
  }

  private deliver(frame: InspectorQueryResponseFrame): void {
    try {
      this.transport.send(frame)
    } catch (error) {
      this.rejectTransport(1011, renderError(error).message)
    }
  }

  private rejectTransport(code: number, reason: string): void {
    this.close()
    try {
      this.transport.close(code, reason.slice(0, 123))
    } catch (_transportUnusable) {
      // The carrier is already unusable; query state has reached quiescence.
    }
  }
}

function renderError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
