/** Owner-side gateway worker: one process multiplexes every share over IPC to the owner host. */

import { WebSocket, type RawData } from 'ws'
import { relayRefusal } from './relay-refusal.ts'
import { registrationUrl } from './registration-url.ts'
import {
  INITIAL_RETRY_BACKOFF,
  RETRY_STABLE_MS,
  retryBackoffNext,
  retryBackoffSettled,
  type RetryBackoff,
} from './retry-backoff.ts'
import {
  parseRelayFrame,
  parseTunnelWorkerCommand,
  rawText,
  sendFrame as send,
  unsupportedFrameRefusal,
  viewerRequestFields,
  type RelayFrame,
  type TunnelShareSpec,
  type TunnelRegistrationToken,
  type TunnelWorkerEvent,
} from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { PendingRpc, type PendingRequest } from './pending-rpc.ts'

const HEARTBEAT_INTERVAL_MS = 25_000

/**
 * Consecutive unanswered heartbeats tolerated before this worker drops its own Relay socket.
 *
 * One miss means a busy event loop, not a dead connection: terminating there aborts every in-flight
 * viewer stream on the share and forces a re-registration, which is the periodic reconnect an owner
 * would otherwise never see the cause of.
 */
const GATEWAY_MAX_MISSED_PONGS = 2

interface GatewayConnection {
  readonly socket: WebSocket
  readonly registrationToken: TunnelRegistrationToken
}

interface GatewayState {
  readonly registrationToken: TunnelRegistrationToken
  /** Latest owner intent or committed Relay snapshot, used by the next handshake. */
  spec: TunnelShareSpec
  accessVersion: number | undefined
  gateway: GatewayConnection | undefined
  heartbeat: ReturnType<typeof setInterval> | undefined
  retryTimer: ReturnType<typeof setTimeout> | undefined
  retry: RetryBackoff
  openedAt: number | undefined
  stopped: boolean
}

/** IPC tokens identify requests; socket-local Relay ids never select a Host response. */
const pendingRpc = new PendingRpc<GatewayConnection>()

/**
 * Run one owner worker that multiplexes every share over IPC. The worker owns
 * one outbound Relay socket per share, but one process and one owner DSH.
 */
export function runGatewayWorker(): void {
  const shares = new Map<string, GatewayState>()
  notifyWorker({ type: 'ready' })

  process.on('message', (value: unknown) => {
    const command = parseTunnelWorkerCommand(value)
    if (command === undefined) {
      console.warn('[liveshare] worker refused one owner command')
      return
    }
    if (command.type === 'share-rpc-response') {
      const owner = shares.get(command.shareId)?.gateway
      if (owner?.registrationToken !== command.registrationToken) return
      const request = pendingRpc.take(command)
      if (request === undefined) {
        // The Relay already stopped waiting, this worker restarted, or the answer states an id that
        // names no single waiting request: the answer has nowhere to go.
        console.warn(`[liveshare] worker dropped late read response relayId=${String(command.id)}`)
        return
      }
      const gateway = request.owner.socket
      if (gateway.readyState === WebSocket.OPEN) {
        const observed = viewerRequestFields(command.body)
        console.log(
          `[liveshare] worker read answered share=${request.shareId} relayId=${String(command.id)}`
          + ` op=${observed.op} streamId=${observed.streamId} status=${String(command.status)}`
          + ` elapsedMs=${String(Date.now() - request.since)}`,
        )
        send(gateway, {
          type: 'share-rpc-res',
          id: command.id,
          status: command.status,
          ...(command.body === undefined ? {} : { body: command.body }),
        })
      } else {
        // The owner answered, and its gateway is gone: the Relay will time this read out.
        console.warn(
          `[liveshare] worker cannot deliver read response share=${request.shareId}`
          + ` relayId=${String(command.id)} — gateway is not connected`,
        )
      }
      return
    }
    if (command.type === 'add-share') addShare(shares, command.share, command.registrationToken)
    else if (command.type === 'remove-share') {
      console.warn(`[liveshare] worker dropping one share by owner command share=${command.shareId}`)
      removeShare(shares, command.shareId)
    } else {
      // Every share closes with code 1000 here, which is what an owner-side `client-closed` batch of
      // gateway closes in the Relay log means; naming it separates a deliberate teardown from a
      // connection that failed.
      console.warn(
        `[liveshare] worker shutting down command=${String((command as { readonly type?: unknown }).type)}`
        + ` shares=${String(shares.size)}`,
      )
      for (const shareId of [...shares.keys()]) removeShare(shares, shareId)
      process.exit(0)
    }
  })
  process.on('disconnect', () => {
    console.warn(`[liveshare] worker lost its host connection shares=${String(shares.size)}`)
    for (const shareId of [...shares.keys()]) removeShare(shares, shareId)
    process.exit(0)
  })
}

function addShare(shares: Map<string, GatewayState>, spec: TunnelShareSpec, registrationToken: TunnelRegistrationToken): void {
  if (shares.get(spec.shareId)?.registrationToken === registrationToken) return
  removeShare(shares, spec.shareId)
  const state: GatewayState = {
    spec,
    registrationToken,
    accessVersion: undefined,
    gateway: undefined,
    heartbeat: undefined,
    retryTimer: undefined,
    retry: INITIAL_RETRY_BACKOFF,
    openedAt: undefined,
    stopped: false,
  }
  shares.set(spec.shareId, state)
  connectShare(shares, state)
}

function removeShare(shares: Map<string, GatewayState>, shareId: string): void {
  const state = shares.get(shareId)
  if (state === undefined) return
  state.stopped = true
  if (state.retryTimer !== undefined) clearTimeout(state.retryTimer)
  clearInterval(state.heartbeat)
  if (state.gateway !== undefined) clearPendingRpc(state.gateway)
  state.gateway?.socket.close(1000, 'share removed')
  shares.delete(shareId)
}

function connectShare(shares: Map<string, GatewayState>, state: GatewayState): void {
  const url = registrationUrl(state.spec)
  const gateway = new WebSocket(url, {
    headers: {
      authorization: `Bearer ${state.spec.gatewayToken}`,
      ...(state.spec.ownerCredential === undefined || state.spec.ownerCredential === ''
        ? {}
        : { 'x-liveshare-owner-credential': state.spec.ownerCredential }),
    },
  })
  const connection: GatewayConnection = { socket: gateway, registrationToken: state.registrationToken }
  state.gateway = connection
  let awaitingPong = false
  let missedPongs = 0
  // A single unanswered ping means this machine or the Relay was briefly busy, not that the
  // connection is gone. Terminating there drops the share's route, aborts every in-flight viewer
  // stream, and re-registers the gateway — which is what a periodic `share.reconnect` audit line is.
  let closeReason = 'unknown'
  let handshakeStatus: number | undefined
  state.heartbeat = setInterval(() => {
    if (gateway.readyState !== WebSocket.OPEN) return
    if (awaitingPong) {
      missedPongs += 1
      if (missedPongs >= GATEWAY_MAX_MISSED_PONGS) {
        closeReason = `heartbeat-timeout missedPongs=${String(missedPongs)}`
        gateway.terminate()
        return
      }
      console.warn(
        `[liveshare] worker heartbeat missed share=${state.spec.shareId} missedPongs=${String(missedPongs)}`,
      )
      return
    }
    awaitingPong = true
    gateway.ping()
  }, HEARTBEAT_INTERVAL_MS)

  gateway.on('pong', () => { awaitingPong = false; missedPongs = 0 })
  gateway.on('open', () => {
    if (state.stopped || state.gateway !== connection) return
    state.openedAt = Date.now()
    notifyWorker({ type: 'share-connected', registrationToken: state.registrationToken, shareId: state.spec.shareId })
  })
  gateway.on('message', (data: RawData) => {
    // Any traffic proves the peer is alive, so a pong that arrived late does not count as missed.
    awaitingPong = false
    missedPongs = 0
    const text = rawText(data)
    const frame = parseRelayFrame(text)
    if (frame !== undefined) {
      if (!state.stopped && state.gateway === connection) handleGatewayFrame(state, connection, frame)
      return
    }
    // A frame this build cannot serve is answered rather than dropped: silence leaves the Relay
    // holding the read until its own budget expires, and a peer that is newer than this build then
    // reaches the reader as a timeout instead of as a version this owner cannot serve.
    const refusal = unsupportedFrameRefusal(text)
    console.warn(
      `[liveshare] worker refused one relay frame share=${state.spec.shareId}`
      + ` frame=${refusal === undefined ? 'unanswerable' : `status=${String(refusal.status)} relayId=${String(refusal.id)}`}`,
    )
    if (refusal !== undefined && !state.stopped && state.gateway === connection) send(gateway, refusal)
  })
  gateway.on('close', (code: number, socketReason: Buffer) => {
    clearPendingRpc(connection)
    if (state.gateway !== connection) return
    clearInterval(state.heartbeat)
    state.gateway = undefined
    state.accessVersion = undefined
    if (state.stopped) return
    console.warn(
      `[liveshare] worker gateway closed share=${state.spec.shareId} code=${String(code)}`
      + ` reason=${closeReason} socketReason=${socketReason.toString()} retryMs=${String(state.retry.delayMs)}`,
    )
    const refusal = relayRefusal(handshakeStatus)
    if (refusal !== undefined) {
      // The Relay decided against this registration, so reconnecting with the same spec reaches the
      // same answer. The share stops here with the status as its diagnostic; registering it again
      // (an owner republish) builds a new state and asks the Relay once more.
      state.stopped = true
      shares.delete(state.spec.shareId)
      console.warn(`[liveshare] worker stopped share=${state.spec.shareId} ${refusal}`)
      return
    }
    if (state.openedAt !== undefined && Date.now() - state.openedAt >= RETRY_STABLE_MS) {
      state.retry = retryBackoffSettled()
    }
    state.openedAt = undefined
    const delayMs = state.retry.delayMs
    state.retry = retryBackoffNext(state.retry)
    state.retryTimer = setTimeout(() => { connectShare(shares, state) }, delayMs)
    notifyWorker({ type: 'share-closed', registrationToken: state.registrationToken, shareId: state.spec.shareId })
  })
  gateway.on('error', (error) => {
    if (state.stopped || state.gateway !== connection) return
    // A refused handshake arrives here as the socket error ws raises in place of the response, so the
    // status captured from `unexpected-response` is the diagnostic worth reporting.
    const answered = handshakeStatus === undefined
      ? undefined
      : relayRefusal(handshakeStatus) ?? `relay answered registration status=${String(handshakeStatus)}`
    const detail = answered ?? (error instanceof Error ? error.message : String(error))
    closeReason = `gateway-error ${detail}`
    notifyWorker({ type: 'share-error', registrationToken: state.registrationToken, shareId: state.spec.shareId, message: detail })
    gateway.terminate()
  })
  gateway.on('unexpected-response', (_request, response) => {
    handshakeStatus = response.statusCode
    gateway.terminate()
  })
}

function handleGatewayFrame(state: GatewayState, connection: GatewayConnection, frame: RelayFrame): void {
  const shareId = state.spec.shareId
  switch (frame.type) {
    case 'share-access-state': {
      if (state.accessVersion !== undefined && state.accessVersion >= frame.version) return
      const { expiresAt: _expiresAt, ...retained } = state.spec
      state.spec = {
        ...retained,
        accessMode: frame.accessMode,
        allowedSubjectIds: frame.allowedSubjectIds,
        sessionMode: frame.sessionMode,
        // A Relay that states no switch states it off; the tier does not imply a fork grant.
        allowsFork: frame.allowsFork === true,
        ...(frame.expiresAt === undefined ? {} : { expiresAt: frame.expiresAt }),
      }
      state.accessVersion = frame.version
      notifyWorker({ ...frame, registrationToken: state.registrationToken, shareId })
      return
    }
    case 'share-rpc': {
      const previous = pendingRpc.cancel(connection, frame.id)
      if (previous !== undefined) notifyCancellation(previous)
      const request = pendingRpc.add(shareId, frame.id, connection)
      const observed = viewerRequestFields(frame.body)
      console.log(
        `[liveshare] worker read received share=${shareId} relayId=${String(frame.id)}`
        + ` op=${observed.op} streamId=${observed.streamId}`,
      )
      notifyWorker({
        type: 'share-rpc-request',
        registrationToken: connection.registrationToken,
        token: request.token,
        id: frame.id,
        shareId,
        body: frame.body,
        // The Relay asserted this identity; the owner host acts on it and never on the body.
        actor: frame.actor,
      })
      return
    }
    case 'share-rpc-cancel': {
      const request = pendingRpc.cancel(connection, frame.id)
      if (request !== undefined) notifyCancellation(request)
    }
  }
}

function notifyWorker(event: TunnelWorkerEvent): void {
  if (process.send !== undefined) process.send(event)
}

/** Cancel Host work before forgetting requests on a closed Relay socket. */
function clearPendingRpc(connection: GatewayConnection): void {
  for (const request of pendingRpc.clear(connection)) notifyCancellation(request)
}

function notifyCancellation(request: PendingRequest<GatewayConnection>): void {
  notifyWorker({ type: 'share-rpc-cancel', registrationToken: request.owner.registrationToken, token: request.token, shareId: request.shareId, id: request.id })
}
