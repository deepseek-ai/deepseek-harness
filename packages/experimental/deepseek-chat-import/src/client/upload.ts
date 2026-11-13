/** Browser upload of one export archive to the Host import route. */
import { UPLOAD_ROUTE } from '../protocol.ts'
import type {
  DeepseekChatImportFailureReason, DeepseekChatImportLine, DeepseekChatImportResponse, DeepseekChatImportResult, DeepseekChatImportSkip,
} from '../types.ts'

/** Progress of one upload: bytes still sending, the Host reading the archive, then Sessions written. */
export type UploadProgress =
  | { readonly phase: 'uploading'; readonly fraction: number }
  | { readonly phase: 'reading' }
  | { readonly phase: 'importing'; readonly done: number; readonly total: number }

/** The Host outcome, or a transport failure before an outcome line arrived. */
export type UploadAnswer = DeepseekChatImportResponse | { readonly ok: false; readonly transport: string }

/** Fetch-shaped carrier a shell installs when the Host runs in another execution context. */
type PageTransportFetch = (input: string | URL, init: RequestInit) => Promise<Response>

/** Page global carrying the shell transport, absent in the served web app. */
interface PageTransportGlobal {
  __DSH_TRANSPORT__?: { fetch?: PageTransportFetch }
}

/** One decoded answer step: streamed progress, the outcome, or a line that is not JSON. */
type AnswerStep =
  | { readonly kind: 'progress'; readonly done: number; readonly total: number }
  | { readonly kind: 'outcome'; readonly outcome: DeepseekChatImportResponse }
  | { readonly kind: 'invalid' }

/**
 * Read complete `application/x-ndjson` lines out of the answer as it arrives.
 * @returns a reader that takes the whole text received so far and returns the new steps.
 */
function createAnswerReader(): (text: string) => AnswerStep[] {
  let parsed = 0
  return (text: string): AnswerStep[] => {
    const steps: AnswerStep[] = []
    // A proxy may deliver the answer in one piece; complete lines are read as they arrive either way.
    for (let end = text.indexOf('\n', parsed); end >= 0; end = text.indexOf('\n', parsed)) {
      const line = parseLine(text.slice(parsed, end))
      parsed = end + 1
      if (line === undefined) steps.push({ kind: 'invalid' })
      else if (line.type === 'progress') steps.push({ kind: 'progress', done: line.done, total: line.total })
      else steps.push({ kind: 'outcome', outcome: line.outcome })
    }
    return steps
  }
}

/** Accumulates one answer that arrives in pieces, and reports its single outcome. */
interface AnswerCollector {
  /**
   * Fold the whole answer text received so far into the outcome and progress.
   * The first invalid line settles the answer; later lines and an outcome
   * cannot replace it.
   * @param text - everything received from the answer so far.
   * @returns true once an invalid line settled the answer.
   */
  take(text: string): boolean
  /**
   * The Host outcome, or why the answer never carried one.
   * @returns the decoded outcome, or the failure that replaced it.
   */
  finish(): UploadAnswer
}

/** Failure reported when an answer line is not a valid protocol value. */
const INVALID_ANSWER = 'the server answered with invalid JSON'

/**
 * Create a collector over one answer stream.
 * @param onProgress - reports each imported-Session count the Host sends.
 * @returns the collector for that answer.
 */
function createAnswerCollector(onProgress: (progress: UploadProgress) => void): AnswerCollector {
  const read = createAnswerReader()
  // Held in an object so the failure flag survives the closures below without
  // the compiler folding it to its initial value.
  const state: { outcome?: DeepseekChatImportResponse; invalid: boolean } = { invalid: false }
  return {
    take(text: string): boolean {
      for (const step of read(text)) {
        if (step.kind === 'invalid') {
          state.invalid = true
          return true
        }
        if (step.kind === 'progress') onProgress({ phase: 'importing', done: step.done, total: step.total })
        else state.outcome = step.outcome
      }
      return false
    },
    finish(): UploadAnswer {
      if (state.invalid) return { ok: false, transport: INVALID_ANSWER }
      if (state.outcome !== undefined) return state.outcome
      return { ok: false, transport: 'the server ended the answer without a result' }
    },
  }
}

/**
 * Send one archive and follow the streamed answer to its outcome line.
 * A page whose Host runs in another execution context supplies the pre-boot
 * `__DSH_TRANSPORT__.fetch` carrier, which carries the body and the streamed
 * answer over its own channel; that carrier reports no byte progress. Served
 * pages send the archive with XMLHttpRequest, so the browser streams it from
 * disk and reports upload progress.
 * @param file - archive chosen in the browser.
 * @param workspaceId - Workspace receiving the Sessions.
 * @param onProgress - upload progress, the reading phase, then Sessions written.
 * @param signal - aborts the request; Sessions already written stay.
 * @returns the decoded Host outcome or the transport failure.
 */
export function uploadArchive(
  file: Blob,
  workspaceId: string,
  onProgress: (progress: UploadProgress) => void,
  signal: AbortSignal,
): Promise<UploadAnswer> {
  const url = new URL(`${UPLOAD_ROUTE}?${new URLSearchParams({ workspaceId }).toString()}`, document.baseURI)
  const carrier = (globalThis as PageTransportGlobal).__DSH_TRANSPORT__?.fetch
  return carrier === undefined ? sendWithXhr(file, url, onProgress, signal) : sendWithCarrier(carrier, file, url, onProgress, signal)
}

/**
 * Send the archive through the page-owned Fetch carrier and read the answer stream.
 * @param carrier - shell transport for a Host in another execution context.
 * @param file - archive chosen in the browser.
 * @param url - absolute upload route.
 * @param onProgress - reading phase, then Sessions written.
 * @param signal - aborts the request.
 * @returns the decoded Host outcome or the transport failure.
 */
async function sendWithCarrier(
  carrier: PageTransportFetch,
  file: Blob,
  url: URL,
  onProgress: (progress: UploadProgress) => void,
  signal: AbortSignal,
): Promise<UploadAnswer> {
  onProgress({ phase: 'reading' })
  let response: Response
  try {
    response = await carrier(url.href, { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream' }, signal })
  } catch (error) {
    if (signal.aborted) return { ok: false, transport: 'the upload was cancelled' }
    return { ok: false, transport: error instanceof Error ? error.message : String(error) }
  }
  if (response.status !== 200) return { ok: false, transport: `HTTP ${response.status}: ${await response.text()}` }
  const answer = createAnswerCollector(onProgress)
  try {
    const body = response.body
    if (body === null) {
      answer.take(await response.text())
    } else {
      const reader = body.pipeThrough(new TextDecoderStream()).getReader()
      let text = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        text += value
        if (answer.take(text)) {
          // The first invalid line settles the answer; the rest of the stream
          // cannot change it, and cancelling keeps a stalled body from waiting.
          void reader.cancel()
          return answer.finish()
        }
      }
    }
  } catch (error) {
    if (signal.aborted) return { ok: false, transport: 'the upload was cancelled' }
    return { ok: false, transport: error instanceof Error ? error.message : String(error) }
  }
  return answer.finish()
}

/**
 * Send the archive with XMLHttpRequest so the browser reports upload progress.
 * @param file - archive chosen in the browser; the browser streams it from disk.
 * @param url - absolute upload route.
 * @param onProgress - upload progress, the reading phase, then Sessions written.
 * @param signal - aborts the request.
 * @returns the decoded Host outcome or the transport failure.
 */
function sendWithXhr(
  file: Blob,
  url: URL,
  onProgress: (progress: UploadProgress) => void,
  signal: AbortSignal,
): Promise<UploadAnswer> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    const answer = createAnswerCollector(onProgress)
    let settled = false
    const settle = (result: UploadAnswer): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const take = (): void => {
      if (settled) return
      if (answer.take(xhr.responseText)) {
        settle({ ok: false, transport: INVALID_ANSWER })
        // Stop reading the rest of the answer; the settled result cannot change.
        xhr.abort()
      }
    }
    xhr.open('POST', url.href)
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress({ phase: 'uploading', fraction: event.loaded / event.total })
    }
    xhr.upload.onload = () => { onProgress({ phase: 'reading' }) }
    // Progress lines arrive before the answer completes; only a 200 body is NDJSON.
    xhr.onprogress = () => { if (xhr.status === 200) take() }
    xhr.onload = () => {
      if (settled) return
      if (xhr.status !== 200) {
        settle({ ok: false, transport: `HTTP ${xhr.status}: ${xhr.responseText}` })
        return
      }
      take()
      // take may already have settled an invalid answer; settle ignores repeats.
      settle(answer.finish())
    }
    xhr.onerror = () => { settle({ ok: false, transport: 'the upload connection failed' }) }
    xhr.onabort = () => { settle({ ok: false, transport: 'the upload was cancelled' }) }
    signal.addEventListener('abort', () => { xhr.abort() }, { once: true })
    xhr.send(file)
  })
}

/** Failure categories the Host may report; a decoded line claiming another one is invalid. */
const FAILURE_REASONS: ReadonlySet<string> = new Set<DeepseekChatImportFailureReason>([
  'too-large', 'unreadable-archive', 'missing-manifest', 'missing-index', 'unsupported-version', 'no-conversations', 'workspace-not-found', 'busy',
])

/** A decoded JSON object; arrays and primitives are not line values. */
type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isReason(value: unknown): value is DeepseekChatImportFailureReason {
  return typeof value === 'string' && FAILURE_REASONS.has(value)
}

function isSkip(value: unknown): value is DeepseekChatImportSkip {
  return isObject(value)
    && typeof value.conversationId === 'string'
    && (value.title === null || typeof value.title === 'string')
    && typeof value.reason === 'string'
}

function isResult(value: unknown): value is DeepseekChatImportResult {
  return isObject(value)
    && typeof value.workspaceId === 'string'
    && typeof value.workspacePath === 'string'
    && Array.isArray(value.sessionIds)
    && value.sessionIds.every(id => typeof id === 'string')
    && typeof value.conversationCount === 'number'
    && typeof value.omittedByLimit === 'number'
    && Array.isArray(value.skipped)
    && value.skipped.every(isSkip)
}

/**
 * Validate one decoded outcome.
 * @param value - whatever the answer line carried under `outcome`.
 * @returns the outcome, or undefined when the value is not a response.
 */
function responseOf(value: unknown): DeepseekChatImportResponse | undefined {
  if (!isObject(value)) return undefined
  if (value.ok === true) return isResult(value.value) ? { ok: true, value: value.value } : undefined
  if (value.ok === false) {
    const error = value.error
    if (!isObject(error) || !isReason(error.reason) || typeof error.message !== 'string') return undefined
    return { ok: false, error: { reason: error.reason, message: error.message } }
  }
  return undefined
}

/**
 * Validate one decoded answer line. A line that is not an object, not a known
 * `type`, or whose fields do not match that type is undefined, so an invalid
 * line fails the answer instead of throwing inside a transport callback.
 * @param value - decoded JSON value.
 * @returns the line, or undefined when the value is not one.
 */
function lineOf(value: unknown): DeepseekChatImportLine | undefined {
  if (!isObject(value)) return undefined
  if (value.type === 'progress') {
    return typeof value.done === 'number' && typeof value.total === 'number'
      ? { type: 'progress', done: value.done, total: value.total }
      : undefined
  }
  if (value.type === 'outcome') {
    const outcome = responseOf(value.outcome)
    return outcome === undefined ? undefined : { type: 'outcome', outcome }
  }
  return undefined
}

/** Decode one answer line; undefined marks a line that is not JSON or not a valid line value. */
function parseLine(text: string): DeepseekChatImportLine | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (_invalidJson) {
    // The caller reports the answer as invalid when no outcome line arrives.
    return undefined
  }
  return lineOf(value)
}
