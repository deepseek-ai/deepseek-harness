/**
 * Viewer page carrier: the script the Relay places at the top of the owner's served index document.
 *
 * It installs the page's Connection transport over the Relay read channel and names the share the
 * page presents. It performs no Liveshare business: grants, page status, and refusal handling belong
 * to the Liveshare client plugin, which reads them through ordinary reads. The carrier only converts
 * Connection calls into `call` requests, Gateway streams into `stream-open`/`stream-next`/
 * `stream-cancel` polls, and marks each failure as a retryable carrier loss or a terminal refusal.
 *
 * It also forwards the page-origin owner routes the Relay cannot answer, so app code that calls `fetch`
 * directly reaches the owner instead of the Relay's tail. That set is explicit and read-only; every
 * other request keeps the page's own `fetch`.
 *
 * {@link installViewerCarrier} runs in the browser from its own source text, so it must reference no
 * module binding: every constant and helper it needs is declared inside its body.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare-protocol
 */

/** Page global naming the share one viewer page presents; the Liveshare client plugin reads it. */
export const LIVESHARE_VIEWER_GLOBAL = '__DSH_LIVESHARE_VIEWER__'

/** Share one served viewer page presents. */
export interface ViewerPageTarget {
  /** Public Relay base path every read is posted under; empty at the Relay root. */
  readonly basePath: string
  readonly shareId: string
  /** Session the share presents; the page opens it once the session list carries it. */
  readonly sessionId: string
}

/** Carrier inputs: the page target plus the page's own read budget. */
export interface ViewerCarrierOptions extends ViewerPageTarget {
  /** Longest wait for one Relay answer before the read counts as lost. */
  readonly readTimeoutMs: number
}

/**
 * Install the viewer globals in the current page. Runs before the shell entry so the Connection
 * plugin finds `__DSH_TRANSPORT__` when it installs.
 * @param options - Page target and read budget.
 */
export function installViewerCarrier(options: ViewerCarrierOptions): void {
  // Statuses whose definition says the read may be tried again.
  const carrierStatus = new Set([408, 429, 502, 503, 504])
  // The only owner codes meaning the logical stream was lost rather than refused. Every other code — an
  // owner refusal such as `remote-access/denied`, whose `details.reason` carries the policy's own
  // `liveshare/read-only` — is terminal, so the consumer reports it once instead of re-opening.
  const carrierCodes = new Set(['stream-not-found', 'gateway/cancelled'])
  const codeShaped = /^[a-z][a-z0-9-]*(?:\/[a-z0-9-]+)*$/u
  const target = options.shareId === ''
    ? `${options.basePath}/__share/rpc`
    : `${options.basePath}/__share/rpc?shareId=${encodeURIComponent(options.shareId)}`
  // Each page numbers its streams in its own far-apart window, so two pages reading one share never
  // replace each other's streams.
  let nextStreamId = (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) % 0x7fff_ff00 + 1

  type Answer = { readonly status: number; readonly body: unknown }
  type Marked = Error & { dshRemoteStreamFailure?: object }
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
  const carrier = (message: string): Error => {
    const error: Marked = new Error(message)
    error.dshRemoteStreamFailure = { kind: 'carrier' }
    return error
  }
  const refusal = (answer: Answer): { readonly code?: string; readonly message?: string } => {
    if (!isRecord(answer.body)) return {}
    const value = answer.body.error
    const nested = isRecord(value)
    const code = nested ? value.code : value
    const message = nested ? value.message : answer.body.message
    return {
      ...(typeof code === 'string' && codeShaped.test(code) ? { code } : {}),
      ...(typeof message === 'string' ? { message } : {}),
    }
  }
  const remote = (answer: Answer, subject: string): Error => {
    const { code = 'liveshare/read-refused', message = `${subject} refused (HTTP ${String(answer.status)})` } = refusal(answer)
    const error: Marked = new Error(message)
    error.name = code
    error.dshRemoteStreamFailure = { kind: 'remote', code, details: { status: answer.status } }
    return error
  }
  const post = async (request: object, subject: string, signal?: AbortSignal): Promise<Answer> => {
    const timeout = AbortSignal.timeout(options.readTimeoutMs)
    let response: Response
    try {
      response = await fetch(target, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      })
    } catch (error) {
      // A read the browser could not send never reached the peer; the caller's own cancellation is
      // not a loss.
      if (signal?.aborted === true) throw error
      throw carrier(`${subject}: Relay unreachable`)
    }
    const body: unknown = await response.json().catch(() => undefined)
    return { status: response.status, body }
  }
  const readable = (answer: Answer, subject: string): Record<string, unknown> => {
    if (answer.status === 200) {
      if (isRecord(answer.body)) return answer.body
      throw carrier(`${subject}: Relay answered without a body`)
    }
    const code = refusal(answer).code
    if (answer.status !== 401 && answer.status !== 403
      && (carrierStatus.has(answer.status) || (code !== undefined && carrierCodes.has(code)))) {
      throw carrier(`${subject}: ${code ?? `HTTP ${String(answer.status)}`}`)
    }
    throw remote(answer, subject)
  }
  const failure = (frame: Record<string, unknown>, subject: string): Error | undefined => {
    const value = frame.failure
    if (!isRecord(value)) return undefined
    const code = typeof value.code === 'string' ? value.code : 'liveshare/read-refused'
    const message = typeof value.message === 'string' ? value.message : subject
    if (carrierCodes.has(code)) return carrier(message)
    const error: Marked = new Error(message)
    error.name = code
    error.dshRemoteStreamFailure = { kind: 'remote', code, details: isRecord(value.details) ? value.details : {} }
    return error
  }

  /**
   * Page-origin owner routes the Relay serves no answer for, forwarded instead of left to the Relay.
   *
   * Each is a read the shell makes for itself and the Relay cannot serve: the owner route exists on the
   * owner's own server, so a direct `fetch` from this page would leave the Relay origin and 404 at its
   * tail. Only read-only routes belong here: a route that acts on the owner's machine stays out.
   */
  const forwardedRoutes = ['/open-in-app/apps', '/api/present.host']
  /**
   * Offset at which `route` starts a path segment run, ignoring a Relay base path in front of it.
   * @param pathname - Resolved request pathname.
   * @param route - Owner route to find.
   * @returns The offset, or undefined when the route appears only inside a longer segment.
   */
  const segmentOffset = (pathname: string, route: string): number | undefined => {
    let from = 0
    for (;;) {
      const at = pathname.indexOf(route, from)
      if (at === -1) return undefined
      // The route starts with '/', so its own slash is the segment boundary; only the tail decides
      // whether a longer segment (e.g. `/api/present.hostile`) merely shares the prefix.
      const next = pathname[at + route.length]
      if (next === undefined || next === '/') return at
      from = at + 1
    }
  }
  /**
   * Owner path one page request forwards, matched at path-segment boundaries because the page URL carries
   * the Relay's own base path in front of it. Prefix-neighbouring paths such as `/api/present.hostile` or
   * `/x/open-in-app/apps-foo` are not this route.
   * @param pathname - Resolved request pathname (query and hash already excluded).
   * @param method - Request method, already upper-cased.
   * @returns The owner path to post, or undefined when this request is not one of the forwarded routes.
   */
  const forwardedRoute = (pathname: string, method: string): string | undefined => {
    if (method !== 'GET') return undefined
    for (const route of forwardedRoutes) {
      const at = segmentOffset(pathname, route)
      if (at !== undefined) return pathname.slice(at)
    }
    return undefined
  }
  /**
   * Read one forwarded owner route and rebuild its answer as an ordinary HTTP response.
   * @param path - Owner path to post.
   * @param init - The page request's own init, for its signal.
   * @returns The owner's status and body, JSON-encoded.
   */
  const forwardRoute = async (path: string, init: RequestInit | undefined): Promise<Response> => {
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    const answer = await post({ op: 'call', path, body }, path, init?.signal ?? undefined)
    return new Response(JSON.stringify(answer.body ?? null), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    })
  }

  // Installed over the page's own fetch so app code that does not go through `__DSH_TRANSPORT__` still
  // reaches the owner. Every request outside the forwarded set is handed to the fetch this replaced.
  const pageFetch = globalThis.fetch
  const carrierFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let pathname: string | undefined
    let method = 'GET'
    try {
      const page = globalThis as {
        readonly document?: { readonly baseURI: string }
        readonly location?: { readonly origin: string }
      }
      const pageOrigin = page.location?.origin
      const target = new URL(input instanceof Request ? input.url : String(input), page.document?.baseURI)
      // A request outside the page's own origin belongs to that origin: its path naming an owner
      // route must not divert it from the fetch the page replaced.
      pathname = pageOrigin !== undefined && target.origin === pageOrigin ? target.pathname : undefined
      method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    } catch {
      // A target this page base cannot resolve is not one of the forwarded routes.
      pathname = undefined
    }
    const path = pathname === undefined ? undefined : forwardedRoute(pathname, method)
    return path === undefined ? await pageFetch.call(globalThis, input, init) : await forwardRoute(path, init)
  }
  globalThis.fetch = carrierFetch

  const fetchCall = async (input: RequestInfo | URL, init: RequestInit): Promise<Response> => {
    // The Connection caller posts the document-relative route; the owner reads the `/api/...` path.
    const pageBase = (globalThis as { document?: { readonly baseURI: string } }).document?.baseURI
    const pathname = new URL(input instanceof Request ? input.url : input, pageBase).pathname
    const marker = pathname.lastIndexOf('/api/')
    const path = marker === -1 ? pathname : pathname.slice(marker)
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    const answer = await post({ op: 'call', path, body }, path, init.signal ?? undefined)
    if (answer.status === 200 && isRecord(answer.body)) return Response.json(answer.body)
    // A refusal is the owner's answer, not a transport failure: the caller receives the Connection
    // failure result the owner's code names.
    const rpcId = isRecord(body) && typeof body.rpcId === 'string' ? body.rpcId : ''
    const { code = 'liveshare/relay-error', message = `Relay answered HTTP ${String(answer.status)}` } = refusal(answer)
    return Response.json({
      type: 'server-response',
      rpcId,
      result: { ok: false, error: { code, message, details: { status: answer.status } } },
    })
  }

  const openStream = (endpoint: string, payload: unknown, signal: AbortSignal): AsyncIterable<unknown> => ({
    async *[Symbol.asyncIterator]() {
      const id = nextStreamId++
      signal.throwIfAborted()
      // Each path below sends this at most once: the abort listener only runs on abort, the final
      // block only without one, and an open that ends the stream cancels here before either is armed.
      const cancel = (): void => {
        void post({ op: 'stream-cancel', id }, endpoint).catch(() => undefined)
      }
      let opened: Answer
      try {
        opened = await post({ op: 'stream-open', id, endpoint, payload }, endpoint, signal)
      } catch (error) {
        // An open the page abandoned may still have reached the owner, which would hold the stream.
        if (signal.aborted) cancel()
        throw error
      }
      if (signal.aborted) {
        cancel()
        signal.throwIfAborted()
      }
      // A refused open is answered as a 200 failure frame rather than a status, and the owner registers
      // no stream for it: polling that id would only read `stream-not-found`, which looks like a lost
      // logical stream and would be re-opened forever. The frame's own code decides instead — an owner
      // refusal such as `remote-access/denied` is terminal, while a lost stream stays re-openable.
      let openedBody: Record<string, unknown>
      try {
        openedBody = readable(opened, endpoint)
      } catch (error) {
        // A 200 answer the page cannot read reached the owner, which may already hold this stream id.
        if (opened.status === 200) cancel()
        throw error
      }
      const refusedOpen = failure(openedBody, endpoint)
      if (refusedOpen !== undefined) throw refusedOpen
      signal.addEventListener('abort', cancel, { once: true })
      try {
        while (!signal.aborted) {
          const frame = readable(await post({ op: 'stream-next', id }, endpoint, signal), endpoint)
          signal.throwIfAborted()
          const failed = failure(frame, endpoint)
          if (failed !== undefined) throw failed
          if (frame.end === true) return
          if (frame.pending === true) continue
          if (Array.isArray(frame.values)) {
            for (const value of frame.values) {
              signal.throwIfAborted()
              yield value
            }
            continue
          }
          yield frame.value
        }
      } finally {
        signal.removeEventListener('abort', cancel)
        if (!signal.aborted) cancel()
      }
    },
  })

  const page = globalThis as Record<string, unknown>
  page.__DSH_LIVESHARE_VIEWER__ = { basePath: options.basePath, shareId: options.shareId, sessionId: options.sessionId }
  page.__DSH_TRANSPORT__ = { fetch: fetchCall, openStream }
}

/**
 * Build the classic inline script the Relay places first in the served viewer document.
 * @param options - Page target and read budget.
 * @returns Script text: {@link installViewerCarrier}'s own source applied to `options`.
 */
export function viewerCarrierScript(options: ViewerCarrierOptions): string {
  // `<` is escaped so no option value can close the surrounding script element.
  const argument = JSON.stringify(options).replace(/</g, '\\u003c')
  return `(${installViewerCarrier.toString()})(${argument});`
}
