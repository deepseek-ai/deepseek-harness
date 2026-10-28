/** IPC frames between the owner host plugin and its one tunnel worker, plus the Relay wire frames. */

import type { Branded } from '@deepseek-ai/dsh-brand'

export * from './viewer-states.ts'

/** Worker-issued identity for one request; never reused across sockets or worker processes. */
export type TunnelRequestToken = Branded<'TunnelRequestToken'>

/** Supervisor-issued UUID for one logical add; retained on process restart, invalidated by removal. Never sent to the Relay. */
export type TunnelRegistrationToken = Branded<'TunnelRegistrationToken'>

/** Relay wire version; Host/worker IPC ships together and is not negotiated by this number. */
export const LIVESHARE_PROTOCOL_VERSION = 1

/**
 * Optional behaviors this build offers the Relay, beyond the frames themselves.
 *
 * A peer that declares none is a build older than this one. Each name states behavior the peer can
 * observe on the wire, so a Relay relies only on what it has been told rather than on the release it
 * happens to run beside.
 */
export const LIVESHARE_CAPABILITIES = [
  'session-mode',
  'fork',
  'acl-subjects',
  'expiry',
  'owner-credential',
  'scoped-rpc-response',
  'unsupported-frame-refusal',
  'share-access-state',
  'actor-credential',
  'direct-connection',
] as const

/** One optional behavior this build offers the Relay; a peer compiles against the names it knows. */
export type LiveshareCapability = typeof LIVESHARE_CAPABILITIES[number]

/**
 * The permission facts a share publishes.
 *
 * The owner asks for them in {@link TunnelShareSpec}; the Relay commits them in
 * {@link ShareAccessStateFrame}. The committed frame is the authority: a reader follows it, not the
 * request that produced it.
 */
export interface SharePermissions {
  readonly accessMode: 'open' | 'selected'
  readonly allowedSubjectIds: readonly string[]
  readonly sessionMode?: 'view' | 'write'
  readonly allowsFork?: boolean
  readonly expiresAt?: string
}

/** One share the owner host asks its gateway worker to carry to the Relay. */
export interface TunnelShareSpec extends SharePermissions {
  /** How a viewer reaches the owner; absent reads as `{ mode: 'relay' }`, today's only shape. */
  readonly connection?: ShareConnection
  readonly shareId: string
  readonly sessionId: string
  /** Display-only share title; the host refreshes it with `reconcileShareTitles()` when renamed. */
  readonly sessionTitle: string
  readonly accessMode: 'open' | 'selected'
  readonly relay: string
  readonly gatewayToken: string
  readonly ownerProviderId?: string
  readonly ownerTenantId?: string
  readonly ownerDisplayName: string
  /** Display-only: the owner's DSH version shown on the Relay share picker. */
  readonly dshVersion?: string
  /**
   * Stable id of the owner DSH instance that published this share. Not display-only: the Relay groups
   * shares of the same owner instance by it.
   */
  readonly ownerInstanceId?: string
  /**
   * Whether this share lets an admitted viewer fork it.
   *
   * Its own switch, independent of {@link TunnelShareSpec.sessionMode}: a view-tier share may allow
   * forking and a writable one may refuse it. Absent means no forking.
   */
  readonly allowsFork?: boolean
  /**
   * Tier this share was created with.
   *
   * `view` reads the shared Session and drives its loop inside the granted workspace without writing it;
   * `write` also modifies the files inside that workspace. Absent reads as `view`.
   */
  readonly sessionMode?: 'view' | 'write'
  /**
   * Relay-issued owner credential proving which logged-in subject publishes this share. The Relay
   * refuses a new share without it and ignores self-reported identity fields when it is present.
   */
  readonly ownerCredential?: string
  readonly allowedSubjectIds: readonly string[]
  /** ISO time after which the Relay denies viewers; absent means the share never expires. */
  readonly expiresAt?: string
}

/** Commands sent from the owner host plugin to its tunnel worker. */
export type TunnelWorkerCommand =
  | { readonly type: 'add-share'; readonly registrationToken: TunnelRegistrationToken; readonly share: TunnelShareSpec }
  | { readonly type: 'remove-share'; readonly shareId: string }
  | {
    readonly type: 'share-rpc-response'
    readonly registrationToken: TunnelRegistrationToken
    /** Echo the request's token; Relay ids alone do not identify an IPC request. */
    readonly token: TunnelRequestToken
    readonly id: number
    readonly shareId: string
    readonly status: number
    readonly body?: unknown
  }
  | { readonly type: 'shutdown' }

interface TunnelRegistrationIdentity {
  readonly registrationToken: TunnelRegistrationToken
  readonly shareId: string
}

/** Lifecycle and request events echo their add's registration token; neither IPC token enters Relay frames. */
export type TunnelWorkerEvent =
  | { readonly type: 'ready' }
  | {
    readonly type: 'share-rpc-request'
    readonly registrationToken: TunnelRegistrationToken
    readonly token: TunnelRequestToken
    readonly id: number
    readonly shareId: string
    /** Opaque viewer request the Relay forwarded; the owner host is its only reader. */
    readonly body: unknown
    /** Viewer identity the Relay authenticated, which the owner host reads instead of the body. */
    readonly actor: ShareRpcActor
  }
  | {
    readonly type: 'share-rpc-cancel'
    readonly registrationToken: TunnelRegistrationToken
    readonly token: TunnelRequestToken
    readonly id: number
    readonly shareId: string
  }
  | (ShareAccessStateFrame & TunnelRegistrationIdentity)
  | ({ readonly type: 'share-connected' } & TunnelRegistrationIdentity)
  | ({ readonly type: 'share-error'; readonly message: string } & TunnelRegistrationIdentity)
  | ({ readonly type: 'share-closed' } & TunnelRegistrationIdentity)

/** One opaque viewer request the Relay routes to the owner gateway. */
export interface ShareRpcFrame {
  readonly type: 'share-rpc'
  readonly id: number
  /** Viewer request the Relay forwards without reading it. */
  readonly body: unknown
  /**
   * Viewer identity the Relay authenticated for this request.
   *
   * This is the only viewer identity an owner may act on: the Relay holds the session and asserts it,
   * the browser never does, and it travels outside the opaque body so the owner learns who is asking
   * without interpreting the request itself.
   */
  readonly actor: ShareRpcActor
}

/** Authenticated viewer identity the Relay asserts for one forwarded request. */
export interface ShareRpcActor {
  readonly providerId: string
  /** Provider tenant; the Relay asserts the normalized, non-empty tenant its adapters store. */
  readonly tenantId: string
  readonly subjectId: string
  /**
   * Display name the Relay asserted for this identity, when its provider published one. It is
   * presentation data only: attribution may show it, while authorization uses the triple.
   */
  readonly displayName?: string
  /**
   * Owner-verifiable credential asserting this identity, when the deployment's data path has no
   * in-band authority to assert it (a viewer reaching the owner directly). Absent today: the Relay
   * asserts the triple itself. The owner verifies it before trusting the identity; the protocol does
   * not verify it.
   */
  readonly credential?: string
}

/** How a viewer reaches the owner that published this share. */
export interface ShareConnection {
  /**
   * `relay` reaches the owner through the Relay that carried this registration. `direct` is reserved
   * for a deployment where viewers reach the owner itself; its transport parameters are added when
   * that path is implemented.
   */
  readonly mode: 'relay' | 'direct'
}

/**
 * Routing fields an opaque viewer request carries, for logging only.
 *
 * The Relay and the owner worker both forward the same request body without reading it, and both
 * need the same two fields to correlate one read across hops; every other field stays opaque.
 * @param body Request body as forwarded.
 * @returns The operation name and stream id, or placeholders when the body carries neither.
 */
export function viewerRequestFields(body: unknown): { readonly op: string; readonly streamId: string } {
  if (typeof body !== 'object' || body === null) return { op: 'unknown', streamId: '-' }
  const value = body as { readonly op?: unknown; readonly id?: unknown }
  return {
    op: typeof value.op === 'string' ? value.op : 'unknown',
    streamId: typeof value.id === 'number' ? String(value.id) : '-',
  }
}

/** The owner gateway's opaque answer to one routed viewer request. */
export interface ShareRpcResFrame {
  readonly type: 'share-rpc-res'
  readonly id: number
  readonly status: number
  readonly body?: unknown
}

/** Cancel one in-flight viewer request after its viewer went away. */
export interface ShareRpcCancelFrame {
  readonly type: 'share-rpc-cancel'
  readonly id: number
}

/** Committed Relay authority for one share, scoped to the socket carrying it. */
export interface ShareAccessStateFrame extends SharePermissions {
  readonly type: 'share-access-state'
  /** Monotonic durable Relay store revision. */
  readonly version: number
  readonly accessMode: 'open' | 'selected'
  readonly allowedSubjectIds: readonly string[]
  /**
   * Tier the share carries.
   *
   * The current tiers are `view` and `write`; any other value is rejected.
   */
  readonly sessionMode: 'view' | 'write'
  /**
   * Whether this share lets an admitted viewer fork it.
   *
   * Absent means no forking.
   */
  readonly allowsFork?: boolean
  readonly expiresAt?: string
}

/** Every frame exchanged between the Relay and one owner gateway. */
export type Frame = ShareRpcFrame | ShareRpcResFrame | ShareRpcCancelFrame | ShareAccessStateFrame

/** Every frame the Relay can send: the answers and requests the gateway emits are not among them. */
export type RelayFrame = ShareRpcFrame | ShareRpcCancelFrame | ShareAccessStateFrame

/** The part of a socket `sendFrame` needs, satisfied by a `ws` WebSocket. */
export interface FrameSocket {
  readonly readyState: number
  send(data: string): void
}

/** `WebSocket.OPEN`, restated so the shared protocol package carries no socket dependency. */
const SOCKET_OPEN = 1

/**
 * Send one frame when the socket is open.
 * @param socket Owner gateway or viewer socket.
 * @param frame Wire frame.
 */
export function sendFrame(socket: FrameSocket, frame: Frame): void {
  if (socket.readyState === SOCKET_OPEN) socket.send(JSON.stringify(frame))
}

/**
 * Decode one WebSocket data frame without relying on its representation.
 * @param data Message bytes supplied by ws.
 * @returns UTF-8 text for one complete message.
 */
export function rawText(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/**
 * Read the envelope every accepted frame carries from an already-decoded value.
 *
 * Both directions state the same envelope, so one decoder owns it — a frame's id is what correlates an
 * answer with its request, and a second copy of these rules is a second place for that to drift.
 * @param value - Decoded JSON value.
 * @returns The value with its id, or undefined when the value is not an accepted envelope.
 */
function frameEnvelope(value: unknown): { readonly value: Record<string, unknown>; readonly id: number } | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.id) || Number(value.id) <= 0) return undefined
  return { value, id: Number(value.id) }
}

/**
 * Decode one raw frame's envelope: the JSON value and the request id every accepted frame carries.
 * @param text - Raw socket text.
 * @returns The decoded value with its id, or undefined when the text is not an accepted envelope.
 */
function decodeFrameEnvelope(text: string): { readonly value: Record<string, unknown>; readonly id: number } | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  return frameEnvelope(value)
}

/**
 * Parse one gateway-to-Relay frame; unknown or malformed frames are dropped.
 * @param text Raw socket text.
 * @returns Parsed frame, or undefined when the frame is not accepted.
 */
export function parseGatewayFrame(text: string): Frame | undefined {
  const envelope = decodeFrameEnvelope(text)
  if (envelope === undefined) return undefined
  const { value, id } = envelope
  if (value.type === 'share-rpc-res') {
    if (!Number.isSafeInteger(value.status) || Number(value.status) < 100 || Number(value.status) > 599) {
      return undefined
    }
    return {
      type: 'share-rpc-res',
      id,
      status: Number(value.status),
      ...(value.body === undefined ? {} : { body: value.body }),
    }
  }
  return undefined
}

/**
 * Parse one already-decoded Relay-to-gateway value; unknown or malformed frames are dropped.
 * @param value Decoded JSON value.
 * @returns Parsed frame, or undefined when the frame is not accepted.
 */
function parseRelayValue(value: unknown): RelayFrame | undefined {
  const state = parseShareAccessState(value)
  if (state !== undefined) return state
  const envelope = frameEnvelope(value)
  if (envelope === undefined) return undefined
  const { value: frame, id } = envelope
  if (frame.type === 'share-rpc') {
    if (frame.body === undefined) return undefined
    // A frame without the Relay's asserted actor is refused, so an owner never sees a request whose
    // caller it cannot attribute.
    if (!isShareRpcActor(frame.actor)) return undefined
    return { type: 'share-rpc', id, body: frame.body, actor: frame.actor }
  }
  if (frame.type === 'share-rpc-cancel') return { type: 'share-rpc-cancel', id }
  return undefined
}

/**
 * Parse one Relay-to-gateway frame; unknown or malformed frames are dropped.
 * @param text Raw socket text.
 * @returns Parsed frame, or undefined when the frame is not accepted.
 */
export function parseRelayFrame(text: string): RelayFrame | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (_error) {
    // Invalid wire JSON carries neither a lifecycle state nor an RPC.
    return undefined
  }
  return parseRelayValue(value)
}

/**
 * The refusal this build answers with when it reads a frame it cannot serve.
 *
 * A frame whose type this build does not know, or a known request whose fields it refuses, otherwise
 * leaves the peer waiting for an answer that will never come: the read holds until the peer's own
 * budget expires, and a version mismatch reaches the reader as a timeout rather than as a fact.
 * Answering states the one thing the peer can act on — this build cannot serve that frame — while a
 * frame with no usable envelope states no request id to correlate an answer with, and a frame that
 * answers or cancels something is not a request to answer at all.
 * @param text Raw socket text the Relay sent.
 * @returns The refusal to send, or undefined when this frame is not one to answer.
 */
export function unsupportedFrameRefusal(text: string): ShareRpcResFrame | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (_error) {
    // Text that is not JSON states no frame to answer.
    return undefined
  }
  // A frame this build serves is not one to refuse, so the answer holds whoever calls this.
  if (parseRelayValue(value) !== undefined) return undefined
  const envelope = frameEnvelope(value)
  if (envelope === undefined) return undefined
  const type = envelope.value.type
  if (type === 'share-rpc') {
    // The Relay's own request frame, carrying fields the gateway refuses: the peer sent something
    // this build reads and rejects, so the answer names that rather than an unknown frame.
    return {
      type: 'share-rpc-res',
      id: envelope.id,
      status: 400,
      body: { error: 'invalid-request' },
    }
  }
  if (type === 'share-rpc-res' || type === 'share-rpc-cancel') return undefined
  if (typeof type !== 'string' || type === '') return undefined
  // A frame type this build does not know: the peer is newer, and saying so is what lets the Relay
  // report a version mismatch instead of holding the read.
  return {
    type: 'share-rpc-res',
    id: envelope.id,
    status: 501,
    body: { error: 'unsupported-frame' },
  }
}

/**
 * The share one rejected IPC command names, so its host learns the command was refused.
 *
 * A command this build does not accept is otherwise dropped in silence: an interactive share then
 * fails after its own wait, and a share restored at startup stays offline with nothing said.
 * @param value Raw IPC message payload the worker refused.
 * @returns The share the command named, or undefined when the payload names none.
 */
export function rejectedCommandShareId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.shareId === 'string' && value.shareId !== '') return value.shareId
  const share = value.share
  if (isRecord(share) && typeof share.shareId === 'string' && share.shareId !== '') return share.shareId
  return undefined
}

/**
 * Parse one host-to-worker IPC command; unknown or malformed commands are dropped.
 *
 * The worker and its host run in separate processes, so the message crosses a process boundary and
 * every field the worker reads is checked here rather than asserted.
 * @param value Raw IPC message payload.
 * @returns Parsed command, or undefined when the payload is not an accepted command.
 */
export function parseTunnelWorkerCommand(value: unknown): TunnelWorkerCommand | undefined {
  if (!isRecord(value)) return undefined
  switch (value.type) {
    case 'shutdown':
      return { type: 'shutdown' }
    case 'remove-share':
      return typeof value.shareId === 'string' && value.shareId !== ''
        ? { type: 'remove-share', shareId: value.shareId }
        : undefined
    case 'add-share':
      return isRegistrationToken(value.registrationToken) && isTunnelShareSpec(value.share)
        ? {
          type: 'add-share',
          registrationToken: value.registrationToken,
          share: { ...value.share, connection: value.share.connection ?? { mode: 'relay' } },
        } : undefined
    case 'share-rpc-response': {
      if (!isTunnelRequestIdentity(value) || !Number.isSafeInteger(value.status)
        || Number(value.status) < 100 || Number(value.status) > 599) return undefined
      return {
        type: 'share-rpc-response',
        registrationToken: value.registrationToken,
        token: value.token,
        id: value.id,
        shareId: value.shareId,
        status: Number(value.status),
        ...(value.body === undefined ? {} : { body: value.body }),
      }
    }
    default:
      return undefined
  }
}

/**
 * Parse one worker-to-host IPC event; unknown or malformed events are dropped.
 * @param value Raw IPC message payload.
 * @returns Parsed event, or undefined when the payload is not an accepted event.
 */
export function parseTunnelWorkerEvent(value: unknown): TunnelWorkerEvent | undefined {
  if (!isRecord(value)) return undefined
  switch (value.type) {
    case 'ready':
      return { type: 'ready' }
    case 'share-connected':
    case 'share-closed': {
      const type = value.type
      return isTunnelRegistrationIdentity(value)
        ? { type, registrationToken: value.registrationToken, shareId: value.shareId }
        : undefined
    }
    case 'share-access-state': {
      const state = parseShareAccessState(value)
      return state !== undefined && isTunnelRegistrationIdentity(value)
        ? { ...state, registrationToken: value.registrationToken, shareId: value.shareId } : undefined
    }
    case 'share-error':
      return isTunnelRegistrationIdentity(value) && typeof value.message === 'string'
        ? { type: 'share-error', registrationToken: value.registrationToken, shareId: value.shareId, message: value.message }
        : undefined
    case 'share-rpc-cancel':
      return isTunnelRequestIdentity(value)
        ? { type: 'share-rpc-cancel', registrationToken: value.registrationToken, token: value.token, id: value.id, shareId: value.shareId }
        : undefined
    case 'share-rpc-request':
      return isTunnelRequestIdentity(value) && value.body !== undefined && isShareRpcActor(value.actor)
        ? {
          type: 'share-rpc-request', registrationToken: value.registrationToken, token: value.token, id: value.id,
          shareId: value.shareId, body: value.body, actor: value.actor,
        }
        : undefined
    default:
      return undefined
  }
}

/**
 * Validate one share spec the owner host asked its worker to carry.
 *
 * Optional fields are checked against the same rules the frame parsers apply; an expiry must be a
 * parseable ISO time, so a registration cannot carry a deadline no reader can enforce.
 * @param value Candidate spec.
 * @returns True when every required field is present with the declared type.
 */
function isTunnelShareSpec(value: unknown): value is TunnelShareSpec {
  if (!isRecord(value)) return false
  const mode = value.sessionMode
  return typeof value.shareId === 'string' && value.shareId !== ''
    && typeof value.sessionId === 'string'
    && typeof value.sessionTitle === 'string'
    && (value.accessMode === 'open' || value.accessMode === 'selected')
    && typeof value.relay === 'string'
    && typeof value.gatewayToken === 'string'
    && typeof value.ownerDisplayName === 'string'
    && (value.ownerProviderId === undefined || typeof value.ownerProviderId === 'string')
    && (value.ownerTenantId === undefined || typeof value.ownerTenantId === 'string')
    && (value.dshVersion === undefined || typeof value.dshVersion === 'string')
    && (value.ownerInstanceId === undefined || typeof value.ownerInstanceId === 'string')
    && (value.allowsFork === undefined || typeof value.allowsFork === 'boolean')
    && (mode === undefined || mode === 'view' || mode === 'write')
    && (value.connection === undefined
      || (isRecord(value.connection) && (value.connection.mode === 'relay' || value.connection.mode === 'direct')))
    && (value.ownerCredential === undefined || typeof value.ownerCredential === 'string')
    && Array.isArray(value.allowedSubjectIds)
    && value.allowedSubjectIds.every(subject => typeof subject === 'string' && subject !== '')
    && (value.expiresAt === undefined
      || (typeof value.expiresAt === 'string' && Number.isFinite(Date.parse(value.expiresAt))))
}

/**
 * Validate the actor the Relay asserts on one forwarded request.
 * @param value Candidate actor.
 * @returns True when it carries a non-empty provider, tenant, and subject.
 */
function isShareRpcActor(value: unknown): value is ShareRpcActor {
  if (typeof value !== 'object' || value === null) return false
  const actor = value as Record<string, unknown>
  return typeof actor.providerId === 'string' && actor.providerId !== ''
    && typeof actor.tenantId === 'string' && actor.tenantId !== ''
    && typeof actor.subjectId === 'string' && actor.subjectId !== ''
    && (actor.displayName === undefined || (typeof actor.displayName === 'string' && actor.displayName !== ''))
    && (actor.credential === undefined || typeof actor.credential === 'string')
}

function isRegistrationToken(value: unknown): value is TunnelRegistrationToken {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function isTunnelRegistrationIdentity(value: Record<string, unknown>): value is Record<string, unknown> & TunnelRegistrationIdentity {
  return isRegistrationToken(value.registrationToken) && typeof value.shareId === 'string' && value.shareId !== ''
}

/** Validate request correlation fields at the IPC parser. */
function isTunnelRequestIdentity(value: Record<string, unknown>): value is Record<string, unknown> & {
  readonly registrationToken: TunnelRegistrationToken
  readonly token: TunnelRequestToken
  readonly id: number
  readonly shareId: string
} {
  return isTunnelRegistrationIdentity(value) && typeof value.token === 'string' && value.token !== ''
    && Number.isSafeInteger(value.id) && Number(value.id) > 0
}

/**
 * Validate a committed Relay authority snapshot at wire, IPC, or authenticated HTTP ingress.
 * @param value - Untrusted snapshot fields.
 * @returns Owned snapshot fields, or undefined when any authority field is invalid.
 */
export function parseShareAccessState(value: unknown): ShareAccessStateFrame | undefined {
  if (!isRecord(value) || value.type !== 'share-access-state'
    || !Number.isSafeInteger(value.version) || Number(value.version) < 0
    || (value.accessMode !== 'open' && value.accessMode !== 'selected')
    || !isSubjectIds(value.allowedSubjectIds)
    || (value.sessionMode !== 'view' && value.sessionMode !== 'write')
    || (value.allowsFork !== undefined && typeof value.allowsFork !== 'boolean')
    || (value.expiresAt !== undefined && (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))))) {
    return undefined
  }
  return { type: 'share-access-state', version: Number(value.version), accessMode: value.accessMode,
    allowedSubjectIds: [...value.allowedSubjectIds], sessionMode: value.sessionMode,
    ...(value.allowsFork === undefined ? {} : { allowsFork: value.allowsFork }),
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }) }
}

function isSubjectIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(id => typeof id === 'string' && id !== '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
