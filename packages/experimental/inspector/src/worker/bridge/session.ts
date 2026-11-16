/** Shared cleanup delivery for Worker-owned Client sessions. */

import type { ClientRuntimeSessionClosedFrame } from '../../shared/bridge/messages/runtime/index.ts'
import type { ClientSourceSessionClosedFrame } from '../../shared/bridge/messages/sources/index.ts'
import type { InspectorSourceDescriptor } from '../../shared/bridge/messages/observation.ts'
import type { InspectorSourceRegistry } from './hub.ts'

type ClientSessionClosedFrame = ClientRuntimeSessionClosedFrame | ClientSourceSessionClosedFrame

/**
 * Send cleanup to an active Client generation when its transport is still usable.
 * @param sources - Worker source registry owning the transport.
 * @param source - Generation whose session closed.
 * @param frame - Typed Runtime or source-catalog cleanup frame.
 */
export function sendClientSessionClosed(
  sources: InspectorSourceRegistry,
  source: InspectorSourceDescriptor,
  frame: ClientSessionClosedFrame,
): void {
  try {
    sources.send(source, frame)
  } catch (_sourceClosed) {
    // Source removal already invalidates every session owned by this generation.
  }
}
