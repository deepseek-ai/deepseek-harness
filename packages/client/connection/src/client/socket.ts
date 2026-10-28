/** Physical socket selection for browser, desktop, and authenticated Node connections. */

/** Socket events consumed by the Gateway on browser and Node carriers. */
export interface ConnectionWebSocketEventMap {
  readonly open: object
  readonly error: object
  readonly close: object
  readonly message: { readonly data: unknown }
}

/** Text WebSocket operations shared by the browser API and Node carriers. */
export interface ConnectionWebSocket {
  /** Standard WebSocket state, from CONNECTING (0) through CLOSED (3). */
  readonly readyState: number
  /** @param data - complete text frame to send. */
  send(data: string): void
  /**
   * @param code - protocol close code.
   * @param reason - peer-facing close explanation.
   */
  close(code?: number, reason?: string): void
  /**
   * @param event - physical socket event.
   * @param listener - callback for that event.
   * @param options - whether the callback is removed after its first delivery.
   */
  addEventListener<Event extends keyof ConnectionWebSocketEventMap>(
    event: Event,
    listener: (event: ConnectionWebSocketEventMap[Event]) => void,
    options?: { readonly once?: boolean },
  ): void
  /**
   * @param event - physical socket event.
   * @param listener - previously registered callback.
   */
  removeEventListener<Event extends keyof ConnectionWebSocketEventMap>(
    event: Event,
    listener: (event: ConnectionWebSocketEventMap[Event]) => void,
  ): void
}

/**
 * Create an authenticated socket; its consumer owns framing and closing.
 * @param url - absolute WebSocket URL beneath the selected Host mount.
 * @returns a newly connecting socket, before it emits open or failure.
 */
export type ConnectionWebSocketFactory = (url: string) => ConnectionWebSocket

/**
 * Resolve a logical channel against the explicit Host or the page's document base.
 * @param path - absolute logical channel path.
 * @param factory - authenticated socket factory; omission uses the browser API.
 * @param baseUrl - Host base URL, required outside a document.
 * @returns a socket owned by the calling channel.
 */
export function openConnectionWebSocket(
  path: string,
  factory: ConnectionWebSocketFactory = url => new WebSocket(url),
  baseUrl?: string,
): ConnectionWebSocket {
  const base = baseUrl ?? (typeof document === 'undefined' ? undefined : document.baseURI)
  if (base === undefined) throw new Error('connection: WebSocket carrier requires streamBaseUrl outside a document')
  const url = new URL(path.slice(1), base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return factory(url.href)
}
