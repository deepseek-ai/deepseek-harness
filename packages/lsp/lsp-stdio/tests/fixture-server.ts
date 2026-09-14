/**
 * A scriptable fake LSP server over stdio for lsp-stdio tests. It speaks the real
 * `Content-Length`-framed base protocol so it exercises the client's framing, initialize handshake,
 * transient open/close, request mapping, and teardown — without a real language server.
 *
 * Behavior is driven by env vars so one file backs many scenarios:
 * - LSP_FAKE_ENCODING: advertised positionEncoding (default utf-16; "utf-8" forces a mismatch).
 * - LSP_FAKE_SYNC: textDocumentSync value as JSON (default 1/Full).
 * - LSP_FAKE_CAPS: JSON of extra capability flags merged into the defaults.
 * - LSP_FAKE_DEF / LSP_FAKE_REFS / LSP_FAKE_IMPL / LSP_FAKE_HOVER: JSON result per request.
 * - LSP_FAKE_HANG: "1" makes textDocument/* requests never respond (for abort/timeout tests).
 * - LSP_FAKE_CRASH_ON_OPEN: "1" exits the process when a didOpen arrives (crash test).
 * - LSP_FAKE_EXIT_AFTER_REPLY: "1" exits the process right after answering a textDocument/* request,
 *   simulating a server that dies while idle so the pool holds a dead instance (eviction test).
 * - LSP_FAKE_OPEN_MARKER: appends each didOpen document text as one JSON line to this path.
 * - LSP_FAKE_INITIALIZED_MARKER: records initialized receipt after any requested stdin pause.
 * - LSP_FAKE_PAUSE_STDIN_AFTER_INITIALIZED: "1" stops consuming stdin after initialized.
 * - LSP_FAKE_EXIT_DELAY_MS / LSP_FAKE_EXIT_MARKER: delay protocol exit and record exit/termination.
 * - LSP_FAKE_NO_SHUTDOWN: "1" ignores the shutdown request (forces kill escalation).
 * - LSP_FAKE_ON_OPEN: server→client request to emit when a didOpen arrives, one of
 *   "configuration" | "applyEdit" | "notification" | "unknown"; the reply is logged to stderr.
 * - LSP_FAKE_ERROR: "1" answers textDocument/* requests with a JSON-RPC error response.
 * - LSP_FAKE_GARBAGE: "1" emits an unframed garbage byte before the initialize reply.
 *
 * Run: node fixture-server.ts (Node's erasable TypeScript syntax support).
 */

import { appendFileSync } from 'node:fs'

const enc = process.env.LSP_FAKE_ENCODING ?? 'utf-16'
const sync: unknown = process.env.LSP_FAKE_SYNC !== undefined ? JSON.parse(process.env.LSP_FAKE_SYNC) : 1
const extraCaps: unknown = process.env.LSP_FAKE_CAPS !== undefined ? JSON.parse(process.env.LSP_FAKE_CAPS) : {}
const hang = process.env.LSP_FAKE_HANG === '1'
const crashOnOpen = process.env.LSP_FAKE_CRASH_ON_OPEN === '1'
const exitAfterReply = process.env.LSP_FAKE_EXIT_AFTER_REPLY === '1'
const openMarker = process.env.LSP_FAKE_OPEN_MARKER
const initializedMarker = process.env.LSP_FAKE_INITIALIZED_MARKER
const pauseStdinAfterInitialized = process.env.LSP_FAKE_PAUSE_STDIN_AFTER_INITIALIZED === '1'
const exitDelayMs = Number(process.env.LSP_FAKE_EXIT_DELAY_MS ?? 0)
const exitMarker = process.env.LSP_FAKE_EXIT_MARKER
const noShutdown = process.env.LSP_FAKE_NO_SHUTDOWN === '1'
const onOpen = process.env.LSP_FAKE_ON_OPEN
const errorReply = process.env.LSP_FAKE_ERROR === '1'
const garbage = process.env.LSP_FAKE_GARBAGE === '1'

let serverRequestId = 10_000
const pendingServerRequests = new Map<number, string>()

process.on('SIGTERM', () => {
  markExit('TERM')
  process.exit(0)
})

function resultFor(method: string): unknown {
  switch (method) {
    case 'textDocument/definition': return envJson('LSP_FAKE_DEF', null)
    case 'textDocument/references': return envJson('LSP_FAKE_REFS', null)
    case 'textDocument/implementation': return envJson('LSP_FAKE_IMPL', null)
    case 'textDocument/hover': {
      // LSP_FAKE_ECHO_ENV names a variable whose VALUE becomes the hover
      // contents — a test can assert exactly what env reached this process.
      const echoName = process.env.LSP_FAKE_ECHO_ENV
      if (echoName !== undefined) return { contents: process.env[echoName] ?? `<${echoName} unset>` }
      return envJson('LSP_FAKE_HOVER', null)
    }
    default: return null
  }
}

function envJson(name: string, fallback: unknown): unknown {
  const raw = process.env[name]
  return raw === undefined ? fallback : JSON.parse(raw)
}

let buffer = Buffer.alloc(0)
process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const sep = buffer.indexOf('\r\n\r\n')
    if (sep < 0) break
    const header = buffer.toString('ascii', 0, sep)
    const match = /content-length:\s*(\d+)/i.exec(header)
    if (!match) { buffer = buffer.subarray(sep + 4); continue }
    const length = Number(match[1])
    const start = sep + 4
    if (buffer.length < start + length) break
    const body = buffer.toString('utf8', start, start + length)
    buffer = buffer.subarray(start + length)
    handle(JSON.parse(body) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown })
  }
})

function handle(message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown }): void {
  const { id, method } = message
  // A frame with an id but no method is the client's REPLY to a server→client request; log it.
  if (method === undefined && id !== undefined && pendingServerRequests.has(id)) {
    const kind = pendingServerRequests.get(id)
    pendingServerRequests.delete(id)
    process.stderr.write(`REPLY ${kind} ${JSON.stringify({ result: message.result, error: message.error })}\n`)
    return
  }
  if (method === 'initialize') {
    if (garbage) process.stdout.write('this is not a framed message\r\n')
    send({
      id,
      result: {
        capabilities: {
          positionEncoding: enc,
          textDocumentSync: sync,
          definitionProvider: true,
          referencesProvider: true,
          implementationProvider: true,
          hoverProvider: true,
          ...(extraCaps as Record<string, unknown>),
        },
      },
    })
    return
  }
  if (method === 'shutdown') {
    if (noShutdown) return
    send({ id, result: null })
    return
  }
  if (method === 'exit') {
    markExit('EXIT')
    if (exitDelayMs > 0) {
      setTimeout(() => {
        markExit('CLEAN')
        process.exit(0)
      }, exitDelayMs)
      return
    }
    markExit('CLEAN')
    process.exit(0)
  }
  if (method === 'textDocument/didOpen') {
    if (crashOnOpen) process.exit(1)
    if (openMarker !== undefined) {
      const params = message.params as { textDocument?: { text?: unknown } } | undefined
      appendFileSync(openMarker, `${JSON.stringify(params?.textDocument?.text)}\n`)
    }
    if (onOpen !== undefined) emitServerRequest(onOpen)
    return
  }
  if (method === 'initialized') {
    if (pauseStdinAfterInitialized) process.stdin.pause()
    if (initializedMarker !== undefined) appendFileSync(initializedMarker, 'INITIALIZED\n')
    return
  }
  if (method === 'textDocument/didClose') return
  if (method?.startsWith('textDocument/')) {
    if (hang) return
    if (errorReply) {
      send({ id, error: { code: -32000, message: 'server refused the request' } })
    } else {
      send({ id, result: resultFor(method) })
    }
    // Simulate an idle death: answer this request, then exit before the next one arrives so the
    // pool is left holding a dead instance.
    if (exitAfterReply) setTimeout(() => process.exit(0), 20)
    return
  }
  // Unknown request with an id: answer null so the client never stalls.
  if (id !== undefined) send({ id, result: null })
}

/** Append one teardown event when the fixture is configured to expose process ordering. */
function markExit(event: string): void {
  if (exitMarker !== undefined) appendFileSync(exitMarker, `${event}\n`)
}

/** Emit a server→client request and log the client's reply to stderr for the test to assert. */
function emitServerRequest(kind: string): void {
  if (kind === 'notification') {
    send({ method: 'window/logMessage', params: { type: 3, message: 'hello' } })
    return
  }
  const id = serverRequestId++
  const method = kind === 'configuration'
    ? 'workspace/configuration'
    : kind === 'applyEdit'
      ? 'workspace/applyEdit'
      : kind === 'lifecycle'
        ? 'client/registerCapability'
        : 'window/showMessageRequest'
  const params = kind === 'configuration' ? { items: [{ section: 'a' }, { section: 'b' }] } : {}
  pendingServerRequests.set(id, method)
  send({ id, method, params })
}

function send(message: Record<string, unknown>): void {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8')
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]))
}

process.stdin.resume()
if (pauseStdinAfterInitialized) {
  setInterval(() => {}, 1000)
}
