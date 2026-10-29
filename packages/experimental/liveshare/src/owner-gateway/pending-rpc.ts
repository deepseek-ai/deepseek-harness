/** Correlate IPC requests by worker-issued tokens and Relay ids by their exact socket. */

import { randomUUID } from 'node:crypto'
import type { TunnelRequestToken } from '@deepseek-ai/dsh-experimental-liveshare-protocol'

/** One request and the exact Relay connection that may receive its response. */
export interface PendingRequest<T> {
  readonly token: TunnelRequestToken
  readonly shareId: string
  readonly id: number
  readonly owner: T
  readonly since: number
}

/** Request identities remain distinct when a Relay reconnects and reuses its numeric ids. */
export class PendingRpc<T> {
  private readonly tokens = new Map<TunnelRequestToken, PendingRequest<T>>()
  private readonly owners = new Map<T, Map<number, PendingRequest<T>>>()

  /**
   * Register a request with a new IPC token.
   * @param shareId Share carrying the request.
   * @param id Relay id on this socket.
   * @param owner Exact socket that received the request.
   * @returns Registered request; an existing id must be cancelled before reuse on the same socket.
   */
  add(shareId: string, id: number, owner: T): PendingRequest<T> {
    const request = { token: randomUUID() as TunnelRequestToken, shareId, id, owner, since: Date.now() }
    let requests = this.owners.get(owner)
    if (requests === undefined) {
      requests = new Map()
      this.owners.set(owner, requests)
    }
    if (requests.has(id)) throw new Error('Relay request id is already pending on this socket')
    requests.set(id, request)
    this.tokens.set(request.token, request)
    return request
  }

  /**
   * Claim an answer only when all IPC correlation fields match.
   * @param answer Token, share and Relay id echoed by the Host.
   * @returns The request removed from pending state, or undefined for a stale or mismatched answer.
   */
  take(answer: { readonly token: TunnelRequestToken; readonly shareId: string; readonly id: number }): PendingRequest<T> | undefined {
    const request = this.tokens.get(answer.token)
    if (request === undefined || request.shareId !== answer.shareId || request.id !== answer.id) return undefined
    return this.cancel(request.owner, request.id)
  }

  /**
   * Remove one socket-local request.
   * @param owner Socket receiving the cancellation.
   * @param id Relay id on that socket.
   * @returns Removed request for cancellation notification, or undefined if it already settled.
   */
  cancel(owner: T, id: number): PendingRequest<T> | undefined {
    const requests = this.owners.get(owner)
    const request = requests?.get(id)
    if (request === undefined) return undefined
    this.tokens.delete(request.token)
    requests?.delete(id)
    if (requests?.size === 0) this.owners.delete(owner)
    return request
  }

  /**
   * Remove all requests on a closed socket.
   * @param owner Socket being disposed.
   * @returns Removed requests for Host cancellation notifications.
   */
  clear(owner: T): readonly PendingRequest<T>[] {
    const requests = [...(this.owners.get(owner)?.values() ?? [])]
    for (const request of requests) this.tokens.delete(request.token)
    this.owners.delete(owner)
    return requests
  }
}
